// AI 任务的结构化输出契约。模型输出先经结构化输出约束，再由程序做二次校验（ID、时长、数量）。
import { z } from "zod";

export const SCHEMA_VERSION = 1;

/** analyze_entry = parse_entry + prepare_review 合并调用 */
export const AnalyzeOutput = z.object({
  title: z.string().describe("不超过 12 个字的活动标题"),
  intent: z.string().describe("用户这段时间原本想做什么；看不出来就写空字符串"),
  summary: z.string().describe("一两句话整理用户的描述，不添加用户没说过的事实"),
  goal_id: z.string().nullable().describe("最相关的目标 ID，必须来自给定目标列表；无关则为 null"),
  allocations: z
    .array(
      z.object({
        category_id: z.string().describe("必须来自给定分类列表"),
        minutes: z.number().describe("估计分钟数"),
        note: z.string().nullable().describe("这部分具体是什么，可为 null"),
      }),
    )
    .describe("候选时间分配；总和不得超过时段长度；说不清的部分不要分配，留给未分配"),
  questions: z
    .array(
      z.object({
        question: z.string(),
        options: z.array(z.string()).describe("3-5 个具体选项，最后包含“记不清”或“混合”之类的选项"),
        purpose: z.string().describe("这个问题要澄清什么，用于内部记录"),
      }),
    )
    .describe("0-3 个真正影响分配或评分的事实问题；信息已经足够时返回空数组"),
  uncertainties: z.array(z.string()).describe("仍不确定的点"),
});
export type AnalyzeOutput = z.infer<typeof AnalyzeOutput>;

export const ScoreOutput = z.object({
  execution_quality: z.number().describe("0-100，是否认真投入；是否得到与活动相符的推进、锻炼或恢复"),
  goal_contribution: z.number().describe("0-100，与当前主要目标、短期、长期目标的关系；休息娱乐类活动按是否为之后留出精力判断，不按产出"),
  arrangement_quality: z.number().describe("0-100，是否符合计划、是否明显超时、是否挤占其他必要活动"),
  reason: z.string().describe("两三句话的评分理由，具体指出依据"),
  uncertainties: z.array(z.string()).describe("评分时仍不确定的点"),
  suggestion: z.string().describe("一个具体、可执行的小建议；没有必要就写空字符串"),
});
export type ScoreOutput = z.infer<typeof ScoreOutput>;
