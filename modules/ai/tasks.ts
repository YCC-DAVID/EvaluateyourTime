// AI 任务：analyze_entry（整理 + 最多 3 个问题）与 score_entry（评分与理由）。
import { runStructured, type AIConfig } from "./client.ts";
import { analyzePrompt, scorePrompt, type PromptCategory, type PromptEntryBrief, type PromptGoal } from "./prompts.ts";
import { AnalyzeOutput, ScoreOutput } from "./schemas.ts";

export interface EntryContext {
  localRange: string;
  durationMinutes: number;
  text: string;
  categories: PromptCategory[];
  goals: PromptGoal[];
  earlier: PromptEntryBrief[];
  workSoFarMinutes: number;
  workBudgetMinutes: number;
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
    goal: PromptGoal | null;
  },
  cfg?: AIConfig,
) {
  return runStructured(ScoreOutput, scorePrompt(ctx), "medium", cfg);
}
