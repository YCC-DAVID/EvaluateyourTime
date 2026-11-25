import { useState } from "react";
import { GRADE_LABEL, computeOverall, gradeOf, type CategoryKind, type RuleSet, type ScoreDims } from "../../../../modules/scoring/index.ts";
import type { ReactNode } from "react";
import type { Goal, ScoreRevision } from "../api.ts";
import { ProgressSlider } from "./ProgressSlider.tsx";
import { LEVEL_COLOR } from "./ActivitySuggestions.tsx";

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
  /** 这条记录关联的目标 */
  goal: Goal | null;
  /** 不确定项的补充、自我反馈（放在理由下面） */
  feedback?: ReactNode;
  onConfirm: (p: { dims?: ScoreDims; change_kind?: string; change_note?: string; goal_progress?: number | null; goal_progress_reason?: string }) => void;
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
  // 目标进度：AI 建议的值默认勾选，可以改数或取消
  const suggested = props.score?.goal_progress ?? null;
  // 只在“还没确认、且 AI 建议高于当前进度”时默认勾选。
  // 已确认的旧记录、或目标之后又推进过（建议值已经落后），默认不动，避免把进度拉回去。
  const current = props.goal?.progress ?? 0;
  const suggestAhead = suggested != null && suggested > current;
  const [applyProgress, setApplyProgress] = useState(!props.confirmed && suggestAhead);
  const [progressValue, setProgressValue] = useState(!props.confirmed && suggestAhead ? suggested! : current);
  const progressPending = !!props.goal && applyProgress && progressValue !== props.goal.progress;
  // 推进了什么：默认用 AI 的理由，改了数值或没有 AI 理由时必须自己写
  const [progressNote, setProgressNote] = useState(props.score?.goal_progress_reason ?? "");
  const progressNoteMissing = progressPending && !progressNote.trim();

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
      {props.feedback}
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

      {props.goal && (
        <div className="goal-progress">
          <label className="check">
            <input type="checkbox" checked={applyProgress} onChange={(e) => setApplyProgress(e.target.checked)} />
            更新目标进度
          </label>
          <span className="gp-title">{props.goal.title}</span>
          <span className="gp-from">原 {props.goal.progress}%</span>
          <ProgressSlider
            value={progressValue}
            base={props.goal.progress}
            color={LEVEL_COLOR[props.goal.level]}
            disabled={!applyProgress}
            onChange={setProgressValue}
          />
          {suggested == null && props.score && <div className="gp-reason muted small">AI 没有判断出这段让目标有推进，可以手动调整。</div>}
          {suggested != null && !suggestAhead && (
            <div className="gp-reason muted small">AI 当时建议 {suggested}%，不高于当前进度，默认不更新。</div>
          )}
          {applyProgress && (
            <label className="gp-note">
              <span className="small">这次推进了什么{progressPending ? "（必填）" : ""}</span>
              <input
                type="text"
                value={progressNote}
                placeholder="例如：跑完了模块 B 的消融，结果整理成表"
                onChange={(e) => setProgressNote(e.target.value)}
              />
              {props.score?.goal_progress_reason && progressNote === props.score.goal_progress_reason && (
                <span className="muted small">已填入 AI 的理由，可以修改</span>
              )}
            </label>
          )}
          {progressValue >= 100 && applyProgress && <div className="gp-reason small ok-text">到 100% 了，可以去目标页把它标为完成。</div>}
        </div>
      )}

      <div className="actions">
        {props.confirmed && !changed && !progressPending ? (
          <span className="ok-text">已确认</span>
        ) : (
          <button
            className="primary"
            disabled={props.busy || progressNoteMissing}
            title={progressNoteMissing ? "先写明这次推进了什么" : undefined}
            onClick={() =>
              props.onConfirm({
                ...(changed || !props.score ? { dims, change_kind: props.score ? changeKind : undefined, change_note: changeNote || undefined } : {}),
                goal_progress: progressPending ? progressValue : null,
                goal_progress_reason: progressPending ? progressNote.trim() : undefined,
              })
            }
          >
            {changed ? "保存修改并确认" : props.confirmed ? "更新目标进度" : "确认评分"}
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
