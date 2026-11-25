import type { Category, CategoryKind, RuleSet } from "../../../modules/scoring/index.ts";

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
}

export interface Meta {
  device_id: string;
  categories: Category[];
  goals: Goal[];
  work_budget_minutes: number;
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
  version: number;
  allocations: AllocationRow[];
  questions: Question[];
  ai_score: ScoreRevision | null;
  score: ScoreRevision | null;
  score_history: ScoreRevision[];
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
  createEntry: (b: { start: string; end: string; tz: string; text: string }) => req<Entry>("POST", "/entries", b),
  updateEntry: (id: string, b: Partial<{ start: string; end: string; text: string; title: string; goal_id: string | null }>) =>
    req<Entry>("PATCH", `/entries/${id}`, b),
  deleteEntry: (id: string) => req<{ ok: true }>("DELETE", `/entries/${id}`),
  analyze: (id: string) => req<{ entry: Entry; summary: string; uncertainties: string[] }>("POST", `/entries/${id}/analyze`),
  review: (id: string, b: { allocations: { category_id: string; minutes: number; note: string | null }[]; answers: { id: string; answer: string }[]; goal_id: string | null }) =>
    req<Entry>("PUT", `/entries/${id}/review`, b),
  score: (id: string) => req<Entry>("POST", `/entries/${id}/score`),
  confirm: (id: string, b: { dims?: { execution_quality: number; goal_contribution: number; arrangement_quality: number }; change_kind?: string; change_note?: string }) =>
    req<Entry>("POST", `/entries/${id}/confirm`, b),
  createGoal: (g: Partial<Goal>) => req<Goal>("POST", "/goals", g),
  updateGoal: (id: string, g: Partial<Goal>) => req<Goal>("PATCH", `/goals/${id}`, g),
  deleteGoal: (id: string) => req<{ ok: true }>("DELETE", `/goals/${id}`),
  saveSettings: (b: { work_budget_minutes: number }) => req<{ work_budget_minutes: number }>("PUT", "/settings", b),
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
