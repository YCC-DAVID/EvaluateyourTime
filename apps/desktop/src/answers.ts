// 问题的多选答案：多个选项用“ ＋ ”连起来存成一个字符串（选项文字里可能有“、”和“/”，所以不用它们分隔）。
// “记不清”这类选项是单选：选它会清掉其他选项，选其他选项也会清掉它。

export const ANSWER_SEP = " ＋ ";

// 中英文都认（界面设成英文时 AI 给的是英文选项）
export const isExclusive = (option: string) => /记不清|不确定|都不是|not sure|can'?t (remember|recall)|don'?t (remember|know)|none of (these|the above)|unsure/i.test(option);

/** 当前答案里选中了哪些选项（不是选项组合的，例如自己写的，返回 null） */
export function selectedOptions(answer: string | null | undefined, options: string[]): string[] | null {
  if (!answer) return [];
  const parts = answer.split(ANSWER_SEP);
  return parts.every((p) => options.includes(p)) ? parts : null;
}

/** 点选一个选项后的新答案 */
export function toggleOption(answer: string | null | undefined, option: string, options: string[]): string {
  const cur = selectedOptions(answer, options) ?? [];
  if (cur.includes(option)) return cur.filter((x) => x !== option).join(ANSWER_SEP);
  if (isExclusive(option)) return option;
  // 按选项原来的顺序排，去掉单选项
  const next = [...cur.filter((x) => !isExclusive(x)), option];
  return options.filter((o) => next.includes(o)).join(ANSWER_SEP);
}
