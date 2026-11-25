import { GRADE_LABEL, gradeOf, type HeatCell, type RuleSet } from "../../../../modules/scoring/index.ts";
import { hm, type Entry } from "../api.ts";

export function gradeColor(score: number | null, rules: RuleSet): string {
  const g = gradeOf(score, rules);
  return g === "good" ? "var(--good)" : g === "fair" ? "var(--fair)" : g === "poor" ? "var(--poor)" : "var(--none)";
}

export function Heatmap(props: {
  cells: HeatCell[];
  entries: Entry[];
  rules: RuleSet;
  selectedId: string | null;
  onPick: (entryId: string) => void;
  onPickEmpty: (start: Date, end: Date) => void;
}) {
  const { cells, rules } = props;
  const perRow = 16; // 每行 4 小时，每格 15 分钟
  const rows: HeatCell[][] = [];
  for (let i = 0; i < cells.length; i += perRow) rows.push(cells.slice(i, i + perRow));
  const titleOf = (id: string) => {
    const e = props.entries.find((x) => x.id === id);
    return e ? e.title || e.raw_text.slice(0, 16) : "";
  };

  return (
    <div className="card heatmap-card">
      <div className="card-head">
        <h3>24 小时</h3>
        <div className="legend">
          <span><i style={{ background: "var(--good)" }} />较好</span>
          <span><i style={{ background: "var(--fair)" }} />一般</span>
          <span><i style={{ background: "var(--poor)" }} />偏离</span>
          <span><i className="pending" />已记录未评</span>
          <span><i style={{ background: "var(--none)" }} />未记录</span>
        </div>
      </div>
      <div className="heatmap">
        {rows.map((row, ri) => (
          <div className="hm-row" key={ri}>
            <span className="hm-hour">{String(ri * 4).padStart(2, "0")}:00</span>
            {row.map((c, ci) => {
              const recorded = c.entryIds.length > 0;
              const scored = c.score != null;
              const coverage = c.coveredMinutes / 15;
              const label = recorded
                ? `${hm(c.start)}–${hm(c.end)} ${c.entryIds.map(titleOf).join(" / ")}${
                    scored ? ` · ${c.score} 分（${GRADE_LABEL[gradeOf(c.score, rules)]}）· 整段平均，估计` : " · 未评分"
                  }${coverage < 1 ? ` · 覆盖 ${c.coveredMinutes} 分钟` : ""}`
                : `${hm(c.start)}–${hm(c.end)} 未记录，点击补录`;
              const selected = props.selectedId && c.entryIds.includes(props.selectedId);
              return (
                <button
                  key={ci}
                  className={`hm-cell${ci % 4 === 0 ? " hour-start" : ""}${recorded && !scored ? " pending" : ""}${selected ? " selected" : ""}`}
                  style={
                    scored
                      ? { background: gradeColor(c.score, rules), opacity: 0.35 + 0.65 * coverage }
                      : undefined
                  }
                  title={label}
                  aria-label={label}
                  onClick={() =>
                    recorded ? props.onPick(c.entryIds[c.entryIds.length - 1]) : props.onPickEmpty(new Date(c.start), new Date(c.end))
                  }
                >
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <p className="hint">没有具体子段时，整段按平均分着色（估计），不会把分心画到某个时刻。</p>
    </div>
  );
}
