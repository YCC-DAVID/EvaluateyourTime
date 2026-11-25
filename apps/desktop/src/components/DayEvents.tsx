import { hm, type CalEvent, type Entry, type Goal } from "../api.ts";
import { tr } from "../i18n.ts";

// 时间轴上的“日程”：来自 Mac 日历（包括加进去的 Outlook 账户）。
// 已过去、还没记录的可以一键补录（带上日程标题和关联目标）；未来的显示为待进行。
// 选目标 = 以后同标题的日程都关联到这个目标（例如每周组会）。

export function DayEvents(props: {
  events: CalEvent[];
  entries: Entry[];
  goals: Goal[];
  now: number;
  backfillFrom: number;
  onBackfill: (e: CalEvent) => void;
  onLink: (title: string, goalId: string | null) => void;
}) {
  const list = props.events.filter((e) => !e.all_day);
  const allDay = props.events.filter((e) => e.all_day);
  if (!props.events.length) return null;
  const recordedMinutes = (e: CalEvent) => {
    const s = Date.parse(e.start_utc);
    const t = Date.parse(e.end_utc);
    return props.entries.reduce((a, x) => a + Math.max(0, Math.min(t, Date.parse(x.end_utc)) - Math.max(s, Date.parse(x.start_utc))), 0) / 60000;
  };
  const activeGoals = props.goals.filter((g) => g.status === "active");

  return (
    <div className="card">
      <div className="card-head">
        <h3>{tr("日程")}</h3>
        {allDay.length > 0 && <span className="muted small">{tr("全天：")}{allDay.map((e) => e.title).join(tr("、"))}</span>}
      </div>
      <ul className="timeline day-events">
        {list.map((e) => {
          const s = Date.parse(e.start_utc);
          const t = Date.parse(e.end_utc);
          const future = s >= props.now;
          const total = (t - s) / 60000;
          const covered = recordedMinutes(e) >= total * 0.8;
          return (
            <li key={e.id} className={`ev-item${future ? " future" : ""}`}>
              <span className="tl-time">
                {hm(e.start_utc)}–{hm(e.end_utc)}
              </span>
              <span className="tl-title">📅 {e.title}</span>
              <select
                className="ev-goal"
                value={e.goal_id ?? ""}
                title={tr("选了以后，同标题的日程都关联到这个目标")}
                onChange={(x) => props.onLink(e.title, x.target.value || null)}
              >
                <option value="">{tr("不关联目标")}</option>
                {activeGoals.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title}
                  </option>
                ))}
              </select>
              {future ? (
                <span className="badge">{tr("待进行")}</span>
              ) : covered ? (
                <span className="badge st-confirmed">{tr("已记录")}</span>
              ) : t > props.backfillFrom ? (
                <button className="link small" onClick={() => props.onBackfill(e)}>
                  {tr("补录")}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
