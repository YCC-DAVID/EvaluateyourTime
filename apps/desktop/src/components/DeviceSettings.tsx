import { useEffect, useState } from "react";
import type { Category } from "../../../../modules/scoring/index.ts";
import { api, type DeviceStatus } from "../api.ts";
import { tr } from "../i18n.ts";

// 设置页：电脑使用参照（采集开关、排除的应用、是否发给 AI）

export function DeviceSettings({ categories }: { categories: Category[] }) {
  const [st, setSt] = useState<DeviceStatus | null>(null);
  const [apps, setApps] = useState<string[]>([]);
  const [sites, setSites] = useState<string[]>([]);
  const [installed, setInstalled] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const load = () => {
    api.deviceStatus().then(setSt).catch(() => {});
    api
      .deviceApps()
      .then((r) => {
        setApps(r.apps);
        setSites(r.sites);
        setInstalled(r.installed);
      })
      .catch(() => {});
  };
  useEffect(load, []);
  if (!st) return null;
  const s = st.settings;
  const save = async (b: Parameters<typeof api.saveDeviceSettings>[0]) => {
    await api.saveDeviceSettings(b);
    load();
  };
  const excluded = new Set(s.excludedApps);
  const all = [...new Set([...s.excludedApps, ...apps])];
  const ago = st.lastSample ? Math.round((Date.now() - st.lastSample.at) / 1000) : null;
  const exSites = new Set(s.excludedSites);
  const allSites = [...new Set([...s.excludedSites, ...sites])];

  return (
    <div className="card">
      <h3>{tr("电脑使用参照")}</h3>
      <p className="muted">
        {tr("每 5 秒记录一次前台应用和键鼠空闲（超过")} {Math.round(s.afkSeconds / 60)} {tr("分钟算离开），用来帮你起草记录、补录空档。")}
        <br />
        <strong>{tr("隐私")}</strong>{tr("：只记到“应用 / 网站域名 / 窗口标题”这一层，不记页面标题、网址路径和页面内容；原始记录只存在本机，不进导出备份、不同步； 发给 AI 的只有按时段汇总的分钟数（例如“T3 Code 37 分钟、overleaf.com 15 分钟”），关掉下面的“发给 AI”后，按电脑记录起草也完全在本地完成。")}
      </p>
      <table className="kv">
        <tbody>
          <tr>
            <td>{tr("状态")}</td>
            <td>
              {!st.supported
                ? tr("当前系统不支持内置采集")
                : !s.enabled
                  ? tr("已暂停")
                  : st.lastError
                    ? tr("采集出错：{0}", [st.lastError])
                    : st.lastSample
                      ? tr("采集中 · {0} 秒前：{1}{2}", [ago, st.lastSample.app, st.lastSample.detail ? ` · ${st.lastSample.detail}` : ""])
                      : tr("启动中…")}
              {st.activitywatch && tr(" · 检测到 ActivityWatch，优先使用它的数据")}
            </td>
          </tr>
        </tbody>
      </table>
      <div className="actions">
        <label className="check-row">
          <input type="checkbox" checked={s.enabled} onChange={(e) => save({ enabled: e.target.checked })} />
          {tr("采集前台应用")}
        </label>
        <label className="check-row">
          <input type="checkbox" checked={s.detail} disabled={!s.enabled} onChange={(e) => save({ detail: e.target.checked })} />
          {tr("记录浏览器网站和窗口标题")}
        </label>
        <label className="check-row">
          <input type="checkbox" checked={s.sendToAI} onChange={(e) => save({ send_to_ai: e.target.checked })} />
          {tr("把汇总的应用/网站分钟数发给 AI（关掉则完全本地处理）")}
        </label>
      </div>
      <p className="muted small" style={{ marginTop: 6 }}>
        {tr("打开“网站和窗口标题”后，同一个浏览器能分出 overleaf.com、youtube.com 等网站，T3 Code 这类应用能分出当前窗口（通常带项目名）。 第一次会弹出系统授权：浏览器需要“自动化”权限，窗口标题需要“辅助功能”权限，请自己确认允许；不允许就只记应用名。")}
      </p>
      {st.detailError && <div className="banner error small">{st.detailError}</div>}
      {s.detail && allSites.length > 0 && (
        <>
          <div className="small muted" style={{ marginTop: 8 }}>
            {tr("排除的网站（排除后只记为“已排除的网站”）：")}
          </div>
          <div className="chips" style={{ marginTop: 4 }}>
            {allSites.map((a) => (
              <button
                key={a}
                className={`chip small-chip${exSites.has(a) ? " on" : ""}`}
                onClick={() => save({ excluded_sites: exSites.has(a) ? s.excludedSites.filter((x) => x !== a) : [...s.excludedSites, a] })}
              >
                {exSites.has(a) ? "✕ " : ""}
                {a}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="small muted" style={{ marginTop: 10 }}>{tr("记录哪些应用：")}</div>
      <div className="actions" style={{ marginTop: 4 }}>
        <label className="check-row">
          <input type="radio" name="dev-mode" checked={s.mode === "all"} onChange={() => save({ mode: "all" })} />
          {tr("记录所有应用（可以排除个别）")}
        </label>
        <label className="check-row">
          <input type="radio" name="dev-mode" checked={s.mode === "only"} onChange={() => save({ mode: "only" })} />
          {tr("只记录我选的应用（其他只记为“其他应用”）")}
        </label>
      </div>
      {s.mode === "all" ? (
        all.length > 0 && (
          <>
            <div className="small muted" style={{ marginTop: 8 }}>
              {tr("排除的应用（点一下切换；排除后只记为“已排除的应用”，不记名字）：")}
            </div>
            <div className="chips" style={{ marginTop: 4 }}>
              {all.map((a) => (
                <button
                  key={a}
                  className={`chip small-chip${excluded.has(a) ? " on" : ""}`}
                  onClick={() => save({ excluded_apps: excluded.has(a) ? s.excludedApps.filter((x) => x !== a) : [...s.excludedApps, a] })}
                >
                  {excluded.has(a) ? "✕ " : ""}
                  {a}
                </button>
              ))}
            </div>
          </>
        )
      ) : (
        (() => {
          const chosen = new Set(s.monitoredApps);
          // 已选的在前，然后是最近用过的，再是其他已安装的
          const pool = [...new Set([...s.monitoredApps, ...apps, ...installed])].filter((a) => !filter || a.toLowerCase().includes(filter.toLowerCase()));
          return (
            <>
              <div className="actions" style={{ marginTop: 8 }}>
                <span className="small muted">{tr("已选")} {s.monitoredApps.length} {tr("个")}</span>
                <input value={filter} placeholder={tr("搜索应用")} style={{ width: 160 }} onChange={(e) => setFilter(e.target.value)} />
              </div>
              <div className="chips app-pool" style={{ marginTop: 4 }}>
                {pool.map((a) => (
                  <button
                    key={a}
                    className={`chip small-chip${chosen.has(a) ? " on" : ""}`}
                    onClick={() => save({ monitored_apps: chosen.has(a) ? s.monitoredApps.filter((x) => x !== a) : [...s.monitoredApps, a] })}
                  >
                    {chosen.has(a) ? "✓ " : ""}
                    {a}
                  </button>
                ))}
              </div>
              {s.monitoredApps.length === 0 && <div className="error-text small">{tr("还没选应用，现在所有应用都会记为“其他应用”。")}</div>}
            </>
          );
        })()
      )}
      {(apps.length > 0 || sites.length > 0) && (
        <>
          <div className="small muted" style={{ marginTop: 12 }}>
            {tr("应用和网站归类（设了的在“按电脑记录生成”时直接按这个分类，不再问你；“看情况”的才问）：")}
          </div>
          <div className="rules">
            {[...apps.map((a) => `app:${a}`), ...sites.map((x) => `site:${x}`)].map((k) => (
              <label key={k} className="rule-row">
                <span className="rule-name">{k.startsWith("site:") ? `🌐 ${k.slice(5)}` : k.slice(4)}</span>
                <select
                  value={s.rules[k] ?? ""}
                  onChange={(e) => {
                    const next = { ...s.rules };
                    if (e.target.value) next[k] = e.target.value;
                    else delete next[k];
                    save({ rules: next });
                  }}
                >
                  <option value="">{tr("看情况")}</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {tr(c.name)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
