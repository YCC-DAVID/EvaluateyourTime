import { useEffect, useState } from "react";
import { api, fmtMinutes, type DeviceSummary } from "../api.ts";
import { tr } from "../i18n.ts";

// 某段时间的电脑使用参照：前台应用分钟数 + 离开键鼠。只作参照，不代表专注或效率。

/** 摊平成一个列表：有网站/窗口细分的按细分（各自分钟数），没有的按应用；去掉“离开”“已排除”这类 */
export function deviceTopItems(s: DeviceSummary): { label: string; minutes: number }[] {
  return s.apps
    .filter((a) => !a.app.startsWith("（")) // 服务端的占位名（离开、其他应用等）都以全角括号开头
    .flatMap((a) => {
      const rest = a.minutes - a.details.reduce((x, d) => x + d.minutes, 0);
      return [...a.details.map((d) => ({ label: d.label, minutes: d.minutes })), ...(rest > 0 ? [{ label: a.app, minutes: rest }] : [])];
    })
    .sort((a, b) => b.minutes - a.minutes);
}

export function DeviceRef({
  start,
  end,
  compact = false,
  onSummary,
}: {
  start: string | null;
  end: string | null;
  compact?: boolean;
  /** 把取到的摘要交给外面（例如决定要不要显示“按电脑记录生成”） */
  onSummary?: (s: DeviceSummary | null) => void;
}) {
  const [s, setS] = useState<DeviceSummary | null>(null);
  useEffect(() => onSummary?.(s), [s]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!start || !end || Date.parse(end) <= Date.parse(start)) return setS(null);
    let alive = true;
    // 时间框还在改时不要每个字都请求
    const t = setTimeout(() => {
      api
        .deviceSummary(start, end)
        .then((r) => alive && setS(r))
        .catch(() => alive && setS(null));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [start, end]);

  if (!s || s.source === "none" || s.coveredMinutes === 0)
    return compact ? null : <div className="device-ref muted small">{tr("电脑参照：这段时间没有采集数据（服务没开、电脑睡眠或已暂停采集）")}</div>;

  const shown = s.apps.slice(0, compact ? 4 : 6);
  const rest = s.apps.slice(shown.length).reduce((a, x) => a + x.minutes, 0);
  return (
    <div className="device-ref small" title={tr("来自电脑前台应用和键鼠空闲，只作参照：前台开着不等于专注，离开键鼠也可能在思考或开会")}>
      <span className="dr-label">{tr("电脑参照")}</span>
      {shown.map((a) => (
        <span key={a.app} className="dr-app">
          {tr(a.app)} <b>{fmtMinutes(a.minutes)}</b>
          {a.details.length > 0 && (
            <span className="dr-detail">
              {tr("（")}
              {a.details
                .slice(0, compact ? 2 : 3)
                .map((d) => `${tr(d.label)} ${d.minutes}`)
                .join(tr("、"))}
              {a.details.length > (compact ? 2 : 3) ? "…" : ""}{tr("）")}
            </span>
          )}
        </span>
      ))}
      {rest > 0 && <span className="dr-app">{tr("其他")} {fmtMinutes(rest)}</span>}
      {s.afkMinutes > 0 && <span className="dr-app afk">{tr("离开键鼠")} {fmtMinutes(s.afkMinutes)}</span>}
      <span className="muted">
        {tr("覆盖")} {Math.round((s.coveredMinutes / Math.max(1, s.rangeMinutes)) * 100)}%{s.source === "activitywatch" ? " · ActivityWatch" : ""}
      </span>
    </div>
  );
}
