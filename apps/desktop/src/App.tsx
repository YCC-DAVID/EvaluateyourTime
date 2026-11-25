import { ModelPicker } from "./components/ModelPicker.tsx";
import { useAppRefresh } from "./useAppRefresh.ts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, todayStr, toDayEntry, type CalEvent, type Entry, type Meta } from "./api.ts";
import { backfillWindowStart, localDayRange, buildHeatmap, computeDayStats, type DayEntry } from "../../../modules/scoring/index.ts";
import { Heatmap, ModeSwitch, type HeatMode } from "./components/Heatmap.tsx";
import { PeriodHeatmap } from "./components/PeriodHeatmap.tsx";
import { DayStatsCard } from "./components/DayStatsCard.tsx";
import { Timeline } from "./components/Timeline.tsx";
import { RecordPanel, type RecordTarget } from "./components/RecordPanel.tsx";
import { GoalsView } from "./components/GoalsView.tsx";
import { SettingsView } from "./components/SettingsView.tsx";
import { ChatView } from "./components/ChatView.tsx";
import { DayEvents } from "./components/DayEvents.tsx";
import { lang, tr } from "./i18n.ts";

type Tab = "today" | "chat" | "goals" | "settings";

export function App() {
  const [tab, setTab] = useState<Tab>("today");
  const [meta, setMeta] = useState<Meta | null>(null);
  const [day, setDay] = useState(todayStr());
  const [entries, setEntries] = useState<Entry[]>([]);
  const [target, setTarget] = useState<RecordTarget>({ kind: "new" });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [heatMode, setHeatMode] = useState<HeatMode>("day");
  const [calEvents, setCalEvents] = useState<CalEvent[]>([]);

  const [d0, d1] = useMemo(() => localDayRange(day), [day]);

  const reloadMeta = useCallback(
    () =>
      api
        .meta()
        .then((m) => {
          // 语言以服务端为准：在别的窗口（浏览器 / 程序坞应用）改过的话，这里跟着换
          if (m.language && m.language !== lang) {
            localStorage.setItem("ui.lang", m.language);
            location.reload();
          }
          setMeta(m);
        })
        .catch((e) => setLoadError(e.message)),
    [],
  );
  const reloadEvents = useCallback(
    () =>
      api
        .calendarEvents(new Date(d0).toISOString(), new Date(d1).toISOString())
        .then(setCalEvents)
        .catch(() => setCalEvents([])),
    [d0, d1],
  );
  useEffect(() => void reloadEvents(), [reloadEvents, now]);

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
  // 窗口回到前台时刷新数据；服务更新后提示刷新页面
  const updated = useAppRefresh(() => {
    reloadMeta();
    reloadEntries();
  });
  useEffect(() => void reloadEntries(), [reloadEntries]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const primaryGoal = meta?.goals.find((g) => g.is_primary && g.status === "active") ?? null;

  const dayEntries: DayEntry[] = useMemo(
    () => entries.map(toDayEntry),
    [entries],
  );
  const cells = useMemo(() => buildHeatmap(dayEntries, d0, d1, 15, meta?.categories), [dayEntries, d0, d1, meta?.categories]);
  const stats = useMemo(
    () =>
      meta
        ? computeDayStats(dayEntries, meta.categories, d0, d1, now, meta.work_budget_minutes, primaryGoal?.id ?? null)
        : null,
    [dayEntries, meta, d0, d1, now, primaryGoal],
  );

  const onEntryChanged = (e: Entry | null) => {
    reloadEntries();
    reloadMeta(); // 目标进度可能随评分确认而变化
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
  const shiftPeriod = (dir: -1 | 1) => {
    const [y, m, d] = day.split("-").map(Number);
    setDay(todayStr(heatMode === "week" ? new Date(y, m - 1, d + 7 * dir) : new Date(y, m - 1 + dir, 1)));
  };
  const modeSwitch = <ModeSwitch mode={heatMode} onChange={setHeatMode} />;

  const selected = target.kind === "edit" ? (entries.find((e) => e.id === target.id) ?? null) : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">{tr("时间记录")}</div>
        <nav>
          {(
            [
              ["today", tr("今天")],
              ["chat", tr("对话")],
              ["goals", tr("目标")],
              ["settings", tr("设置")],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              className={tab === k ? "tab active" : "tab"}
              onClick={() => {
                // 对话页右侧固定看今天
                if (k === "chat") {
                  setDay(todayStr());
                  setHeatMode("day");
                }
                setTab(k);
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="motto">{tr("工作认真工作 · 娱乐尽兴娱乐 · 休息安心休息")}</div>
        {updated && (
          <button className="update-pill" onClick={() => location.reload()}>
            {tr("有新版本 · 点此刷新")}
          </button>
        )}
        <button className="icon refresh-btn" title={tr("刷新")} aria-label={tr("刷新")} onClick={() => location.reload()}>
          ⟳
        </button>
        <ModelPicker onOpenSettings={() => setTab("settings")} />
      </header>

      {loadError && <div className="banner error">{loadError}</div>}

      {tab === "today" && meta && (
        <main className="today">
          <section className="col left">
            <div className="daynav">
              <button onClick={() => shiftDay(-1)} aria-label={tr("前一天")}>‹</button>
              <input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
              <button onClick={() => shiftDay(1)} aria-label={tr("后一天")}>›</button>
              {day !== todayStr() && (
                <button className="link" onClick={() => setDay(todayStr())}>
                  {tr("回到今天")}
                </button>
              )}
            </div>
            {heatMode === "day" ? (
            <Heatmap
              categories={meta.categories}
              modeSwitch={modeSwitch}
              cells={cells}
              entries={entries}
              rules={meta.rules}
              selectedId={selected?.id ?? null}
              onPick={(id) => setTarget({ kind: "edit", id })}
              onPickEmpty={(start, end) => setTarget({ kind: "new", start, end })}
              backfillFrom={backfillWindowStart(now)}
              now={now}
              events={calEvents}
              picked={target.kind === "new" && target.start && target.end ? { start: target.start.getTime(), end: target.end.getTime() } : null}
            />
            ) : (
              <PeriodHeatmap
                mode={heatMode}
                anchor={day}
                rules={meta.rules}
                categories={meta.categories}
                workBudgetMinutes={meta.work_budget_minutes}
                primaryGoalId={primaryGoal?.id ?? null}
                now={now}
                refreshKey={entries}
                modeSwitch={modeSwitch}
                onShift={shiftPeriod}
                onPickDay={(d) => {
                  setDay(d);
                  setHeatMode("day");
                  setTarget({ kind: "new" });
                }}
              />
            )}
            {stats && <DayStatsCard stats={stats} meta={meta} primaryGoal={primaryGoal} />}
            <DayEvents
              events={calEvents}
              entries={entries}
              goals={meta.goals}
              now={now}
              backfillFrom={backfillWindowStart(now)}
              onBackfill={(e) =>
                setTarget({ kind: "new", start: new Date(e.start_utc), end: new Date(e.end_utc), prefillText: e.title, goalId: e.goal_id })
              }
              onLink={async (title, goalId) => {
                await api.setCalendarRule(title, goalId);
                reloadEvents();
              }}
            />
            <Timeline
              entries={entries}
              dayStart={d0}
              dayEnd={Math.min(d1, now)}
              selectedId={selected?.id ?? null}
              onPick={(id) => setTarget({ kind: "edit", id })}
              onFillGap={(start, end) => setTarget({ kind: "new", start, end })}
              onDraftGap={(start, end) => setTarget({ kind: "new", start, end, fromDevice: true })}
              backfillFrom={backfillWindowStart(now)}
              categories={meta.categories}
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

      {tab === "chat" && meta && (
        <ChatView
          meta={meta}
          onDataChanged={() => {
            reloadEntries();
            reloadMeta();
          }}
          onOpenEntry={(id) => {
            setTarget({ kind: "edit", id });
            setTab("today");
          }}
          onOpenSettings={() => setTab("settings")}
          side={
            <>
              <Heatmap
                categories={meta.categories}
                cells={cells}
                entries={entries}
                rules={meta.rules}
                selectedId={null}
                onPick={(id) => {
                  setTarget({ kind: "edit", id });
                  setTab("today");
                }}
                onPickEmpty={(start, end) => {
                  setTarget({ kind: "new", start, end });
                  setTab("today");
                }}
                backfillFrom={backfillWindowStart(now)}
                now={now}
              />
              {stats && <DayStatsCard stats={stats} meta={meta} primaryGoal={primaryGoal} />}
            </>
          }
        />
      )}

      {tab === "goals" && meta && (
        <GoalsView
          meta={meta}
          onChanged={reloadMeta}
          onOpenEntry={(e) => {
            // 从目标详情跳到这条记录所在的那一天
            setDay(todayStr(new Date(e.start_utc)));
            setTarget({ kind: "edit", id: e.id });
            setTab("today");
          }}
        />
      )}
      {tab === "settings" && meta && <SettingsView meta={meta} onChanged={() => { reloadMeta(); reloadEntries(); }} />}
    </div>
  );
}
