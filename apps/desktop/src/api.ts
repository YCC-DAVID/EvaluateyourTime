import type { Category, CategoryKind, RuleSet } from "../../../modules/scoring/index.ts";
import type { Profile } from "../../../modules/profile.ts";

export interface Goal {
  id: string;
  level: "long" | "short" | "task";
  parent_id: string | null;
  title: string;
  description: string | null;
  start_date: string | null;
  ddl: string | null;
  progress: number;
  progress_note: string | null;
  priority: number;
  status: "active" | "paused" | "done" | "dropped";
  is_primary: boolean;
  /** 占父目标的比例（%）；子目标进度变化会按这个比例带动父目标 */
  weight?: number | null;
  /** 自动统计：关联到该目标的已确认脑力工作分钟数 */
  invested_minutes?: number;
  progress_events?: ProgressEvent[];
}

export interface ProgressEvent {
  entry_id: string | null;
  from_progress: number;
  to_progress: number;
  source: "ai" | "user" | "manual" | "rollup";
  reason: string | null;
  created_at: string;
}

export interface Meta {
  device_id: string;
  categories: Category[];
  goals: Goal[];
  work_budget_minutes: number;
  profile: Profile;
  rules: RuleSet;
  ai: { provider: "api" | "claude-cli" | "codex-cli"; model: string; base_url: string; key_configured: boolean };
  asr: { server: boolean };
}

export interface AllocationRow {
  id?: string;
  category_id: string;
  minutes: number;
  state: "estimated" | "confirmed";
  note: string | null;
}

export interface Question {
  id: string;
  ord: number;
  question: string;
  options: string[];
  answer: string | null;
  source: string;
  /** 按电脑记录起草的问题：这块时间多少分钟、每个选项对应哪个分类（null = 记不清，不分配） */
  meta?: { kind: "device"; minutes: number; cats: (string | null)[] } | null;
}

export interface ScoreRevision {
  id: string;
  execution_quality: number;
  goal_contribution: number;
  arrangement_quality: number;
  overall: number;
  dominant_kind: CategoryKind;
  reason: string | null;
  uncertainties: string[];
  suggestion: string | null;
  goal_progress: number | null;
  goal_progress_reason: string | null;
  source: "ai" | "user" | "manual";
  change_kind: string | null;
  change_note: string | null;
  rule_version: string;
  model: string | null;
  created_at: string;
}

export type EntryStatus = "draft" | "pending_ai" | "needs_confirmation" | "confirmed" | "analysis_failed";

export interface Entry {
  id: string;
  start_utc: string;
  end_utc: string;
  tz: string;
  raw_text: string;
  title: string | null;
  intent: string | null;
  goal_id: string | null;
  status: EntryStatus;
  analysis_error: string | null;
  reflection: string | null;
  improvement: string | null;
  version: number;
  allocations: AllocationRow[];
  questions: Question[];
  ai_score: ScoreRevision | null;
  score: ScoreRevision | null;
  score_history: ScoreRevision[];
}

export type ChatActionType =
  | "create_entry"
  | "update_entry"
  | "delete_entry"
  | "score_entry"
  | "create_goal"
  | "update_goal"
  | "update_goal_progress"
  | "split_goal";

export interface ChatAction {
  type: ChatActionType;
  summary: string;
  entry_id: string | null;
  goal_id: string | null;
  start: string | null;
  end: string | null;
  start_iso?: string;
  end_iso?: string;
  text: string | null;
  allocations: { category_id: string; minutes: number; note: string | null }[];
  title: string | null;
  level: "long" | "short" | "task" | null;
  ddl: string | null;
  description: string | null;
  parent_id: string | null;
  weight: number | null;
  progress: number | null;
  reason: string | null;
  steps: { title: string; description: string; weight: number; ddl: string | null }[];
  status: "pending" | "applied" | "dismissed" | "failed" | "invalid";
  error?: string;
  result?: { entry_id?: string; goal_id?: string; text?: string; confirmed?: boolean; scored?: boolean };
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "event";
  content: string;
  actions: ChatAction[];
  quick_replies: string[];
  model: string | null;
  created_at: string;
}

export interface DeviceSummary {
  source: "activitywatch" | "builtin" | "none";
  rangeMinutes: number;
  coveredMinutes: number;
  afkMinutes: number;
  apps: { app: string; minutes: number; details: { label: string; minutes: number }[] }[];
}

export interface DeviceStatus {
  platform: string;
  supported: boolean;
  enabled: boolean;
  activitywatch: boolean;
  lastSample: { at: number; app: string; detail: string | null; afk: boolean } | null;
  lastError: string | null;
  detailError: string | null;
  settings: {
    enabled: boolean;
    detail: boolean;
    mode: "all" | "only";
    monitoredApps: string[];
    rules: Record<string, string>;
    excludedApps: string[];
    excludedSites: string[];
    sendToAI: boolean;
    afkSeconds: number;
  };
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: any) {
    super(message);
  }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api${url}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(j.error || `请求失败（${r.status}）`, r.status, j);
  return j as T;
}

export const api = {
  meta: () => req<Meta>("GET", "/meta"),
  entries: (from: string, to: string) => req<Entry[]>("GET", `/entries?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  getEntry: (id: string) => req<Entry>("GET", `/entries/${id}`),
  lastEnd: () => req<{ end: string | null }>("GET", "/entries/last-end"),
  createEntry: (b: { start: string; end: string; tz: string; text: string; goal_id?: string | null }) => req<Entry>("POST", "/entries", b),
  updateEntry: (id: string, b: Partial<{ start: string; end: string; text: string; title: string; goal_id: string | null }>) =>
    req<Entry>("PATCH", `/entries/${id}`, b),
  deleteEntry: (id: string) => req<{ ok: true }>("DELETE", `/entries/${id}`),
  analyze: (id: string) => req<{ entry: Entry; summary: string; uncertainties: string[] }>("POST", `/entries/${id}/analyze`),
  review: (id: string, b: { allocations: { category_id: string; minutes: number; note: string | null }[]; answers: { id: string; answer: string }[]; goal_id?: string | null }) =>
    req<Entry>("PUT", `/entries/${id}/review`, b),
  score: (id: string) => req<Entry>("POST", `/entries/${id}/score`),
  deviceDraft: (id: string) => req<Entry>("POST", `/entries/${id}/device-draft`),
  guide: (id: string) => req<{ skip: boolean; reason: string; questions: Question[] }>("POST", `/entries/${id}/guide`),
  allocateFromAnswers: (id: string, answers: { id: string; answer: string }[]) =>
    req<{ allocations: AllocationRow[]; note: string }>("POST", `/entries/${id}/allocate`, { answers }),
  feedback: (id: string, b: { clarifications: { uncertainty: string; answer: string }[]; reflection: string; improvement: string }) =>
    req<Entry>("PUT", `/entries/${id}/feedback`, b),
  confirm: (
    id: string,
    b: { dims?: { execution_quality: number; goal_contribution: number; arrangement_quality: number }; change_kind?: string; change_note?: string; goal_progress?: number | null; goal_progress_reason?: string },
  ) =>
    req<Entry>("POST", `/entries/${id}/confirm`, b),
  createGoal: (g: Partial<Goal>) => req<Goal>("POST", "/goals", g),
  updateGoal: (id: string, g: Partial<Goal>) => req<Goal>("PATCH", `/goals/${id}`, g),
  deleteGoal: (id: string) => req<{ ok: true }>("DELETE", `/goals/${id}`),
  rollupGoal: (id: string) => req<Goal>("POST", `/goals/${id}/rollup`),
  createChildren: (id: string, children: { title: string; description: string; weight: number; ddl: string | null }[]) =>
    req<{ created: number }>("POST", `/goals/${id}/children`, { children }),
  chatList: () => req<ChatMessage[]>("GET", "/chat"),
  deviceStatus: () => req<DeviceStatus>("GET", "/device/status"),
  deviceSummary: (start: string, end: string) =>
    req<DeviceSummary>("GET", `/device/summary?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`),
  deviceApps: () => req<{ apps: string[]; sites: string[]; installed: string[] }>("GET", "/device/apps"),
  saveDeviceSettings: (b: {
    enabled?: boolean;
    detail?: boolean;
    mode?: "all" | "only";
    monitored_apps?: string[];
    send_to_ai?: boolean;
    rules?: Record<string, string>;
    excluded_apps?: string[];
    excluded_sites?: string[];
  }) =>
    req<unknown>("PUT", "/device/settings", b),
  chatSend: (message: string, event = false) => req<ChatMessage>("POST", "/chat", { message, event }),
  chatAction: (id: string, idx: number, b: { status: "applied" | "dismissed" | "failed"; error?: string; result?: unknown }) =>
    req<ChatMessage>("PATCH", `/chat/${id}/actions/${idx}`, b),
  chatClear: () => req<{ ok: true }>("DELETE", "/chat"),
  saveSettings: (b: { work_budget_minutes: number }) => req<{ work_budget_minutes: number }>("PUT", "/settings", b),
  saveProfile: (p: Profile) => req<Profile>("PUT", "/profile", p),
  importData: (data: unknown) => req<{ ok: true; counts: Record<string, number> }>("POST", "/import", data),
  async asr(blob: Blob): Promise<string> {
    const r = await fetch("/api/asr", { method: "POST", headers: { "Content-Type": blob.type || "audio/webm" }, body: blob });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new ApiError(j.error || "转写失败", r.status, j);
    return j.text as string;
  },
};

// ---------- 时间工具 ----------

const pad = (n: number) => String(n).padStart(2, "0");

/** Date → <input type="datetime-local"> 的值（本地时间） */
export function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fromLocalInput(s: string): Date {
  return new Date(s); // 无时区后缀时按本地时间解析
}
export function todayStr(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function hm(iso: string | number | Date): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fmtMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const r = Math.round(m % 60);
  if (h === 0) return `${r} 分钟`;
  return r === 0 ? `${h} 小时` : `${h} 小时 ${r} 分`;
}
export function roundTo5(d: Date): Date {
  const x = new Date(d);
  x.setSeconds(0, 0);
  x.setMinutes(Math.floor(x.getMinutes() / 5) * 5);
  return x;
}
export const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** 记录 → 统计/热力图用的结构：只有已确认的记录才带分数 */
export function toDayEntry(e: Entry) {
  return {
    id: e.id,
    start: e.start_utc,
    end: e.end_utc,
    overall: e.status === "confirmed" ? (e.score?.overall ?? null) : null,
    confirmed: e.status === "confirmed",
    goal_id: e.goal_id,
    allocations: e.allocations,
    title: e.title ?? e.raw_text.slice(0, 20),
  };
}
