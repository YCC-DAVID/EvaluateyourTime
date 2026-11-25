import type { CategoryKind, DayStats } from "../../../../modules/scoring/index.ts";
import { fmtMinutes, type Goal, type Meta } from "../api.ts";
import { tr } from "../i18n.ts";

const KIND_LABEL: Record<CategoryKind, string> = {
  work: tr("工作学习"),
  sport: tr("运动"),
  rest: tr("休息"),
  fun: tr("娱乐社交"),
  life: tr("生活事务"),
  waste: tr("无意消耗"),
  unknown: tr("不确定"),
};

export function DayStatsCard({ stats, meta, primaryGoal }: { stats: DayStats; meta: Meta; primaryGoal: Goal | null }) {
  const pct = Math.round(stats.budgetCompletion * 100);
  const colorOf = (k: CategoryKind) => meta.categories.find((c) => c.kind === k)?.color ?? "#999";
  const distTotal = Object.values(stats.minutesByKind).reduce((a, b) => a + b, 0);
  return (
    <div className="card">
      <div className="stats-grid">
        <div className="stat">
          <div className="stat-label">{tr("有效脑力工作")}</div>
          <div className="stat-value">{fmtMinutes(stats.effectiveWorkMinutes)}</div>
          <div className="bar">
            <div className="bar-fill" style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
          <div className="stat-sub">
            {tr("预算")} {fmtMinutes(stats.workBudgetMinutes)} {tr("· 完成")} {pct}%{pct > 100 ? tr("（预算不是每天都要超的指标）") : ""}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">{tr("重点目标投入")}</div>
          <div className="stat-value">{stats.primaryGoalShare == null ? tr("无数据") : `${Math.round(stats.primaryGoalShare * 100)}%`}</div>
          <div className="stat-sub">{primaryGoal ? tr("主要目标：{0}", [primaryGoal.title]) : tr("尚未设置主要目标")}</div>
        </div>
        <div className="stat">
          <div className="stat-label">{tr("记录覆盖率")}</div>
          <div className="stat-value">{stats.coverage == null ? "—" : `${Math.round(stats.coverage * 100)}%`}</div>
          <div className="stat-sub">
            {tr("已记录")} {fmtMinutes(stats.recordedMinutes)} {tr("/ 已过")} {fmtMinutes(stats.elapsedMinutes)}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">{tr("平均评价")}</div>
          <div className="stat-value">{stats.avgScore ?? "—"}</div>
          <div className="stat-sub">{tr("仅含已确认评分，按时长加权")}</div>
        </div>
      </div>
      {distTotal > 0 && (
        <>
          <div className="dist">
            {(Object.keys(stats.minutesByKind) as CategoryKind[])
              .filter((k) => stats.minutesByKind[k] > 0)
              .map((k) => (
                <div
                  key={k}
                  className="dist-seg"
                  style={{ flex: stats.minutesByKind[k], background: colorOf(k) }}
                  title={`${KIND_LABEL[k]} ${fmtMinutes(stats.minutesByKind[k])}`}
                />
              ))}
          </div>
          <div className="dist-legend">
            {(Object.keys(stats.minutesByKind) as CategoryKind[])
              .filter((k) => stats.minutesByKind[k] > 0)
              .map((k) => (
                <span key={k}>
                  <i style={{ background: colorOf(k) }} />
                  {KIND_LABEL[k]} {fmtMinutes(stats.minutesByKind[k])}
                </span>
              ))}
          </div>
        </>
      )}
      {stats.prorated && <p className="hint">{tr("有跨天或时间重叠的记录：重叠部分只算后记的那条，其余按时长比例分摊（估计）。")}</p>}
    </div>
  );
}
