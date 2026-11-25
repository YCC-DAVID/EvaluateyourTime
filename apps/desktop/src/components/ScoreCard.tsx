import { useState } from "react";
import { GRADE_LABEL, computeOverall, gradeOf, type CategoryKind, type RuleSet, type ScoreDims } from "../../../../modules/scoring/index.ts";
import type { ScoreRevision } from "../api.ts";

const DIMS: { key: keyof ScoreDims; label: string; hint: string }[] = [
  { key: "execution_quality", label: "执行质量", hint: "是否投入；是否得到相应的推进、锻炼或恢复" },
  { key: "goal_contribution", label: "目标贡献", hint: "与当前目标的关系；休息娱乐不按产出评" },
  { key: "arrangement_quality", label: "安排合理性", hint: "是否符合计划、超时或挤占必要活动" },
];

export const CHANGE_KINDS: [string, string][] = [
  ["only_this", "仅修改本次"],
  ["ai_misunderstood", "AI 理解错误"],
  ["allocation_wrong", "分类或时长估计错误"],
  ["rule_unfit", "当前评分规则不合适"],
  ["apply_future", "希望以后类似情况采用同样标准"],
];

const SOURCE_LABEL = { ai: "AI 评分", user: "用户修改", manual: "手动评分" } as const;

export function ScoreCard(props: {
  score: ScoreRevision | null;
  history: ScoreRevision[];
  kind: CategoryKind;
  rules: RuleSet;
  confirmed: boolean;
  busy: boolean;
  onConfirm: (p: { dims?: ScoreDims; change_kind?: string; change_note?: string }) => void;
}) {
  const base: ScoreDims = props.score
    ? {
        execution_quality: props.score.execution_quality,
        goal_contribution: props.score.goal_contribution,
        arrangement_quality: props.score.arrangement_quality,
      }
    : { execution_quality: 70, goal_contribution: 50, arrangement_quality: 70 };
  const [dims, setDims] = useState<ScoreDims>(base);
  const [changeKind, setChangeKind] = useState("only_this");
  const [changeNote, setChangeNote] = useState("");
  const [showHistory, setShowHistory] = useState(false);

  const changed = DIMS.some((d) => dims[d.key] !== base[d.key]);
  const overall = computeOverall(dims, props.kind, props.rules);
  const grade = gradeOf(overall, props.rules);
  const w = props.rules.weights[props.kind];

  return (
    <div className="scorecard">
      <div className="score-top">
        <div className={`overall g-${grade}`}>
          <span className="num">{overall}</span>
          <span className="lbl">{GRADE_LABEL[grade]}</span>
        </div>
        <div className="score-meta">
          <div>
            {props.score ? SOURCE_LABEL[props.score.source] : "手动评分"}
            {props.score?.model ? ` · ${props.score.model}` : ""} · 规则 {props.rules.version}
          </div>
          <div className="muted small">
            整体分由程序计算：执行 {w.execution_quality} · 目标 {w.goal_contribution} · 安排 {w.arrangement_quality}（按主导活动类型）
          </div>
        </div>
      </div>

      {props.score?.reason && <p className="reason">{props.score.reason}</p>}
      {props.score && props.score.uncertainties.length > 0 && (
        <ul className="uncertain">
          {props.score.uncertainties.map((u, i) => (
            <li key={i}>不确定：{u}</li>
          ))}
        </ul>
      )}
      {props.score?.suggestion && <p className="suggestion">建议：{props.score.suggestion}</p>}

      <div className="dims">
        {DIMS.map((d) => (
          <label key={d.key} className="dim" title={d.hint}>
            <span className="dim-label">{d.label}</span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={dims[d.key]}
              onChange={(e) => setDims({ ...dims, [d.key]: Number(e.target.value) })}
            />
            <input
              type="number"
              min={0}
              max={100}
              value={dims[d.key]}
              onChange={(e) => setDims({ ...dims, [d.key]: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
            />
          </label>
        ))}
      </div>

      {changed && props.score && (
        <div className="change-reason">
          <div className="small">为什么修改？</div>
          <div className="chips">
            {CHANGE_KINDS.map(([k, label]) => (
              <button key={k} className={`chip${changeKind === k ? " on" : ""}`} onClick={() => setChangeKind(k)}>
                {label}
              </button>
            ))}
          </div>
          <input type="text" placeholder="补充说明（可选）" value={changeNote} onChange={(e) => setChangeNote(e.target.value)} />
        </div>
      )}

      <div className="actions">
        {props.confirmed && !changed ? (
          <span className="ok-text">已确认</span>
        ) : (
          <button
            className="primary"
            disabled={props.busy}
            onClick={() =>
              props.onConfirm(
                changed || !props.score ? { dims, change_kind: props.score ? changeKind : undefined, change_note: changeNote || undefined } : {},
              )
            }
          >
            {changed ? "保存修改并确认" : "确认评分"}
          </button>
        )}
        {props.history.length > 1 && (
          <button className="link" onClick={() => setShowHistory(!showHistory)}>
            {showHistory ? "收起" : `评分历史（${props.history.length}）`}
          </button>
        )}
      </div>
      {showHistory && (
        <ul className="history">
          {props.history.map((s) => (
            <li key={s.id}>
              {new Date(s.created_at).toLocaleString("zh-CN", { hour12: false })} · {SOURCE_LABEL[s.source]} · {s.overall} 分（
              {s.execution_quality}/{s.goal_contribution}/{s.arrangement_quality}）
              {s.change_kind && ` · ${CHANGE_KINDS.find(([k]) => k === s.change_kind)?.[1]}`}
              {s.change_note && `：${s.change_note}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
