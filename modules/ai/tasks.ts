// AI 任务：analyze_entry（整理 + 最多 3 个问题）与 score_entry（评分与理由）。
import { runStructured, type AIConfig } from "./client.ts";
import { allocatePrompt, analyzePrompt, chatPrompt, draftPrompt, guidePrompt, scorePrompt, splitPrompt, type PromptCategory, type PromptEntryBrief, type PromptGoal } from "./prompts.ts";
import { AllocateOutput, AnalyzeOutput, ChatOutput, DraftOutput, GuideOutput, ScoreOutput, SplitOutput } from "./schemas.ts";

export interface EntryContext {
  localRange: string;
  durationMinutes: number;
  text: string;
  categories: PromptCategory[];
  goals: PromptGoal[];
  earlier: PromptEntryBrief[];
  workSoFarMinutes: number;
  workBudgetMinutes: number;
  /** 电脑使用参照（一行文字）；没有数据或用户关闭时为 null */
  device?: string | null;
  /** 用户身份（一行文字） */
  profile?: string | null;
}

export function analyzeEntry(ctx: EntryContext, cfg?: AIConfig) {
  return runStructured(AnalyzeOutput, analyzePrompt(ctx), "low", cfg);
}

export function scoreEntry(
  ctx: EntryContext & {
    title: string;
    intent: string;
    allocations: { name: string; kind: string; minutes: number; state: string; note: string | null }[];
    unallocatedMinutes: number;
    answers: { question: string; answer: string }[];
    clarifications: { question: string; answer: string }[];
    reflection: string;
    improvement: string;
    goal: PromptGoal | null;
  },
  cfg?: AIConfig,
) {
  return runStructured(ScoreOutput, scorePrompt(ctx), "medium", cfg);
}

export function splitGoal(p: Parameters<typeof splitPrompt>[0], cfg?: AIConfig) {
  return runStructured(SplitOutput, splitPrompt(p), "medium", cfg);
}

export function chatTurn(p: Parameters<typeof chatPrompt>[0], cfg?: AIConfig) {
  // 应用事件也走同一个对话流程，只是消息被标成 <app_event>
  return runStructured(ChatOutput, chatPrompt(p), "low", cfg);
}

export function guideEntry(p: Parameters<typeof guidePrompt>[0], cfg?: AIConfig) {
  return runStructured(GuideOutput, guidePrompt(p), "low", cfg);
}

export function allocateEntry(p: Parameters<typeof allocatePrompt>[0], cfg?: AIConfig) {
  return runStructured(AllocateOutput, allocatePrompt(p), "low", cfg);
}

export function draftFromDevice(p: Parameters<typeof draftPrompt>[0], cfg?: AIConfig) {
  return runStructured(DraftOutput, draftPrompt(p), "low", cfg);
}
