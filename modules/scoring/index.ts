// 评分与统计的参考实现：纯函数，不依赖数据库或网络。
// 时间、分配、整体分、热力图和指标都由这里的程序计算，AI 只负责语义理解与解释。

export type CategoryKind = "work" | "sport" | "rest" | "fun" | "life" | "waste" | "unknown";

export interface Category {
  id: string;
  name: string;
  kind: CategoryKind;
  color: string;
  parent_id?: string | null;
  builtin?: boolean;
}

export const BUILTIN_CATEGORIES: Category[] = [
  { id: "cat_work", name: "工作与学习", kind: "work", color: "#8e44ad", builtin: true },
  { id: "cat_sport", name: "运动与健康", kind: "sport", color: "#2b7a3d", builtin: true },
  { id: "cat_rest", name: "休息与睡眠", kind: "rest", color: "#4f7cff", builtin: true },
  { id: "cat_fun", name: "娱乐与社交", kind: "fun", color: "#e8a33d", builtin: true },
  { id: "cat_life", name: "生活与必要事务", kind: "life", color: "#4cc3d9", builtin: true },
  { id: "cat_waste", name: "无意消耗", kind: "waste", color: "#d9534f", builtin: true },
  { id: "cat_unknown", name: "未分配或不确定", kind: "unknown", color: "#9aa0a6", builtin: true },
];

export type AllocationState = "estimated" | "confirmed";

export interface Allocation {
  category_id: string;
  minutes: number;
  state: AllocationState;
  note?: string | null;
}

export interface ScoreDims {
  execution_quality: number;
  goal_contribution: number;
  arrangement_quality: number;
}

// ---------- 规则（版本化配置） ----------

export interface RuleSet {
  version: string;
  /** 按主导活动类型选择三个维度的权重，总和为 1 */
  weights: Record<CategoryKind, ScoreDims>;
  /** 热力图颜色阈值 */
  thresholds: { good: number; fair: number };
  /** 默认每日有效脑力工作预算（分钟） */
  default_work_budget_minutes: number;
}

export const RULES_V1: RuleSet = {
  version: "rules_v1",
  weights: {
    // 脑力工作：投入与目标推进同等重要
    work: { execution_quality: 0.4, goal_contribution: 0.4, arrangement_quality: 0.2 },
    // 运动、休息、娱乐、生活：不套用产出标准，目标贡献权重很低
    sport: { execution_quality: 0.5, goal_contribution: 0.1, arrangement_quality: 0.4 },
    rest: { execution_quality: 0.6, goal_contribution: 0.0, arrangement_quality: 0.4 },
    fun: { execution_quality: 0.5, goal_contribution: 0.0, arrangement_quality: 0.5 },
    life: { execution_quality: 0.4, goal_contribution: 0.1, arrangement_quality: 0.5 },
    waste: { execution_quality: 0.4, goal_contribution: 0.2, arrangement_quality: 0.4 },
    unknown: { execution_quality: 0.4, goal_contribution: 0.3, arrangement_quality: 0.3 },
  },
  thresholds: { good: 75, fair: 55 },
  default_work_budget_minutes: 360,
};

// ---------- 时间与分配 ----------

export function durationMinutes(startIso: string, endIso: string): number {
  const ms = Date.parse(endIso) - Date.parse(startIso);
  return Math.max(0, Math.round(ms / 60000));
}

export function minutesToPercent(minutes: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((minutes / total) * 1000) / 10;
}

export function percentToMinutes(percent: number, total: number): number {
  return Math.round((percent / 100) * total);
}

export interface AllocationCheck {
  ok: boolean;
  allocatedMinutes: number;
  remainingMinutes: number;
  errors: string[];
}

export function checkAllocations(
  allocations: Allocation[],
  totalMinutes: number,
  validCategoryIds?: Set<string>,
): AllocationCheck {
  const errors: string[] = [];
  let sum = 0;
  for (const a of allocations) {
    if (!Number.isFinite(a.minutes) || a.minutes < 0) errors.push(`时长无效：${a.minutes}`);
    else sum += a.minutes;
    if (validCategoryIds && !validCategoryIds.has(a.category_id)) errors.push(`未知分类：${a.category_id}`);
  }
  if (sum > totalMinutes) errors.push(`分配总和 ${sum} 分钟超过时段长度 ${totalMinutes} 分钟`);
  return { ok: errors.length === 0, allocatedMinutes: sum, remainingMinutes: Math.max(0, totalMinutes - sum), errors };
}

/**
 * 把 AI 给出的候选分配整理为合法分配：去掉无效分类和非法值，合并同类，
 * 超出时段长度时按比例缩小（不虚构多出来的时间）。结果一律标为估计。
 */
export function sanitizeAllocations(
  raw: { category_id: string; minutes: number; note?: string | null }[],
  totalMinutes: number,
  validCategoryIds: Set<string>,
): Allocation[] {
  const merged = new Map<string, Allocation>();
  for (const r of raw) {
    if (!validCategoryIds.has(r.category_id)) continue;
    const m = Number(r.minutes);
    if (!Number.isFinite(m) || m <= 0) continue;
    const prev = merged.get(r.category_id);
    if (prev) prev.minutes += m;
    else merged.set(r.category_id, { category_id: r.category_id, minutes: m, state: "estimated", note: r.note ?? null });
  }
  const list = [...merged.values()];
  const sum = list.reduce((s, a) => s + a.minutes, 0);
  if (sum > totalMinutes && sum > 0) {
    const k = totalMinutes / sum;
    for (const a of list) a.minutes = Math.floor(a.minutes * k);
  }
  for (const a of list) a.minutes = Math.round(a.minutes);
  return list.filter((a) => a.minutes > 0);
}

// ---------- 评分 ----------

export function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** 分配中时长最多的类型（未分配部分不参与）。 */
export function dominantKind(allocations: Allocation[], categories: Category[]): CategoryKind {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const totals = new Map<CategoryKind, number>();
  for (const a of allocations) {
    const kind = byId.get(a.category_id)?.kind ?? "unknown";
    totals.set(kind, (totals.get(kind) ?? 0) + a.minutes);
  }
  let best: CategoryKind = "unknown";
  let bestMin = -1;
  for (const [k, m] of totals) if (m > bestMin) { best = k; bestMin = m; }
  return best;
}

/** 整体分由程序按版本化权重计算，AI 不能绕开配置改权重。 */
export function computeOverall(dims: ScoreDims, kind: CategoryKind, rules: RuleSet = RULES_V1): number {
  const w = rules.weights[kind];
  return clampScore(
    dims.execution_quality * w.execution_quality +
      dims.goal_contribution * w.goal_contribution +
      dims.arrangement_quality * w.arrangement_quality,
  );
}

export type Grade = "good" | "fair" | "poor" | "none";

export function gradeOf(score: number | null | undefined, rules: RuleSet = RULES_V1): Grade {
  if (score == null) return "none";
  if (score >= rules.thresholds.good) return "good";
  if (score >= rules.thresholds.fair) return "fair";
  return "poor";
}

export const GRADE_LABEL: Record<Grade, string> = { good: "较好", fair: "一般", poor: "偏离", none: "未评" };

// ---------- 热力图与统计 ----------

export interface DayEntry {
  id: string;
  start: string; // UTC ISO
  end: string;
  overall: number | null; // 最终整体分；未评分为 null
  confirmed: boolean;
  goal_id: string | null;
  allocations: Allocation[];
  title?: string;
  /** 记录创建时间：时间重叠时，后建的记录优先（通常是用户在纠正前一条） */
  createdAt?: string;
}

export interface HeatCell {
  start: number; // epoch ms
  end: number;
  coveredMinutes: number;
  score: number | null; // 覆盖部分按时长加权的平均分；无评分为 null
  entryIds: string[];
  estimated: boolean; // 只有整段平均分，没有真实子段边界
  /** 这一格里各类活动的分钟数（按记录的分配比例估计）；传了分类才有 */
  kindMinutes: Partial<Record<CategoryKind, number>>;
  /** 占比最多的活动类型；没有记录为 null */
  kind: CategoryKind | null;
}

function overlapMs(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

type Seg = [number, number];
/** 从一段时间里扣掉已经被占用的部分，返回剩下的若干小段 */
function subtract(seg: Seg, taken: Seg[]): Seg[] {
  let parts: Seg[] = [seg];
  for (const [t0, t1] of taken)
    parts = parts.flatMap(([a, b]): Seg[] => {
      if (t1 <= a || t0 >= b) return [[a, b]];
      const out: Seg[] = [];
      if (t0 > a) out.push([a, t0]);
      if (t1 < b) out.push([t1, b]);
      return out;
    });
  return parts.filter(([a, b]) => b > a);
}

export interface ResolvedEntry {
  entry: DayEntry;
  /** 这条记录实际“拥有”的时间段（扣掉被更新的记录覆盖的部分） */
  segments: Seg[];
  totalMs: number;
  /** 被其他记录覆盖掉的分钟数 */
  overlappedMinutes: number;
  /** 扣掉被覆盖部分后的分配：先扣和覆盖它的记录同类的时间（睡眠盖睡眠），其余按比例扣 */
  allocations: Allocation[];
}

function deductCovered(e: DayEntry, coveredMs: number, coverers: { e: DayEntry; ms: number }[]): Allocation[] {
  if (coveredMs <= 0) return e.allocations;
  const total = (Date.parse(e.end) - Date.parse(e.start)) / 60000;
  let left = coveredMs / 60000;
  const mins = new Map<string, number>();
  for (const a of e.allocations) mins.set(a.category_id, (mins.get(a.category_id) ?? 0) + a.minutes);
  // 1. 同类先扣：覆盖它的记录在重叠时段里大致是什么类别
  for (const c of coverers) {
    const cTotal = (Date.parse(c.e.end) - Date.parse(c.e.start)) / 60000;
    if (cTotal <= 0) continue;
    for (const a of c.e.allocations) {
      const want = (a.minutes / cTotal) * (c.ms / 60000);
      const have = mins.get(a.category_id) ?? 0;
      const take = Math.min(want, have, left);
      if (take > 0) {
        mins.set(a.category_id, have - take);
        left -= take;
      }
    }
  }
  // 2. 剩下的：先扣“未分配”的时间，再按比例扣其余分配
  const allocated = [...mins.values()].reduce((x, y) => x + y, 0);
  const unalloc = Math.max(0, total - (coveredMs / 60000 - left) - allocated);
  left -= Math.min(left, unalloc);
  if (left > 0 && allocated > 0) {
    const k = Math.max(0, 1 - left / allocated);
    for (const [id, m] of mins) mins.set(id, m * k);
  }
  return e.allocations.map((a) => {
    const sameCat = e.allocations.filter((x) => x.category_id === a.category_id).reduce((x, y) => x + y.minutes, 0);
    return { ...a, minutes: sameCat > 0 ? (a.minutes / sameCat) * (mins.get(a.category_id) ?? 0) : 0 };
  });
}
/**
 * 处理时间重叠：同一时刻只算一条记录，墙钟时间不会因为重叠而变多。
 * 后建的记录优先（创建时间相同则开始得晚的优先）；被覆盖的那条只算没被覆盖的部分。
 */
export function resolveOverlaps(entries: DayEntry[]): ResolvedEntry[] {
  const order = [...entries].sort((a, b) => {
    const ca = a.createdAt ? Date.parse(a.createdAt) : 0;
    const cb = b.createdAt ? Date.parse(b.createdAt) : 0;
    return cb - ca || Date.parse(b.start) - Date.parse(a.start);
  });
  const taken: { seg: Seg; e: DayEntry }[] = [];
  const out = new Map<string, ResolvedEntry>();
  for (const e of order) {
    const s0 = Date.parse(e.start);
    const s1 = Date.parse(e.end);
    const segments = s1 > s0 ? subtract([s0, s1], taken.map((t) => t.seg)) : [];
    const own = segments.reduce((x, [a, b]) => x + b - a, 0);
    const covered = Math.max(0, s1 - s0) - own;
    // 谁盖住了它、各盖了多少
    const by = new Map<DayEntry, number>();
    for (const t of taken) {
      const ov = overlapMs(s0, s1, t.seg[0], t.seg[1]);
      if (ov > 0) by.set(t.e, (by.get(t.e) ?? 0) + ov);
    }
    out.set(e.id, {
      entry: e,
      segments,
      totalMs: Math.max(0, s1 - s0),
      overlappedMinutes: Math.round(covered / 60000),
      allocations: deductCovered(e, covered, [...by].map(([ce, ms]) => ({ e: ce, ms }))),
    });
    taken.push(...segments.map((seg) => ({ seg, e })));
  }
  return entries.map((e) => out.get(e.id)!);
}

/**
 * 一天的热力图。dayStartMs 是当地 0 点的 epoch 毫秒；dayEndMs 为次日 0 点
 * （夏令时当天不一定是 24 小时，因此由调用方传入）。
 * 当前记录只有整段分配，没有子段，所以每段只能画整段平均分，并标为估计。
 */
export function buildHeatmap(entries: DayEntry[], dayStartMs: number, dayEndMs: number, cellMinutes = 15, categories?: Category[]): HeatCell[] {
  const kindOf = new Map((categories ?? []).map((c) => [c.id, c.kind]));
  const cells: HeatCell[] = [];
  const step = cellMinutes * 60000;
  const resolved = resolveOverlaps(entries);
  for (let t = dayStartMs; t < dayEndMs; t += step) {
    const c0 = t;
    const c1 = Math.min(t + step, dayEndMs);
    let covered = 0;
    let scoredMs = 0;
    let weighted = 0;
    const ids: string[] = [];
    const kindMs: Partial<Record<CategoryKind, number>> = {};
    for (const { entry: e, segments, allocations } of resolved) {
      const ov = segments.reduce((x, [a, b]) => x + overlapMs(c0, c1, a, b), 0);
      if (ov <= 0) continue;
      covered += ov;
      ids.push(e.id);
      if (categories) {
        // 没有子段：按这条记录（扣掉被覆盖部分后）的分配比例摊到这一格
        const owned = segments.reduce((x, [a, b]) => x + b - a, 0) / 60000;
        let used = 0;
        for (const a of allocations) {
          const k = kindOf.get(a.category_id) ?? "unknown";
          const share = owned > 0 ? Math.min(1, a.minutes / owned) : 0;
          kindMs[k] = (kindMs[k] ?? 0) + ov * share;
          used += share;
        }
        if (used < 1) kindMs.unknown = (kindMs.unknown ?? 0) + ov * (1 - used);
      }
      if (e.overall != null) { scoredMs += ov; weighted += e.overall * ov; }
    }
    cells.push({
      start: c0,
      end: c1,
      coveredMinutes: Math.min(cellMinutes, Math.round(covered / 60000)),
      score: scoredMs > 0 ? Math.round(weighted / scoredMs) : null,
      entryIds: ids,
      estimated: ids.length > 0,
      kindMinutes: Object.fromEntries(Object.entries(kindMs).map(([k, v]) => [k, Math.round((v as number) / 60000)])),
      kind: ids.length ? ((Object.entries(kindMs).sort((a, b) => (b[1] as number) - (a[1] as number))[0]?.[0] as CategoryKind | undefined) ?? "unknown") : null,
    });
  }
  return cells;
}

export interface DayStats {
  recordedMinutes: number;
  elapsedMinutes: number;
  coverage: number | null; // 记录覆盖率
  effectiveWorkMinutes: number; // 用户确认的有效脑力工作
  workBudgetMinutes: number;
  budgetCompletion: number; // 可超过 1
  primaryGoalWorkMinutes: number;
  primaryGoalShare: number | null; // 没有工作或没有主要目标时为 null，而不是除以零
  avgScore: number | null;
  minutesByKind: Record<CategoryKind, number>;
  prorated: boolean; // 有跨天或被其他记录覆盖的记录被按比例分摊
}

export function computeDayStats(
  entries: DayEntry[],
  categories: Category[],
  dayStartMs: number,
  dayEndMs: number,
  nowMs: number,
  workBudgetMinutes: number,
  primaryGoalId: string | null,
): DayStats {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const minutesByKind: Record<CategoryKind, number> = { work: 0, sport: 0, rest: 0, fun: 0, life: 0, waste: 0, unknown: 0 };
  let recordedMs = 0;
  let work = 0;
  let primary = 0;
  let scoreW = 0;
  let scoreMs = 0;
  let prorated = false;
  for (const { entry: e, segments, allocations, overlappedMinutes } of resolveOverlaps(entries)) {
    // 只算这条记录“拥有”的时间（重叠部分归后建的记录）；分配已经扣掉了被覆盖的部分
    const owned = segments.reduce((x, [a, b]) => x + b - a, 0);
    const ov = segments.reduce((x, [a, b]) => x + overlapMs(dayStartMs, dayEndMs, a, b), 0);
    if (ov <= 0 || owned <= 0) continue;
    recordedMs += ov;
    const frac = ov / owned; // 跨天记录按时长比例分摊（属于估计）
    if (frac < 1 || overlappedMinutes > 0) prorated = true;
    for (const a of allocations) {
      const kind = byId.get(a.category_id)?.kind ?? "unknown";
      const m = a.minutes * frac;
      minutesByKind[kind] += m;
      // 有效工作：只计用户确认的分配
      if (kind === "work" && a.state === "confirmed") {
        work += m;
        if (primaryGoalId && e.goal_id === primaryGoalId) primary += m;
      }
    }
    if (e.overall != null) { scoreW += e.overall * ov; scoreMs += ov; }
  }
  const elapsedMs = Math.max(0, Math.min(nowMs, dayEndMs) - dayStartMs);
  for (const k of Object.keys(minutesByKind) as CategoryKind[]) minutesByKind[k] = Math.round(minutesByKind[k]);
  return {
    recordedMinutes: Math.round(recordedMs / 60000),
    elapsedMinutes: Math.round(elapsedMs / 60000),
    coverage: elapsedMs > 0 ? Math.min(1, recordedMs / elapsedMs) : null,
    effectiveWorkMinutes: Math.round(work),
    workBudgetMinutes,
    budgetCompletion: workBudgetMinutes > 0 ? work / workBudgetMinutes : 0,
    primaryGoalWorkMinutes: Math.round(primary),
    primaryGoalShare: work > 0 && primaryGoalId ? primary / work : null,
    avgScore: scoreMs > 0 ? Math.round(scoreW / scoreMs) : null,
    minutesByKind,
    prorated,
  };
}

// ---------- 记录时间窗口 ----------

/** 补录只允许最近 3 天：今天、昨天、前天（按当地日期）。 */
export const BACKFILL_DAYS = 3;
/** 允许结束时间比“现在”晚一点，容忍设备间时钟偏差。 */
export const FUTURE_TOLERANCE_MS = 5 * 60000;

/** 可补录的最早时刻：(BACKFILL_DAYS - 1) 天前的当地 0 点。 */
export function backfillWindowStart(nowMs: number, days = BACKFILL_DAYS): number {
  const d = new Date(nowMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (days - 1)).getTime();
}

/** 检查时间段是否在允许范围内；返回错误信息，合法时返回 null。 */
export function checkRecordWindow(startMs: number, endMs: number, nowMs: number): string | null {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return "时间格式无效";
  if (endMs <= startMs) return "结束时间必须晚于开始时间";
  if (endMs - startMs > 24 * 3600_000) return "单段记录不能超过 24 小时";
  if (endMs > nowMs + FUTURE_TOLERANCE_MS) return "不能记录未来的时间";
  if (startMs < backfillWindowStart(nowMs)) return `只能补录最近 ${BACKFILL_DAYS} 天（今天、昨天、前天）`;
  return null;
}

/** 当地日期 YYYY-MM-DD 对应的 [0 点, 次日 0 点) 的 epoch 毫秒（按运行环境时区）。 */
export function localDayRange(dateStr: string): [number, number] {
  const [y, m, d] = dateStr.split("-").map(Number);
  return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()];
}
