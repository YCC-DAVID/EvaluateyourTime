import { useState } from "react";
import type { Question } from "../api.ts";

// 评分后的反馈：
//  - 每个“不确定”项可以直接补充说明（作为事实，重新评分时 AI 优先采用）
//  - 自我反馈：自己怎么看这段时间
//  - 希望以后改进的地方：之后的建议会参考
// 可以只保存，也可以保存后让 AI 按补充信息重新评分。

export interface FeedbackPayload {
  clarifications: { uncertainty: string; answer: string }[];
  reflection: string;
  improvement: string;
}

export function FeedbackPanel(props: {
  uncertainties: string[];
  /** 已保存的澄清（来源为 uncertainty 的问题） */
  saved: Question[];
  reflection: string | null;
  improvement: string | null;
  busy: boolean;
  canRescore: boolean;
  onSave: (p: FeedbackPayload, rescore: boolean) => void;
}) {
  const savedMap = new Map(props.saved.map((q) => [q.question, q.answer ?? ""]));
  // 当前评分的不确定项 + 以前澄清过、这次已不再列出的项
  const items = [...new Set([...props.uncertainties, ...props.saved.filter((q) => q.answer).map((q) => q.question)])];

  const [clar, setClar] = useState<Record<string, string>>(() => Object.fromEntries(items.map((u) => [u, savedMap.get(u) ?? ""])));
  const [editing, setEditing] = useState<string | null>(null);
  const [reflection, setReflection] = useState(props.reflection ?? "");
  const [improvement, setImprovement] = useState(props.improvement ?? "");
  const [open, setOpen] = useState(!!(props.reflection || props.improvement));

  const dirty =
    items.some((u) => (clar[u] ?? "") !== (savedMap.get(u) ?? "")) ||
    reflection !== (props.reflection ?? "") ||
    improvement !== (props.improvement ?? "");
  const payload = (): FeedbackPayload => ({
    clarifications: items.map((u) => ({ uncertainty: u, answer: clar[u] ?? "" })),
    reflection,
    improvement,
  });

  return (
    <div className="feedback">
      {items.length > 0 && (
        <ul className="uncertain">
          {items.map((u) => {
            const answered = (clar[u] ?? "").trim();
            const stillListed = props.uncertainties.includes(u);
            return (
              <li key={u} className={answered ? "answered" : ""}>
                <div className="u-line">
                  <span>
                    {stillListed ? "不确定：" : "已澄清："}
                    {u}
                  </span>
                  <button className="link small" onClick={() => setEditing(editing === u ? null : u)}>
                    {answered ? "修改补充" : "补充说明"}
                  </button>
                </div>
                {answered && editing !== u && <div className="u-answer">你的补充：{answered}</div>}
                {editing === u && (
                  <input
                    type="text"
                    autoFocus
                    placeholder="直接写实际情况，例如：截止时间是今晚 23:59，只能熬夜完成"
                    value={clar[u] ?? ""}
                    onChange={(e) => setClar({ ...clar, [u]: e.target.value })}
                    onKeyDown={(e) => e.key === "Enter" && setEditing(null)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      <button className="link small" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} 自我反馈与以后改进{(props.reflection || props.improvement) && !open ? "（已填写）" : ""}
      </button>
      {open && (
        <div className="fb-fields">
          <label>
            <span className="small">自我反馈：你自己怎么看这段时间？</span>
            <textarea
              rows={2}
              placeholder="例如：其实补材料效率挺高，熬夜是因为白天被别的事打断了"
              value={reflection}
              onChange={(e) => setReflection(e.target.value)}
            />
          </label>
          <label>
            <span className="small">希望以后改进的地方</span>
            <textarea
              rows={2}
              placeholder="例如：有 DDL 的投稿提前一天定稿；晚上 12 点后不再开新任务"
              value={improvement}
              onChange={(e) => setImprovement(e.target.value)}
            />
          </label>
        </div>
      )}

      {dirty && (
        <div className="actions">
          <button disabled={props.busy} onClick={() => props.onSave(payload(), false)}>
            保存反馈
          </button>
          {props.canRescore && (
            <button className="primary" disabled={props.busy} onClick={() => props.onSave(payload(), true)}>
              保存并按补充重新评分
            </button>
          )}
        </div>
      )}
    </div>
  );
}
