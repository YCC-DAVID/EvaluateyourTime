// AI 服务设置：后端（API / Claude Code / Codex）、各自的模型、API 地址；API key 存在 macOS 钥匙串。
// 每次 AI 调用的用量记在本地，设置页显示今天 / 本周 / 本月的用量。
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { db, getSetting, newId, setSetting } from "./db.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAIConfig, setAIOverrides, setUsageRecorder, type AIProvider, type Effort, type UsageEvent } from "../../../modules/ai/client.ts";

const exec = promisify(execFile);
const KC_SERVICE = "time-evaluate-agent";
const KC_ACCOUNT = "anthropic-api-key";

db.exec(`
CREATE TABLE IF NOT EXISTS ai_usage (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, provider TEXT NOT NULL, model TEXT, ok INTEGER NOT NULL,
  error TEXT, ms INTEGER, input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER, cost_usd REAL);
CREATE INDEX IF NOT EXISTS idx_ai_usage_at ON ai_usage(at);
`);

// ---------- 钥匙串 ----------

let keyCache: string | null | undefined;

function readKey(): string | null {
  if (keyCache !== undefined) return keyCache;
  if (process.platform !== "darwin") return (keyCache = null);
  try {
    keyCache = execFileSync("security", ["find-generic-password", "-s", KC_SERVICE, "-a", KC_ACCOUNT, "-w"], { encoding: "utf8" }).trim() || null;
  } catch {
    keyCache = null;
  }
  return keyCache;
}

export function saveKey(key: string) {
  execFileSync("security", ["add-generic-password", "-U", "-s", KC_SERVICE, "-a", KC_ACCOUNT, "-l", "时间记录 · Claude API key", "-w", key]);
  keyCache = key;
}

export function deleteKey() {
  try {
    execFileSync("security", ["delete-generic-password", "-s", KC_SERVICE, "-a", KC_ACCOUNT]);
  } catch {
    /* 本来就没有 */
  }
  keyCache = null;
}

// ---------- 设置 ----------

export interface AISettings {
  provider: AIProvider | "";
  apiModel: string;
  claudeModel: string;
  codexModel: string;
  baseURL: string;
  /** 对话的思考强度；空 = 默认（低，回得快） */
  chatEffort: Effort | "";
}

export function aiSettings(): AISettings {
  return {
    provider: getSetting<AIProvider | "">("ai_provider", ""),
    apiModel: getSetting("ai_api_model", ""),
    claudeModel: getSetting("ai_claude_model", ""),
    codexModel: getSetting("ai_codex_model", ""),
    baseURL: getSetting("ai_base_url", ""),
    chatEffort: getSetting<Effort | "">("ai_chat_effort", ""),
  };
}

export function saveAISettings(b: Partial<AISettings>) {
  if (b.provider !== undefined) setSetting("ai_provider", ["api", "claude-cli", "codex-cli", ""].includes(b.provider) ? b.provider : "");
  for (const [k, key] of [
    ["apiModel", "ai_api_model"],
    ["claudeModel", "ai_claude_model"],
    ["codexModel", "ai_codex_model"],
    ["baseURL", "ai_base_url"],
  ] as const)
    if (typeof b[k] === "string") setSetting(key, String(b[k]).trim().slice(0, 200));
  if (b.chatEffort !== undefined) setSetting("ai_chat_effort", (EFFORTS as string[]).includes(b.chatEffort) ? b.chatEffort : "");
}

/** 本机有没有装 Claude Code / Codex（结果缓存一分钟） */
let cliCache: { at: number; claude: string | null; codex: string | null } | null = null;
export async function cliVersions() {
  if (cliCache && Date.now() - cliCache.at < 60_000) return cliCache;
  const v = async (bin: string) => {
    try {
      const { stdout } = await exec(bin, ["--version"], { timeout: 5000 });
      return stdout.trim().split("\n")[0];
    } catch {
      return null;
    }
  };
  const [claude, codex] = await Promise.all([v(process.env.CLAUDE_CLI_PATH || "claude"), v(process.env.CODEX_CLI_PATH || "codex")]);
  cliCache = { at: Date.now(), claude, codex };
  return cliCache;
}

// ---------- 用量 ----------

let lastRateLimit: { at: string; values: Record<string, string> } | null = null;
let lastLimitHit: { at: string; provider: string; error: string } | null = getSetting("ai_last_limit_hit", null);

function record(u: UsageEvent) {
  const at = new Date().toISOString();
  db.prepare(
    `INSERT INTO ai_usage (id,at,provider,model,ok,error,ms,input_tokens,output_tokens,cached_tokens,cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(newId("use"), at, u.provider, u.model, u.ok ? 1 : 0, u.error ?? null, u.ms, u.inputTokens ?? null, u.outputTokens ?? null, u.cachedTokens ?? null, u.costUsd ?? null);
  if (u.rateLimit && Object.keys(u.rateLimit).length) lastRateLimit = { at, values: u.rateLimit };
  if (!u.ok && u.error && /限|limit|quota|usage|频繁|429/i.test(u.error)) {
    lastLimitHit = { at, provider: u.provider, error: u.error };
    setSetting("ai_last_limit_hit", lastLimitHit);
  }
}

export function usageSummary() {
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(dayStart.getTime() - ((dayStart.getDay() + 6) % 7) * 86400_000);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const sum = (from: Date) =>
    db
      .prepare(
        `SELECT provider, COUNT(*) AS calls, SUM(ok=0) AS failed, COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output,
         COALESCE(SUM(cached_tokens),0) AS cached, SUM(cost_usd) AS cost FROM ai_usage WHERE at >= ? GROUP BY provider`,
      )
      .all(from.toISOString());
  return {
    today: sum(dayStart),
    week: sum(weekStart),
    month: sum(monthStart),
    rateLimit: lastRateLimit,
    lastLimitHit,
  };
}

/** 服务启动时调用：让 AI 层用设置页的选择和钥匙串里的 key，并记录用量 */
export function initAISettings() {
  setAIOverrides(() => {
    const s = aiSettings();
    return {
      provider: s.provider || undefined,
      apiModel: s.apiModel || undefined,
      claudeModel: s.claudeModel || undefined,
      codexModel: s.codexModel || undefined,
      baseURL: s.baseURL || undefined,
      apiKey: readKey() ?? undefined,
      language: getSetting<"zh" | "en">("ui_language", "zh"),
    };
  });
  setUsageRecorder(record);
}

export const keyConfigured = () => !!readKey();

// ---------- 模型目录（对话框里的模型 / 强度选择） ----------

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max", "ultra"];
const CLAUDE_EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
export interface CatalogModel {
  id: string; // 空 = 跟随 CLI 自己的默认
  label: string;
  note?: string;
  efforts: Effort[];
}
/** Codex 自己缓存的模型列表（~/.codex/models_cache.json），只取对用户可见的 */
function codexModels(): CatalogModel[] {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".codex", "models_cache.json"), "utf8"));
    const list: Record<string, unknown>[] = Array.isArray(j) ? j : (j.models ?? []);
    return list
      .filter((m) => m.visibility === undefined || m.visibility === "list")
      .map((m) => ({
        id: String(m.slug ?? m.id),
        label: String(m.display_name ?? m.slug),
        efforts: ((m.supported_reasoning_levels as { effort: string }[] | undefined) ?? [])
          .map((e) => e.effort as Effort)
          .filter((e) => EFFORTS.includes(e)),
      }))
      .filter((m) => m.id && m.efforts.length);
  } catch {
    return [];
  }
}
function codexDefaultModel(): string | null {
  try {
    const m = /^\s*model\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(os.homedir(), ".codex", "config.toml"), "utf8"));
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}
export function aiCatalog(): Record<AIProvider, CatalogModel[]> {
  const codex = codexModels();
  const codexDef = codexDefaultModel();
  return {
    "claude-cli": [
      { id: "", label: "默认", note: "跟随 Claude Code", efforts: CLAUDE_EFFORTS },
      { id: "opus", label: "Opus", note: "最强", efforts: CLAUDE_EFFORTS },
      { id: "sonnet", label: "Sonnet", note: "均衡", efforts: CLAUDE_EFFORTS },
      { id: "haiku", label: "Haiku", note: "最快、最省额度", efforts: CLAUDE_EFFORTS },
      { id: "claude-fable-5-2", label: "Fable 5.2", note: "最强但最耗额度", efforts: CLAUDE_EFFORTS },
    ],
    "codex-cli": [
      { id: "", label: "默认", note: codexDef ? `跟随 Codex（${codex.find((m) => m.id === codexDef)?.label ?? codexDef}）` : "跟随 Codex", efforts: codex.find((m) => m.id === codexDef)?.efforts ?? ["low", "medium", "high"] },
      ...codex,
    ],
    api: [
      { id: "claude-opus-5-5", label: "Opus 5.5", note: "$4 / $20 每百万 token", efforts: CLAUDE_EFFORTS },
      { id: "claude-sonnet-5-5", label: "Sonnet 5.5", note: "$2 / $10", efforts: CLAUDE_EFFORTS },
      { id: "claude-haiku-5-5", label: "Haiku 5.5", note: "$0.1 / $0.5，最便宜", efforts: CLAUDE_EFFORTS },
      { id: "claude-fable-5-2", label: "Fable 5.2", note: "$8 / $40，最强", efforts: CLAUDE_EFFORTS },
    ],
  };
}
/** 对话实际用的强度：当前模型不支持所选强度时，降到它支持的最高一档 */
export function chatEffort(): Effort {
  const want = aiSettings().chatEffort || "low";
  const cfg = loadAIConfig();
  const id = cfg.provider === "api" ? cfg.apiModel : cfg.provider === "claude-cli" ? (cfg.claudeModel ?? "") : (cfg.codexModel ?? "");
  const m = aiCatalog()[cfg.provider].find((x) => x.id === id);
  const ok = m?.efforts ?? CLAUDE_EFFORTS;
  if (ok.includes(want)) return want;
  return [...ok].reverse().find((e) => EFFORTS.indexOf(e) < EFFORTS.indexOf(want)) ?? ok[0] ?? "low";
}
