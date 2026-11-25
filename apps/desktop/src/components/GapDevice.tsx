import { useEffect, useState } from "react";
import { api, type DeviceSummary } from "../api.ts";
import { deviceTopItems } from "./DeviceRef.tsx";
import { tr } from "../i18n.ts";

// 时间轴空档：这段没记录的时间里电脑上主要在干什么，有数据就给“按电脑记录补录”

export function GapDevice({ start, end, onDraft }: { start: number; end: number; onDraft: () => void }) {
  const [s, setS] = useState<DeviceSummary | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .deviceSummary(new Date(start).toISOString(), new Date(end).toISOString())
      .then((r) => alive && setS(r))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [start, end]);
  if (!s || s.coveredMinutes < 5) return null;
  const top = deviceTopItems(s)
    .slice(0, 3)
    .map((x) => `${tr(x.label)} ${x.minutes}`)
    .join(" · ");
  return (
    <span className="gap-device">
      <span className="muted small">{tr("电脑：")}{top || tr("离开为主")}</span>
      <button className="link small" onClick={onDraft} title={tr("按这段时间的电脑使用起草一条记录，说不准的再问你")}>
        {tr("按电脑记录补录")}
      </button>
    </span>
  );
}
