import type { CSSProperties } from "react";
import type { Category } from "../../../../modules/scoring/index.ts";
import type { Goal } from "../api.ts";
import { tr } from "../i18n.ts";

// 记录时的备选项：点一下就把文字填进描述框。
// 目标项会同时把这条记录关联到该目标；常见项只填文字，分类仍由 AI 或你来定。

// “常见”按钮来自设置里的身份（读论文、开会……因人而异）；cat 只用来上色，不决定分类

export const LEVEL_COLOR = { long: "#c9721a", short: "#3b6cf6", task: "#0f9d9a" } as const;
const tint = (c: string) => ({ "--c": c }) as CSSProperties;

const LEVEL_SHORT = { long: tr("长期"), short: tr("短期"), task: tr("任务") } as const;
const LEVEL_ORDER = { short: 0, task: 1, long: 2 } as const;

function daysLeft(ddl: string | null): number | null {
  if (!ddl) return null;
  const [y, m, d] = ddl.split("-").map(Number);
  const now = new Date();
  return Math.round((new Date(y, m - 1, d).getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86400_000);
}

export function ActivitySuggestions(props: {
  goals: Goal[];
  categories: Category[];
  activities: { label: string; cat: string }[];
  /** 排在“常见”最前面、高亮的“按电脑记录”（这段时间有电脑数据时才有） */
  deviceChip?: { label: string; disabled?: boolean; onClick: () => void } | null;
  linkedGoalId: string | null;
  onPickGoal: (g: Goal) => void;
  onPickText: (t: string) => void;
}) {
  // 进行中的目标：主要目标在前，然后短期、任务、长期；同层按优先级和 DDL
  const goals = props.goals
    .filter((g) => g.status === "active")
    .sort(
      (a, b) =>
        Number(b.is_primary) - Number(a.is_primary) ||
        LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] ||
        a.priority - b.priority ||
        (a.ddl ?? "9999").localeCompare(b.ddl ?? "9999"),
    )
    .slice(0, 8);

  return (
    <div className="suggest">
      {goals.length > 0 && (
        <div className="suggest-row">
          <span className="suggest-label">{tr("目标")}</span>
          <div className="chips">
            {goals.map((g) => {
              const dl = daysLeft(g.ddl);
              const on = props.linkedGoalId === g.id;
              return (
                <button
                  key={g.id}
                  className={`chip tinted goal-chip${on ? " on" : ""}`}
                  style={tint(LEVEL_COLOR[g.level])}
                  title={`${g.title}${g.ddl ? tr("（DDL {0}）", [g.ddl]) : ""}${on ? tr(" · 已关联，再点取消") : tr(" · 点击填入并关联这条记录")}`}
                  onClick={() => props.onPickGoal(g)}
                >
                  {g.is_primary && "★ "}
                  <span className="lvl">{LEVEL_SHORT[g.level]}</span>
                  {g.title.length > 14 ? `${g.title.slice(0, 14)}…` : g.title}
                  {dl != null && dl >= 0 && dl <= 7 && <span className="ddl">{dl === 0 ? tr("今天截止") : tr("{0} 天", [dl])}</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className="suggest-row">
        <span className="suggest-label">{tr("常见")}</span>
        <div className="chips">
          {props.deviceChip && (
            <button
              className="chip device-chip"
              disabled={props.deviceChip.disabled}
              title={tr("按这段时间的电脑使用起草描述和时间分配，说不准的再问你")}
              onClick={props.deviceChip.onClick}
            >
              {props.deviceChip.label}
            </button>
          )}
          {props.activities.map((t) => (
            <button
              key={t.label}
              className="chip tinted small-chip"
              style={tint(props.categories.find((c) => c.id === t.cat)?.color ?? "#9aa0a6")}
              onClick={() => props.onPickText(tr(t.label))}
            >
              {tr(t.label)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
