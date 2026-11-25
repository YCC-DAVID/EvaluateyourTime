import { useCallback, useEffect, useMemo, useState } from "react";
import { api, todayStr, type Entry, type Meta } from "./api.ts";
import { localDayRange, buildHeatmap, computeDayStats, type DayEntry } from "../../../modules/scoring/index.ts";
import { Heatmap } from "./components/Heatmap.tsx";
import { DayStatsCard } from "./components/DayStatsCard.tsx";
import { Timeline } from "./components/Timeline.tsx";
import { RecordPanel, type RecordTarget } from "./components/RecordPanel.tsx";
import { GoalsView } from "./components/GoalsView.tsx";
import { SettingsView } from "./components/SettingsView.tsx";

type Tab = "today" | "goals" | "settings";

export function App() {
  const [tab, setTab] = useState<Tab>("today");
  const [meta, setMeta] = useState<Meta | null>(null);
  const [day, setDay] = useState(todayStr());
  const [entries, setEntries] = useState<Entry[]>([]);
  const [target, setTarget] = useState<RecordTarget>({ kind: "new" });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const [d0, d1] = useMemo(() => localDayRange(day), [day]);

  const reloadMeta = useCallback(() => api.meta().then(setMeta).catch((e) => setLoadError(e.message)), []);
  const reloadEntries = useCallback(
    () =>
      api
        .entries(new Date(d0).toISOString(), new Date(d1).toISOString())
        .then((list) => {
          setEntries(list);
          setLoadError(null);
        })
        .catch((e) => setLoadError(e.message)),
    [d0, d1],
  );

  useEffect(() => void reloadMeta(), [reloadMeta]);
  useEffect(() => void reloadEntries(), [reloadEntries]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const primaryGoal = meta?.goals.find((g) => g.is_primary && g.status === "active") ?? null;

  const dayEntries: DayEntry[] = useMemo(
    () =>
      entries.map((e) => ({
        id: e.id,
        start: e.start_utc,
        end: e.end_utc,
        overall: e.status === "confirmed" ? (e.score?.overall ?? null) : null,
        confirmed: e.status === "confirmed",
        goal_id: e.goal_id,
        allocations: e.allocations,
        title: e.title ?? e.raw_text.slice(0, 20),
      })),
    [entries],
  );
  const cells = useMemo(() => buildHeatmap(dayEntries, d0, d1), [dayEntries, d0, d1]);
  const stats = useMemo(
    () =>
      meta
        ? computeDayStats(dayEntries, meta.categories, d0, d1, now, meta.work_budget_minutes, primaryGoal?.id ?? null)
        : null,
    [dayEntries, meta, d0, d1, now, primaryGoal],
  );

  const onEntryChanged = (e: Entry | null) => {
    reloadEntries();
    if (e) {
      setDay(todayStr(new Date(e.start_utc)));
      setTarget({ kind: "edit", id: e.id });
    }
    else setTarget({ kind: "new" });
  };

  const shiftDay = (n: number) => {
    const [y, m, d] = day.split("-").map(Number);
    setDay(todayStr(new Date(y, m - 1, d + n)));
    setTarget({ kind: "new" });
  };

  const selected = target.kind === "edit" ? (entries.find((e) => e.id === target.id) ?? null) : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">时间记录</div>
        <nav>
          {(
            [
              ["today", "今天"],
              ["goals", "目标"],
              ["settings", "设置"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} className={tab === k ? "tab active" : "tab"} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="motto">工作认真工作 · 娱乐尽兴娱乐 · 休息安心休息</div>
      </header>

      {loadError && <div className="banner error">{loadError}</div>}

      {tab === "today" && meta && (
        <main className="today">
          <section className="col left">
            <div className="daynav">
              <button onClick={() => shiftDay(-1)} aria-label="前一天">‹</button>
              <input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
              <button onClick={() => shiftDay(1)} aria-label="后一天">›</button>
              {day !== todayStr() && (
                <button className="link" onClick={() => setDay(todayStr())}>
                  回到今天
                </button>
              )}
            </div>
            <Heatmap
              cells={cells}
              entries={entries}
              rules={meta.rules}
              selectedId={selected?.id ?? null}
              onPick={(id) => setTarget({ kind: "edit", id })}
              onPickEmpty={(start, end) => setTarget({ kind: "new", start, end })}
            />
            {stats && <DayStatsCard stats={stats} meta={meta} primaryGoal={primaryGoal} />}
            <Timeline
              entries={entries}
              dayStart={d0}
              dayEnd={Math.min(d1, now)}
              selectedId={selected?.id ?? null}
              onPick={(id) => setTarget({ kind: "edit", id })}
              onFillGap={(start, end) => setTarget({ kind: "new", start, end })}
            />
          </section>
          <section className="col right">
            <RecordPanel
              key={target.kind === "edit" ? target.id : `new-${target.start ?? ""}-${target.end ?? ""}`}
              meta={meta}
              target={target}
              entry={selected}
              onChanged={onEntryChanged}
              onNew={() => setTarget({ kind: "new" })}
            />
          </section>
        </main>
      )}

      {tab === "goals" && meta && <GoalsView meta={meta} onChanged={reloadMeta} />}
      {tab === "settings" && meta && <SettingsView meta={meta} onChanged={() => { reloadMeta(); reloadEntries(); }} />}
    </div>
  );
}
