import { GRADE_LABEL, gradeOf } from "../../../../modules/scoring/index.ts";
import { fmtMinutes, hm, type Entry, type EntryStatus } from "../api.ts";

export const STATUS_LABEL: Record<EntryStatus, string> = {
  draft: "草稿",
  pending_ai: "分析中",
  needs_confirmation: "待确认",
  confirmed: "已确认",
  analysis_failed: "分析失败",
};

export function Timeline(props: {
  entries: Entry[];
  dayStart: number;
  dayEnd: number;
  selectedId: string | null;
  onPick: (id: string) => void;
  onFillGap: (start: Date, end: Date) => void;
}) {
  type Item = { kind: "entry"; e: Entry } | { kind: "gap"; s: number; t: number };
  const items: Item[] = [];
  let cursor = props.dayStart;
  const sorted = [...props.entries].sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc));
  for (const e of sorted) {
    const s = Date.parse(e.start_utc);
    if (s - cursor >= 15 * 60000) items.push({ kind: "gap", s: cursor, t: s });
    items.push({ kind: "entry", e });
    cursor = Math.max(cursor, Date.parse(e.end_utc));
  }
  if (props.dayEnd - cursor >= 15 * 60000) items.push({ kind: "gap", s: cursor, t: props.dayEnd });

  return (
    <div className="card">
      <div className="card-head">
        <h3>时间轴</h3>
      </div>
      {items.length === 0 && <p className="muted">这一天还没有记录。</p>}
      <ul className="timeline">
        {items.map((it, i) =>
          it.kind === "gap" ? (
            <li key={`g${i}`} className="tl-gap">
              <span className="tl-time">
                {hm(it.s)}–{hm(it.t)}
              </span>
              <span className="muted">未记录 {fmtMinutes(Math.round((it.t - it.s) / 60000))}</span>
              <button className="link" onClick={() => props.onFillGap(new Date(it.s), new Date(it.t))}>
                补录
              </button>
            </li>
          ) : (
            <li
              key={it.e.id}
              className={`tl-entry${props.selectedId === it.e.id ? " selected" : ""}`}
              onClick={() => props.onPick(it.e.id)}
            >
              <span className="tl-time">
                {hm(it.e.start_utc)}–{hm(it.e.end_utc)}
              </span>
              <span className="tl-title">{it.e.title || it.e.raw_text.slice(0, 30) || "（无描述）"}</span>
              <span className={`badge st-${it.e.status}`}>{STATUS_LABEL[it.e.status]}</span>
              {it.e.score && (
                <span className={`score-pill g-${gradeOf(it.e.score.overall)}`}>
                  {it.e.score.overall} {GRADE_LABEL[gradeOf(it.e.score.overall)]}
                </span>
              )}
            </li>
          ),
        )}
      </ul>
    </div>
  );
}
