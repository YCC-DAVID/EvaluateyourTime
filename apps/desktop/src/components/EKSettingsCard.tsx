import { useEffect, useState } from "react";
import type { Meta } from "../api.ts";
import { locale, tr } from "../i18n.ts";

// 设置页：日历（Outlook 通过 Mac“日历”）与提醒事项。
// 日历：选要显示的日历；提醒事项：选要和目标同步的列表，每个列表可以挂到一个父目标下。

interface Status {
  helperInstalled: boolean;
  permissions: { calendar: string; reminders: string } | null;
  settings: {
    calendarIds: string[];
    eventRules: { match: string; goalId: string }[];
    reminderLists: { listId: string; title: string; goalId: string | null }[];
  };
  calendar: { at: string | null; error: string | null };
  reminders: { at: string | null; error: string | null; log: string[] };
}
interface Source {
  id: string;
  title: string;
  source: string;
}

const PERM: Record<string, string> = {
  granted: tr("已允许"),
  denied: tr("已拒绝（去“系统设置 › 隐私与安全性”里打开）"),
  "not-determined": tr("还没授权"),
  "write-only": tr("只允许写入（需要完全访问）"),
  restricted: tr("受限制"),
};
const req = async (method: string, url: string, body?: unknown) => {
  const r = await fetch(`/api${url}`, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || tr("请求失败（{0}）", [r.status]));
  return j;
};
const when = (s: string | null) => (s ? new Date(s).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : tr("还没同步"));

export function EKSettingsCard({ meta, onChanged }: { meta: Meta; onChanged: () => void }) {
  const [st, setSt] = useState<Status | null>(null);
  const [cals, setCals] = useState<Source[]>([]);
  const [lists, setLists] = useState<Source[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    const s: Status = await req("GET", "/ek/status");
    setSt(s);
    if (s.permissions?.calendar === "granted" || s.permissions?.reminders === "granted") {
      const src = await req("GET", "/ek/sources");
      setCals(src.calendars);
      setLists(src.lists);
    }
  };
  useEffect(() => {
    load().catch((e) => setErr(e.message));
  }, []);
  if (!st) return null;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setErr(null);
    try {
      await fn();
      await load();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const s = st.settings;
  const saveSettings = (patch: Partial<Status["settings"]>) => run(tr("正在保存…"), () => req("PUT", "/ek/settings", patch));
  const needAuth = st.permissions && (st.permissions.calendar !== "granted" || st.permissions.reminders !== "granted");
  const goals = meta.goals.filter((g) => g.status === "active" && g.level !== "task");

  return (
    <div className="card">
      <h3>{tr("日历与提醒事项")}</h3>
      <p className="muted">
        {tr("日历里的日程（Outlook 账户加到 Mac“日历”后也能读到）会显示在热力图和时间轴上，并关联到目标；选中的提醒事项列表和目标双向同步（标题、截止日、完成）。 读写由一个叫“时间记录助手”的小应用完成，数据只在本机。")}
      </p>
      {!st.helperInstalled ? (
        <div className="banner error small">{tr("还没装“时间记录助手”：在项目目录运行 npm run helper:build（需要 Xcode 命令行工具）。")}</div>
      ) : (
        <>
          <table className="kv">
            <tbody>
              <tr>
                <td>{tr("日历权限")}</td>
                <td>{PERM[st.permissions?.calendar ?? ""] ?? st.permissions?.calendar ?? tr("未知")}</td>
              </tr>
              <tr>
                <td>{tr("提醒事项权限")}</td>
                <td>{PERM[st.permissions?.reminders ?? ""] ?? st.permissions?.reminders ?? tr("未知")}</td>
              </tr>
            </tbody>
          </table>
          {needAuth && (
            <div className="actions">
              <button className="primary" disabled={!!busy} onClick={() => run(tr("等待你在系统窗口里选择…"), () => req("POST", "/ek/request"))}>
                {tr("授权日历和提醒事项")}
              </button>
              <span className="muted small">{tr("会弹出两个系统窗口（“时间记录助手”想访问日历 / 提醒事项），请自己确认允许。")}</span>
            </div>
          )}
          <p className="muted small" style={{ marginTop: 6 }}>
            {tr("用 Outlook 的话：在“系统设置 › 互联网账户”里添加你的 Microsoft/Exchange 账户并勾上“日历”，它就会出现在下面的日历列表里。")}
          </p>

          {cals.length > 0 && (
            <>
              <h4>{tr("显示哪些日历")}</h4>
              <div className="chips">
                {cals.map((c) => {
                  const on = s.calendarIds.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      className={`chip small-chip${on ? " on" : ""}`}
                      onClick={() => saveSettings({ calendarIds: on ? s.calendarIds.filter((x) => x !== c.id) : [...s.calendarIds, c.id] })}
                    >
                      {on ? "✓ " : ""}
                      {c.title}
                      <span className="muted"> · {c.source}</span>
                    </button>
                  );
                })}
              </div>
              <div className="muted small" style={{ marginTop: 4 }}>
                {tr("日历上次同步：")}{when(st.calendar.at)}
                {st.calendar.error && <span className="error-text"> · {st.calendar.error}</span>}
              </div>
              {s.eventRules.length > 0 && (
                <div className="small" style={{ marginTop: 6 }}>
                  {tr("日程关联规则：")}
                  {s.eventRules.map((r) => (
                    <span key={r.match} className="chip small-chip">
                      “{r.match}” → {meta.goals.find((g) => g.id === r.goalId)?.title ?? tr("已删除的目标")}
                      <button className="icon" title={tr("删除")} onClick={() => run(tr("正在保存…"), () => req("PUT", "/calendar/rule", { match: r.match, goalId: null }))}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </>
          )}

          {lists.length > 0 && (
            <>
              <h4>{tr("和目标同步的提醒事项列表")}</h4>
              <div className="rem-lists">
                {lists.map((l) => {
                  const cur = s.reminderLists.find((x) => x.listId === l.id);
                  const set = (on: boolean, goalId: string | null) =>
                    saveSettings({
                      reminderLists: on
                        ? [...s.reminderLists.filter((x) => x.listId !== l.id), { listId: l.id, title: l.title, goalId }]
                        : s.reminderLists.filter((x) => x.listId !== l.id),
                    });
                  return (
                    <div key={l.id} className="rem-row">
                      <label className="check-row">
                        <input type="checkbox" checked={!!cur} onChange={(e) => set(e.target.checked, cur?.goalId ?? null)} />
                        {l.title} <span className="muted small">· {l.source}</span>
                      </label>
                      {cur && (
                        <label className="small">
                          {tr("里面的待办挂到")}
                          <select value={cur.goalId ?? ""} onChange={(e) => set(true, e.target.value || null)}>
                            <option value="">{tr("（不挂父目标，单独成为短期目标）")}</option>
                            {goals.map((g) => (
                              <option key={g.id} value={g.id}>
                                {g.title}
                              </option>
                            ))}
                          </select>
                          {tr("下面")}
                        </label>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="actions">
                <button disabled={!!busy || !s.reminderLists.length} onClick={() => run(tr("正在同步…"), () => req("POST", "/ek/sync"))}>
                  {tr("立即同步")}
                </button>
                <span className="muted small">
                  {tr("提醒事项上次同步：")}{when(st.reminders.at)}{tr("（之后每 3 分钟自动同步，改目标后几秒内也会同步）")}
                </span>
              </div>
              {st.reminders.error && <div className="error-text small">{st.reminders.error}</div>}
              {st.reminders.log.length > 0 && (
                <ul className="sync-log">
                  {st.reminders.log.slice(0, 6).map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              )}
              <p className="muted small">
                {tr("规则：只有一边改了以那边为准，两边都改了以后改的为准。提醒事项里删掉的待办，对应目标标为“放弃”；在应用里删掉目标不会删提醒事项。 同步进来的任务占父目标 0%，需要时在目标页设占比。")}
              </p>
            </>
          )}
        </>
      )}
      {busy && <div className="banner info small">{busy}</div>}
      {err && <div className="error-text small">{err}</div>}
    </div>
  );
}
