// AI 适配层：三种后端，统一返回经过 zod 校验的结构化结果。
//   api        —— 直接调用 Claude API（需要 ANTHROPIC_API_KEY）
//   claude-cli —— 启动本机已登录的 Claude Code（claude -p），用你的订阅
//   codex-cli  —— 启动本机已登录的 Codex（codex exec），用你的订阅
// 失败时抛出带原因的 AIError，由调用方记录，不影响原始记录。
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SYSTEM_PROMPT } from "./prompts.ts";

export type AIProvider = "api" | "claude-cli" | "codex-cli";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
/** Claude（API 和 Claude Code）最高到 max；ultra 只有部分 Codex 模型支持 */
const claudeEffort = (e: Effort) => (e === "ultra" ? "max" : e);

export interface AIConfig {
  provider: AIProvider;
  /** 展示用：当前后端实际会用的模型（CLI 未指定时为“CLI 默认”） */
  model: string;
  // api
  apiModel: string;
  baseURL: string;
  apiKey?: string;
  fallbacks: boolean;
  // cli
  claudeBin: string;
  claudeModel?: string;
  codexBin: string;
  codexModel?: string;
  cliTimeoutMs: number;
}

/** 设置页里的选择（优先于 .env）。由服务启动时注册，key 来自钥匙串。 */
export interface AIOverrides {
  provider?: AIProvider;
  apiModel?: string;
  baseURL?: string;
  apiKey?: string;
  claudeModel?: string;
  codexModel?: string;
  /** 界面语言：en 时让 AI 用英文写所有给用户看的文字 */
  language?: "zh" | "en";
}
let overrides: () => AIOverrides = () => ({});
export function setAIOverrides(fn: () => AIOverrides) {
  overrides = fn;
}
/** 系统提示：按界面语言追加输出语言要求 */
function systemPrompt(): string {
  return overrides().language === "en"
    ? `${SYSTEM_PROMPT}\n\n输出语言：用户把界面设成了英文。所有给用户看的文字（回复、问题、选项、快捷回复、理由、建议、不确定项、标题、摘要、进度说明等）一律用简洁自然的英文写；JSON 字段名、ID、分类 ID 保持原样。`
    : SYSTEM_PROMPT;
}

/** 每次调用的用量（记到本地，用于设置页的用量统计） */
export interface UsageEvent {
  provider: AIProvider;
  model: string;
  ok: boolean;
  error?: string;
  ms: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  /** API：按价目估算；Claude Code：CLI 报告的等价 API 费用；Codex：不提供 */
  costUsd?: number;
  /** API 响应头里的每分钟剩余额度 */
  rateLimit?: Record<string, string>;
}
let recorder: (u: UsageEvent) => void = () => {};
export function setUsageRecorder(fn: (u: UsageEvent) => void) {
  recorder = fn;
}

// 每百万 token 的美元价格（输入 / 输出 / 缓存读取），用于 API 用量估算
const PRICES: Record<string, [number, number, number]> = {
  "claude-fable-5-2": [8, 40, 0.2],
  "claude-opus-5-5": [4, 20, 0.2],
  "claude-sonnet-5-5": [2, 10, 0.1],
  "claude-haiku-5-5": [0.1, 0.5, 0.01],
};
function estimateCost(model: string, input = 0, output = 0, cached = 0): number | undefined {
  const p = PRICES[Object.keys(PRICES).find((k) => model.startsWith(k)) ?? ""];
  return p ? (input * p[0] + output * p[1] + cached * p[2]) / 1e6 : undefined;
}

export function loadAIConfig(): AIConfig {
  const env = process.env;
  const o = overrides();
  const apiKey = o.apiKey || env.ANTHROPIC_API_KEY || undefined;
  const raw = (o.provider || env.AI_PROVIDER || "").trim();
  // 未指定时：填了 API key 就用 API，否则用本机 Claude Code
  const provider: AIProvider = raw === "api" || raw === "claude-cli" || raw === "codex-cli" ? raw : apiKey ? "api" : "claude-cli";
  const apiModel = o.apiModel || env.AI_MODEL || "claude-opus-5-5";
  const claudeModel = o.claudeModel || env.CLAUDE_CLI_MODEL || undefined;
  const codexModel = o.codexModel || env.CODEX_MODEL || undefined;
  return {
    provider,
    model: provider === "api" ? apiModel : provider === "claude-cli" ? (claudeModel ?? "Claude Code 默认模型") : (codexModel ?? "Codex 默认模型"),
    apiModel,
    // 明确指定地址：不继承外部工具设置的 ANTHROPIC_BASE_URL
    baseURL: o.baseURL || env.AI_BASE_URL || "https://api.anthropic.com",
    apiKey,
    fallbacks: env.AI_FALLBACKS !== "off",
    claudeBin: env.CLAUDE_CLI_PATH || "claude",
    claudeModel,
    codexBin: env.CODEX_CLI_PATH || "codex",
    codexModel,
    cliTimeoutMs: Number(env.AI_CLI_TIMEOUT_MS) || 180_000,
  };
}

export class AIError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

export async function runStructured<S extends z.ZodType>(
  schema: S,
  userPrompt: string,
  effort: Effort,
  cfg: AIConfig = loadAIConfig(),
): Promise<{ output: z.infer<S>; model: string }> {
  const t0 = Date.now();
  try {
    const r =
      cfg.provider === "claude-cli"
        ? await runClaudeCli(schema, userPrompt, effort, cfg)
        : cfg.provider === "codex-cli"
          ? await runCodexCli(schema, userPrompt, effort, cfg)
          : await runApi(schema, userPrompt, effort, cfg);
    recorder({ provider: cfg.provider, model: r.model, ok: true, ms: Date.now() - t0, ...r.usage });
    return { output: r.output, model: r.model };
  } catch (e) {
    recorder({ provider: cfg.provider, model: cfg.model, ok: false, error: (e as Error).message.slice(0, 300), ms: Date.now() - t0 });
    throw e;
  }
}

/** 设置页“测试连接”：发一个很小的请求 */
export async function testAI(cfg: AIConfig = loadAIConfig()) {
  const t0 = Date.now();
  const { output, model } = await runStructured(z.object({ ok: z.boolean() }), "这是连接测试，只返回 ok=true。", "low", cfg);
  return { ok: output.ok, model, ms: Date.now() - t0 };
}

/** API 可用的模型列表 */
export async function listApiModels(cfg: AIConfig = loadAIConfig()): Promise<string[]> {
  if (!cfg.apiKey) return [];
  const out: string[] = [];
  for await (const m of getClient(cfg).models.list()) out.push(m.id);
  return out;
}

// ---------- Claude API ----------

let cached: { key: string; client: Anthropic } | null = null;
function getClient(cfg: AIConfig) {
  const key = `${cfg.baseURL}|${cfg.apiKey ?? ""}`;
  if (!cached || cached.key !== key) {
    cached = { key, client: new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, timeout: 120_000, maxRetries: 2 }) };
  }
  return cached.client;
}

async function runApi<S extends z.ZodType>(schema: S, userPrompt: string, effort: Effort, cfg: AIConfig) {
  if (!cfg.apiKey) throw new AIError("未配置 API key：在设置 › AI 服务里填写，或切换到本机 Claude Code / Codex", false);
  const client = getClient(cfg);
  let response;
  let headers: Headers | undefined;
  try {
    const r = await client.beta.messages
      .parse({
      model: cfg.apiModel,
      max_tokens: 16000,
      system: systemPrompt(),
      messages: [{ role: "user", content: userPrompt }],
      output_config: { effort: claudeEffort(effort), format: betaZodOutputFormat(schema) },
      // 服务端拒答时自动切换到默认备用模型
      ...(cfg.fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      })
      .withResponse();
    response = r.data;
    headers = r.response.headers;
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new AIError("API key 无效（在设置 › AI 服务里重新填写）", false);
    if (e instanceof Anthropic.PermissionDeniedError) throw new AIError(`没有权限调用该模型：${e.message}`, false);
    if (e instanceof Anthropic.NotFoundError) throw new AIError(`模型或接口不存在：${cfg.apiModel}`, false);
    if (e instanceof Anthropic.BadRequestError) throw new AIError(`请求被拒绝：${e.message}`, false);
    if (e instanceof Anthropic.RateLimitError) throw new AIError("请求太频繁，请稍后重试", true);
    if (e instanceof Anthropic.APIConnectionError) throw new AIError("无法连接 AI 服务（网络或地址问题）", true);
    if (e instanceof Anthropic.APIError) throw new AIError(`AI 服务错误 ${e.status ?? ""}：${e.message}`, true);
    throw new AIError(`AI 输出无法解析：${e instanceof Error ? e.message : String(e)}`, true);
  }
  if (response.stop_reason === "refusal") throw new AIError("模型拒绝了这次请求", false);
  if (response.stop_reason === "max_tokens") throw new AIError("输出被截断", true);
  if (!response.parsed_output) throw new AIError("AI 没有返回有效的结构化结果", true);
  const u = response.usage;
  const rateLimit: Record<string, string> = {};
  headers?.forEach((v, k) => {
    if (k.startsWith("anthropic-ratelimit-")) rateLimit[k.replace("anthropic-ratelimit-", "")] = v;
  });
  return {
    output: response.parsed_output as z.infer<S>,
    model: response.model,
    usage: {
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cachedTokens: u.cache_read_input_tokens ?? 0,
      costUsd: estimateCost(response.model, u.input_tokens, u.output_tokens, u.cache_read_input_tokens ?? 0),
      rateLimit,
    },
  };
}

// ---------- 本机 CLI 公共部分 ----------

function jsonSchemaOf(schema: z.ZodType) {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: "output" }) as Record<string, unknown>;
  return rest;
}

/** 子进程环境：去掉 API 凭据，确保 CLI 用自己的订阅登录，而不是 .env 里的 key */
function cliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runProcess(bin: string, args: string[], input: string, cwd: string, timeoutMs: number, name: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: cliEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new AIError(`${name} 超过 ${Math.round(timeoutMs / 1000)} 秒没有返回`, true));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        e.code === "ENOENT"
          ? new AIError(`找不到 ${name} 命令（${bin}）。确认已安装，或在 .env 中设置完整路径`, false)
          : new AIError(`无法启动 ${name}：${e.message}`, true),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {}); // 进程提前退出时忽略写入错误
    child.stdin.end(input);
  });
}

/** 每次调用使用一个新的空目录作为工作目录，用完删除 */
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "time-agent-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function validate<S extends z.ZodType>(schema: S, data: unknown, name: string): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new AIError(`${name} 返回的结构不符合要求：${r.error.issues[0]?.message ?? ""}`, true);
  return r.data;
}

const tail = (s: string, n = 300) => s.trim().split("\n").slice(-4).join(" ").slice(-n);

// ---------- Claude Code CLI ----------

async function runClaudeCli<S extends z.ZodType>(schema: S, userPrompt: string, effort: Effort, cfg: AIConfig) {
  const args = [
    "-p",
    "--output-format", "json",
    "--json-schema", JSON.stringify(jsonSchemaOf(schema)),
    "--system-prompt", systemPrompt(),
    "--tools", "", // 不给任何工具：只做文本理解，不能读写文件或执行命令
    "--strict-mcp-config", // 不加载任何 MCP 服务
    "--setting-sources", "", // 不加载用户/项目设置（含 hooks）
    "--disable-slash-commands",
    "--no-session-persistence",
    "--effort", claudeEffort(effort),
    ...(cfg.claudeModel ? ["--model", cfg.claudeModel] : []),
  ];
  const res = await withTempDir((dir) => runProcess(cfg.claudeBin, args, userPrompt, dir, cfg.cliTimeoutMs, "Claude Code"));
  let j: any;
  try {
    j = JSON.parse(res.stdout);
  } catch {
    const msg = tail(res.stderr || res.stdout);
    if (/log ?in|logged|auth|credential/i.test(msg)) throw new AIError("Claude Code 未登录：在终端运行 claude 并完成登录", false);
    throw new AIError(`Claude Code 运行失败（退出码 ${res.code}）：${msg || "无输出"}`, true);
  }
  if (j.is_error) {
    const msg = String(j.result ?? j.subtype ?? "未知错误");
    if (/log ?in|logged|auth|credential/i.test(msg)) throw new AIError("Claude Code 未登录：在终端运行 claude 并完成登录", false);
    if (/limit|quota|usage/i.test(msg)) throw new AIError(`订阅用量已达上限：${msg.slice(0, 200)}`, true);
    throw new AIError(`Claude Code 返回错误：${msg.slice(0, 300)}`, true);
  }
  let data = j.structured_output;
  if (data == null && typeof j.result === "string") {
    try {
      data = JSON.parse(j.result);
    } catch {
      throw new AIError("Claude Code 没有返回结构化结果", true);
    }
  }
  const model = Object.keys(j.modelUsage ?? {})[0] ?? cfg.claudeModel ?? "claude-code";
  return {
    output: validate(schema, data, "Claude Code"),
    model: `${model} (Claude Code)`,
    usage: {
      inputTokens: (j.usage?.input_tokens ?? 0) + (j.usage?.cache_creation_input_tokens ?? 0),
      outputTokens: j.usage?.output_tokens,
      cachedTokens: j.usage?.cache_read_input_tokens,
      costUsd: typeof j.total_cost_usd === "number" ? j.total_cost_usd : undefined,
    },
  };
}

// ---------- Codex CLI ----------

async function runCodexCli<S extends z.ZodType>(schema: S, userPrompt: string, effort: Effort, cfg: AIConfig) {
  return withTempDir(async (dir) => {
    const work = path.join(dir, "work");
    await mkdir(work);
    const schemaFile = path.join(dir, "schema.json");
    const outFile = path.join(dir, "last.json");
    await writeFile(schemaFile, JSON.stringify(jsonSchemaOf(schema)));
    const args = [
      "exec",
      "--output-schema", schemaFile,
      "--sandbox", "read-only", // 只读沙箱，且工作目录是空目录
      "-c", 'approval_policy="never"',
      "-c", `model_reasoning_effort="${effort}"`,
      "--skip-git-repo-check",
      "--ephemeral",
      "--color", "never",
      "--json", // 事件流里带 token 用量
      "-C", work,
      "-o", outFile,
      ...(cfg.codexModel ? ["-m", cfg.codexModel] : []),
      "-", // 提示词从标准输入读取
    ];
    // Codex 不能替换系统提示，把规则放在提示词开头
    const prompt = `${systemPrompt()}\n\n---\n\n${userPrompt}\n\n只输出符合给定 JSON Schema 的结果，不要运行任何命令。`;
    const res = await runProcess(cfg.codexBin, args, prompt, work, cfg.cliTimeoutMs, "Codex");
    let text = "";
    try {
      text = await readFile(outFile, "utf8");
    } catch {
      /* 没有结果文件，下面按错误处理 */
    }
    if (res.code !== 0 || !text.trim()) {
      const msg = tail(res.stderr || res.stdout);
      if (/log ?in|logged|auth|401/i.test(msg)) throw new AIError("Codex 未登录：在终端运行 codex login", false);
      if (/limit|quota|usage/i.test(msg)) throw new AIError(`订阅用量已达上限：${msg.slice(0, 200)}`, true);
      throw new AIError(`Codex 运行失败（退出码 ${res.code}）：${msg || "无输出"}`, true);
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new AIError("Codex 没有返回有效 JSON", true);
    }
    // 从事件流里找本轮的 token 用量
    let usage: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number } = {};
    for (const line of res.stdout.split("\n")) {
      try {
        const ev = JSON.parse(line);
        if (ev.type === "turn.completed" && ev.usage) usage = ev.usage;
      } catch {
        /* 不是 JSON 的行跳过 */
      }
    }
    return {
      output: validate(schema, data, "Codex"),
      model: `${cfg.codexModel ?? "default"} (Codex)`,
      usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, cachedTokens: usage.cached_input_tokens },
    };
  });
}
