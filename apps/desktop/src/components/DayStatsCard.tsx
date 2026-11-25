import type { CategoryKind, DayStats } from "../../../../modules/scoring/index.ts";
import { fmtMinutes, type Goal, type Meta } from "../api.ts";

const KIND_LABEL: Record<CategoryKind, string> = {
  work: "工作学习",
  sport: "运动",
  rest: "休息",
  fun: "娱乐社交",
  life: "生活事务",
  waste: "无意消耗",
  unknown: "不确定",
};

export function DayStatsCard({ stats, meta, primaryGoal }: { stats: DayStats; meta: Meta; primaryGoal: Goal | null }) {
  const pct = Math.round(stats.budgetCompletion * 100);
  const colorOf = (k: CategoryKind) => meta.categories.find((c) => c.kind === k)?.color ?? "#999";
  const distTotal = Object.values(stats.minutesByKind).reduce((a, b) => a + b, 0);
  return (
    <div className="card">
      <div className="stats-grid">
        <div className="stat">
          <div className="stat-label">有效脑力工作</div>
          <div className="stat-value">{fmtMinutes(stats.effectiveWorkMinutes)}</div>
          <div className="bar">
            <div className="bar-fill" style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
          <div className="stat-sub">
            预算 {fmtMinutes(stats.workBudgetMinutes)} · 完成 {pct}%{pct > 100 ? "（预算不是每天都要超的指标）" : ""}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">重点目标投入</div>
          <div className="stat-value">{stats.primaryGoalShare == null ? "无数据" : `${Math.round(stats.primaryGoalShare * 100)}%`}</div>
          <div className="stat-sub">{primaryGoal ? `主要目标：${primaryGoal.title}` : "尚未设置主要目标"}</div>
        </div>
        <div className="stat">
          <div className="stat-label">记录覆盖率</div>
          <div className="stat-value">{stats.coverage == null ? "—" : `${Math.round(stats.coverage * 100)}%`}</div>
          <div className="stat-sub">
            已记录 {fmtMinutes(stats.recordedMinutes)} / 已过 {fmtMinutes(stats.elapsedMinutes)}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">平均评价</div>
          <div className="stat-value">{stats.avgScore ?? "—"}</div>
          <div className="stat-sub">仅含已确认评分，按时长加权</div>
        </div>
      </div>
      {distTotal > 0 && (
        <>
          <div className="dist">
            {(Object.keys(stats.minutesByKind) as CategoryKind[])
              .filter((k) => stats.minutesByKind[k] > 0)
              .map((k) => (
                <div
                  key={k}
                  className="dist-seg"
                  style={{ flex: stats.minutesByKind[k], background: colorOf(k) }}
                  title={`${KIND_LABEL[k]} ${fmtMinutes(stats.minutesByKind[k])}`}
                />
              ))}
          </div>
          <div className="dist-legend">
            {(Object.keys(stats.minutesByKind) as CategoryKind[])
              .filter((k) => stats.minutesByKind[k] > 0)
              .map((k) => (
                <span key={k}>
                  <i style={{ background: colorOf(k) }} />
                  {KIND_LABEL[k]} {fmtMinutes(stats.minutesByKind[k])}
                </span>
              ))}
          </div>
        </>
      )}
      {stats.prorated && <p className="hint">含跨天记录，已按时长比例分摊到当天（估计）。</p>}
    </div>
  );
}
