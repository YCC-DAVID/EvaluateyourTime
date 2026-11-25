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
  goal_progress: z
    .object({
      progress: z.number().nullable().describe("这段之后关联目标的整体完成度 0-100；没有关联目标或看不出推进时为 null"),
      reason: z.string().describe("一句话说明依据；progress 为 null 时写空字符串"),
    })
    .describe("关联目标的进度估计"),
});
export type ScoreOutput = z.infer<typeof ScoreOutput>;

/** split_goal：把一个目标拆成有先后顺序的子步骤 */
export const SplitOutput = z.object({
  steps: z
    .array(
      z.object({
        title: z.string().describe("不超过 16 个字，写成可检查的交付物或里程碑，例如“完成模块 A 消融并出表”"),
        description: z.string().describe("一句话说明完成标准"),
        weight: z.number().describe("占父目标的比例（%），按预计工作量分配"),
        ddl: z.string().nullable().describe("建议截止日期 YYYY-MM-DD；不晚于父目标 DDL，按先后顺序递增；没有父 DDL 时可为 null"),
      }),
    )
    .describe("3-7 个步骤，按执行顺序排列"),
  note: z.string().describe("一句话说明拆分思路或需要用户注意的地方；没有就写空字符串"),
});
export type SplitOutput = z.infer<typeof SplitOutput>;

/** 对话：一段回复 + 若干待用户确认的操作 */
export const CHAT_ACTION_TYPES = [
  "create_entry",
  "update_entry",
  "delete_entry",
  "score_entry",
  "create_goal",
  "update_goal",
  "update_goal_progress",
  "split_goal",
] as const;

export const ChatAction = z.object({
  type: z.enum(CHAT_ACTION_TYPES),
  summary: z.string().describe("一句话说明这个操作，显示在确认卡片上"),
  entry_id: z.string().nullable().describe("update/delete/score 记录时填已有记录 ID"),
  goal_id: z.string().nullable().describe("修改目标、更新进度、拆分时填已有目标 ID；新建记录要关联目标时也填"),
  start: z.string().nullable().describe("当地时间 YYYY-MM-DD HH:mm"),
  end: z.string().nullable().describe("当地时间 YYYY-MM-DD HH:mm"),
  text: z.string().nullable().describe("记录的原始描述，尽量用用户自己的话"),
  allocations: z
    .array(z.object({ category_id: z.string(), minutes: z.number(), note: z.string().nullable() }))
    .describe("时间分配；不涉及时为空数组；说不清的部分不要分配"),
  title: z.string().nullable(),
  level: z.enum(["long", "short", "task"]).nullable(),
  ddl: z.string().nullable().describe("YYYY-MM-DD"),
  description: z.string().nullable(),
  parent_id: z.string().nullable(),
  weight: z.number().nullable().describe("子目标占父目标的比例 %"),
  progress: z.number().nullable().describe("目标的新进度 0-100"),
  reason: z.string().nullable().describe("更新进度时：这次推进了什么"),
  steps: z
    .array(z.object({ title: z.string(), description: z.string(), weight: z.number(), ddl: z.string().nullable() }))
    .describe("split_goal 的步骤；其他操作为空数组"),
});
export type ChatAction = z.infer<typeof ChatAction>;

export const ChatOutput = z.object({
  reply: z.string().describe("给用户的回复：简短、口语化；需要澄清时最多问 1-2 个具体问题"),
  actions: z.array(ChatAction).describe("建议执行的操作；只是闲聊或还需要澄清时为空数组"),
  quick_replies: z
    .array(z.string())
    .describe("你在问问题时给 2-4 个用户可以直接点的简短回答（每个不超过 14 个字，最后可以是“记不清”）；没提问时为空数组"),
});
export type ChatOutput = z.infer<typeof ChatOutput>;

/** guide_entry：记录保存后、评分前，问 0-3 个关于这段时间质量的事实问题 */
export const GuideOutput = z.object({
  need_questions: z.boolean().describe("是否需要先问；原话已经说清推进和专注、或不需要追问的活动时为 false"),
  reason: z.string().describe("一句话：为什么问或为什么不问"),
  questions: z
    .array(
      z.object({
        question: z.string().describe("一个具体的事实问题，不问分数"),
        options: z.array(z.string()).describe("3-5 个贴合这段活动的选项，最后一个是“记不清”"),
        purpose: z.string().describe("allocation | progress | focus | goal | recovery"),
      }),
    )
    .describe("0-3 个问题；need_questions 为 false 时为空数组"),
});
export type GuideOutput = z.infer<typeof GuideOutput>;

/** allocate_entry：根据描述和引导问题的回答，估出各分类分钟数（估计值，用户确认后才生效） */
export const AllocateOutput = z.object({
  allocations: z
    .array(z.object({ category_id: z.string(), minutes: z.number(), note: z.string().nullable() }))
    .describe("各分类分钟数；回答“记不清”的部分不要分配"),
  note: z.string().describe("一句话说明怎么换算的；没有就写空字符串"),
});
export type AllocateOutput = z.infer<typeof AllocateOutput>;

/** draft_from_device：根据电脑使用记录起草一条记录（描述、分配、需要确认的问题） */
export const DraftOutput = z.object({
  title: z.string().describe("不超过 12 个字的活动标题"),
  text: z.string().describe("一两句话的描述草稿，用第一人称、平实的语气，只写电脑数据能支持的内容"),
  goal_id: z.string().nullable().describe("能从窗口标题/网站明确对应的目标 ID；不确定为 null"),
  allocations: z
    .array(z.object({ category_id: z.string(), minutes: z.number(), note: z.string().nullable() }))
    .describe("能确定的部分：按电脑上的分钟数分配；说不准的部分不要放在这里"),
  questions: z
    .array(
      z.object({
        question: z.string().describe("针对一块说不准的时间，例如“YouTube 8 分钟算哪种？”"),
        minutes: z.number().describe("这个问题对应的分钟数"),
        options: z
          .array(z.object({ label: z.string(), category_id: z.string().nullable() }))
          .describe("3-4 个选项，每个对应一个分类；最后一个是“记不清”，category_id 为 null"),
      }),
    )
    .describe("0-3 个问题，只问说不准归哪类的时间块"),
});
export type DraftOutput = z.infer<typeof DraftOutput>;
