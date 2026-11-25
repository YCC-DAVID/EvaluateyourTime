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

/**
 * 从回答里找出对应的目标：多选答案先拆成一个个选项，再和进行中的目标名称比对。
 * 选中了好几个目标时，取最具体的一级（任务 > 短期 > 长期），同级取先选的。
 */
export function goalFromAnswers<G extends { id: string; title: string; status: string; level: string }>(answers: (string | null | undefined)[], goals: G[]): G | null {
  const rank: Record<string, number> = { task: 0, short: 1, long: 2 };
  const picked: G[] = [];
  for (const a of answers)
    for (const part of (a ?? "").split(ANSWER_SEP)) {
      const g = goals.find((x) => x.status === "active" && x.title === part.trim());
      if (g && !picked.includes(g)) picked.push(g);
    }
  return picked.sort((x, y) => (rank[x.level] ?? 3) - (rank[y.level] ?? 3))[0] ?? null;
}
