// AI 适配层：调用 Claude，使用结构化输出；失败时抛出带原因的错误，由调用方记录，不影响原始记录。
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { SYSTEM_PROMPT } from "./prompts.ts";

export interface AIConfig {
  model: string;
  baseURL: string;
  apiKey?: string;
  fallbacks: boolean;
}

export function loadAIConfig(): AIConfig {
  return {
    model: process.env.AI_MODEL || "claude-opus-5-5",
    // 明确指定地址：不继承外部工具设置的 ANTHROPIC_BASE_URL
    baseURL: process.env.AI_BASE_URL || "https://api.anthropic.com",
    apiKey: process.env.ANTHROPIC_API_KEY || undefined,
    fallbacks: process.env.AI_FALLBACKS !== "off",
  };
}

export class AIError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

let cached: { key: string; client: Anthropic } | null = null;
function getClient(cfg: AIConfig) {
  const key = `${cfg.baseURL}|${cfg.apiKey ?? ""}`;
  if (!cached || cached.key !== key) {
    // 未提供 key 时由 SDK 依次查找 ANTHROPIC_AUTH_TOKEN、`ant auth login` 的凭据
    cached = { key, client: new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, timeout: 120_000, maxRetries: 2 }) };
  }
  return cached.client;
}

export async function runStructured<S extends z.ZodType>(
  schema: S,
  userPrompt: string,
  effort: "low" | "medium" | "high",
  cfg: AIConfig = loadAIConfig(),
): Promise<{ output: z.infer<S>; model: string }> {
  const client = getClient(cfg);
  let response;
  try {
    response = await client.beta.messages.parse({
      model: cfg.model,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
      output_config: { effort, format: betaZodOutputFormat(schema) },
      // 服务端拒答时自动切换到默认备用模型
      ...(cfg.fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new AIError("AI 凭据无效或未配置（检查 .env 中的 ANTHROPIC_API_KEY）", false);
    if (e instanceof Anthropic.PermissionDeniedError) throw new AIError(`没有权限调用该模型：${e.message}`, false);
    if (e instanceof Anthropic.NotFoundError) throw new AIError(`模型或接口不存在：${cfg.model}`, false);
    if (e instanceof Anthropic.BadRequestError) throw new AIError(`请求被拒绝：${e.message}`, false);
    if (e instanceof Anthropic.RateLimitError) throw new AIError("请求太频繁，请稍后重试", true);
    if (e instanceof Anthropic.APIConnectionError) throw new AIError("无法连接 AI 服务（网络或地址问题）", true);
    if (e instanceof Anthropic.APIError) throw new AIError(`AI 服务错误 ${e.status ?? ""}：${e.message}`, true);
    if (e instanceof Error && /credential|api key|apiKey|authToken/i.test(e.message))
      throw new AIError("未配置 AI 凭据：在 .env 中填写 ANTHROPIC_API_KEY", false);
    throw new AIError(`AI 输出无法解析：${e instanceof Error ? e.message : String(e)}`, true);
  }
  if (response.stop_reason === "refusal") throw new AIError("模型拒绝了这次请求", false);
  if (response.stop_reason === "max_tokens") throw new AIError("输出被截断", true);
  if (!response.parsed_output) throw new AIError("AI 没有返回有效的结构化结果", true);
  return { output: response.parsed_output, model: response.model };
}
