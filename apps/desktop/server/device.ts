// 电脑使用参照：前台应用 + 键鼠空闲（+ 可选的网站 / 窗口标题）。
//  - 内置采集（macOS）：每 5 秒读一次前台应用（lsappinfo）和空闲时长（ioreg），合并成时间段存进本地数据库。
//    不需要额外权限。
//  - 细节（设置里打开，默认关闭）：浏览器当前标签页的网站域名（需要“自动化”权限），
//    其他应用的窗口标题（需要“辅助功能”权限）。没授权时自动退回只记应用名。
//  隐私：只记到“应用 / 网站域名 / 窗口标题”这一层，不记页面标题、网址路径和页面内容；
//    原始记录只在本机数据库，不进导出、不同步；发给 AI 的只有按时段汇总的分钟数（可关闭）。
//  - ActivityWatch：如果本机 5600 端口有 ActivityWatch 在运行，优先用它的数据。
// 这些数据只作参照：前台开着不等于专注，离开键鼠也可能是在思考或纸上推导。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db, newId, getSetting } from "./db.ts";

const exec = promisify(execFile);

db.exec(`
CREATE TABLE IF NOT EXISTS device_spans (
  id TEXT PRIMARY KEY, start_utc TEXT NOT NULL, end_utc TEXT NOT NULL,
  app TEXT NOT NULL, afk INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'builtin');
CREATE INDEX IF NOT EXISTS idx_device_time ON device_spans(start_utc, end_utc);
`);
for (const col of ["detail", "title"]) {
  const cols = db.prepare(`PRAGMA table_info(device_spans)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE device_spans ADD COLUMN ${col} TEXT`);
}
// 早期版本存过页面标题：清掉，不再保留具体内容
db.exec(`UPDATE device_spans SET title=NULL WHERE title IS NOT NULL`);

export interface DeviceSettings {
  enabled: boolean;
  /** 记录浏览器网站和窗口标题（需要系统授权） */
  detail: boolean;
  /** all：记录所有应用（可排除）；only：只记录 monitoredApps 里的应用，其他记为“其他应用” */
  mode: "all" | "only";
  monitoredApps: string[];
  /** 归类规则：key 为 "app:应用名" 或 "site:域名"，值为分类 ID */
  rules: Record<string, string>;
  excludedApps: string[];
  excludedSites: string[];
  sendToAI: boolean;
  afkSeconds: number;
}

export function deviceSettings(): DeviceSettings {
  return {
    enabled: getSetting("device_enabled", true),
    detail: getSetting("device_detail", false),
    mode: getSetting<"all" | "only">("device_mode", "all"),
    monitoredApps: getSetting<string[]>("device_monitored_apps", []),
    rules: getSetting<Record<string, string>>("device_rules", {}),
    excludedApps: getSetting<string[]>("device_excluded_apps", []),
    excludedSites: getSetting<string[]>("device_excluded_sites", []),
    sendToAI: getSetting("device_send_to_ai", true),
    afkSeconds: getSetting("device_afk_seconds", 180),
  };
}

const TICK_MS = 5000;
// 两次采样之间超过这个间隔（例如电脑睡眠、服务没开），就不把时间段接上
const GAP_MS = 30_000;

let current: { id: string; key: string; afk: boolean; start: number; end: number } | null = null;
let lastError: string | null = null;
let detailError: string | null = null;
let lastSample: { at: number; app: string; detail: string | null; afk: boolean } | null = null;

async function frontApp(): Promise<string> {
  const { stdout: asn } = await exec("lsappinfo", ["front"]);
  const { stdout } = await exec("lsappinfo", ["info", "-only", "name", asn.trim()]);
  const m = /"LSDisplayName"="([^"]*)"/.exec(stdout);
  return m?.[1] || "未知应用";
}

async function idleSeconds(): Promise<number> {
  const { stdout } = await exec("ioreg", ["-c", "IOHIDSystem", "-d", "4"], { maxBuffer: 4 * 1024 * 1024 });
  const m = /"HIDIdleTime" = (\d+)/.exec(stdout);
  return m ? Number(m[1]) / 1e9 : 0;
}

// ---------- 细节：网站 / 窗口标题 ----------

const BROWSERS: Record<string, "chromium" | "safari"> = {
  "Google Chrome": "chromium",
  "Microsoft Edge": "chromium",
  "Brave Browser": "chromium",
  Arc: "chromium",
  Safari: "safari",
};

/** 把子域名并到主域名：search.bilibili.com → bilibili.com，news.bbc.co.uk → bbc.co.uk；IP 和 localhost 原样保留 */
export function siteOf(raw: string): string {
  const host = raw.replace(/^www\./, "");
  if (/^[\d.]+$/.test(host) || !host.includes(".")) return host;
  const parts = host.split(".");
  const n = parts.length;
  // 类似 co.uk、com.cn 这种二级后缀，多保留一段
  const twoLevel = n >= 3 && parts[n - 1].length === 2 && ["co", "com", "net", "org", "edu", "gov", "ac"].includes(parts[n - 2]);
  const site = parts.slice(twoLevel ? -3 : -2).join(".");
  // 一个域名下有多种不同用途的产品（邮箱、文档、学术搜索……）：保留产品这一级
  if (MULTI_PRODUCT.has(site) && n > (twoLevel ? 3 : 2)) return parts.slice(twoLevel ? -4 : -3).join(".");
  return site;
}
const MULTI_PRODUCT = new Set(["google.com", "microsoft.com", "qq.com", "baidu.com", "apple.com"]);

/** 权限被拒后暂停这一类读取一段时间，免得每 5 秒报错一次 */
const backoff = new Map<string, number>();

async function osa(script: string): Promise<string> {
  const { stdout } = await exec("osascript", ["-e", script], { timeout: 2000 });
  return stdout.trim();
}

function permissionHint(kind: "browser" | "window", app: string, e: Error): string {
  const msg = e.message;
  if (kind === "browser" && /-1743|Not authori[sz]ed|不允许/.test(msg))
    return `没有读取 ${app} 标签页的权限：在“系统设置 › 隐私与安全性 › 自动化”里，允许运行本服务的终端控制 ${app}`;
  if (kind === "window" && /-1719|-25211|assistive|辅助/.test(msg))
    return "没有读取窗口标题的权限：在“系统设置 › 隐私与安全性 › 辅助功能”里，允许运行本服务的终端";
  return `读取${kind === "browser" ? "标签页" : "窗口标题"}失败：${msg.split("\n")[0].slice(0, 120)}`;
}

/** 返回 { detail, title }：浏览器为网站域名 + 页面标题；其他应用为窗口标题 */
async function readDetail(app: string): Promise<{ detail: string | null; title: string | null }> {
  const kind = BROWSERS[app] ? "browser" : "window";
  const bkey = `${kind}:${kind === "browser" ? app : ""}`;
  if ((backoff.get(bkey) ?? 0) > Date.now()) return { detail: null, title: null };
  try {
    if (kind === "browser") {
      const script =
        BROWSERS[app] === "safari"
          ? `tell application "Safari" to if (count of windows) > 0 then return URL of current tab of front window`
          : `tell application "${app}" to if (count of windows) > 0 then return URL of active tab of front window`;
      // 只取网址里的域名，路径、参数和页面标题都不保留
      const url = await osa(script);
      let host: string | null = null;
      try {
        const u = new URL(url);
        host = u.protocol.startsWith("http") ? siteOf(u.hostname) : u.protocol.replace(":", "");
      } catch {
        host = null;
      }
      detailError = null;
      return { detail: host, title: null };
    }
    const title = await osa(
      `tell application "System Events" to tell (first process whose frontmost is true) to if (count of windows) > 0 then return name of front window`,
    );
    detailError = null;
    return { detail: title.slice(0, 80) || null, title: null };
  } catch (e) {
    detailError = permissionHint(kind, app, e as Error);
    backoff.set(bkey, Date.now() + 60_000);
    return { detail: null, title: null };
  }
}

async function tick() {
  const s = deviceSettings();
  if (!s.enabled) {
    current = null;
    return;
  }
  try {
    const [appRaw, idle] = await Promise.all([frontApp(), idleSeconds()]);
    const afk = idle >= s.afkSeconds;
    const excludedApp = s.mode === "only" ? !s.monitoredApps.includes(appRaw) : s.excludedApps.includes(appRaw);
    const app = afk ? "（离开键鼠）" : excludedApp ? (s.mode === "only" ? "（其他应用）" : "（已排除的应用）") : appRaw;
    let detail: string | null = null;
    let title: string | null = null;
    if (!afk && !excludedApp && s.detail) {
      ({ detail, title } = await readDetail(appRaw));
      if (detail && BROWSERS[appRaw] && s.excludedSites.some((x) => detail === x || detail!.endsWith(`.${x}`))) {
        detail = "（已排除的网站）";
        title = null;
      }
    }
    const now = Date.now();
    lastSample = { at: now, app, detail, afk };
    lastError = null;
    const key = `${app}\u0000${detail ?? ""}`;
    if (current && current.key === key && current.afk === afk && now - current.end < GAP_MS) {
      current.end = now;
      db.prepare(`UPDATE device_spans SET end_utc=?, title=COALESCE(?, title) WHERE id=?`).run(new Date(now).toISOString(), title, current.id);
      return;
    }
    let start = now;
    if (current && now - current.end < GAP_MS) {
      // 新的一段从上一段结束处接上，避免缝隙；刚进入“离开”时，离开从键鼠最后一次活动算起
      start = afk && !current.afk ? Math.max(current.start, now - Math.round(idle * 1000)) : current.end;
      db.prepare(`UPDATE device_spans SET end_utc=? WHERE id=?`).run(new Date(start).toISOString(), current.id);
    }
    const id = newId("dev");
    db.prepare(`INSERT INTO device_spans (id,start_utc,end_utc,app,afk,source,detail,title) VALUES (?,?,?,?,?,'builtin',?,?)`).run(
      id,
      new Date(start).toISOString(),
      new Date(now).toISOString(),
      app,
      afk ? 1 : 0,
      detail,
      title,
    );
    current = { id, key, afk, start, end: now };
  } catch (e) {
    lastError = (e as Error).message;
  }
}

let timer: NodeJS.Timeout | null = null;
export function startWatcher() {
  if (process.platform !== "darwin" || timer) return;
  timer = setInterval(tick, TICK_MS);
  tick();
}

// ---------- ActivityWatch ----------

const AW = process.env.ACTIVITYWATCH_URL || "http://127.0.0.1:5600";

async function awAvailable(): Promise<boolean> {
  try {
    const r = await fetch(`${AW}/api/0/info`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}

interface Span {
  start: number;
  end: number;
  app: string;
  detail: string | null;
  afk: boolean;
}

async function awSpans(start: number, end: number): Promise<Span[]> {
  const buckets = (await (await fetch(`${AW}/api/0/buckets`)).json()) as Record<string, { id: string }>;
  const ids = Object.keys(buckets);
  const q = `start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}&limit=-1`;
  const events = async (id: string) =>
    (await (await fetch(`${AW}/api/0/buckets/${encodeURIComponent(id)}/events?${q}`)).json()) as {
      timestamp: string;
      duration: number;
      data: Record<string, string>;
    }[];
  const out: Span[] = [];
  const win = ids.find((i) => i.startsWith("aw-watcher-window"));
  const afk = ids.find((i) => i.startsWith("aw-watcher-afk"));
  const s = deviceSettings();
  if (win)
    for (const ev of await events(win)) {
      const t = Date.parse(ev.timestamp);
      const app = ev.data.app ?? "未知应用";
      const excluded = s.mode === "only" ? !s.monitoredApps.includes(app) : s.excludedApps.includes(app);
      out.push({
        start: t,
        end: t + ev.duration * 1000,
        app: excluded ? (s.mode === "only" ? "（其他应用）" : "（已排除的应用）") : app,
        detail: excluded || !s.detail ? null : (ev.data.title ?? null),
        afk: false,
      });
    }
  if (afk)
    for (const ev of await events(afk))
      if (ev.data.status === "afk") {
        const t = Date.parse(ev.timestamp);
        out.push({ start: t, end: t + ev.duration * 1000, app: "（离开键鼠）", detail: null, afk: true });
      }
  return out;
}

function builtinSpans(start: number, end: number): Span[] {
  return (
    db
      .prepare(`SELECT start_utc,end_utc,app,afk,detail FROM device_spans WHERE start_utc < ? AND end_utc > ? ORDER BY start_utc`)
      .all(new Date(end).toISOString(), new Date(start).toISOString()) as {
      start_utc: string;
      end_utc: string;
      app: string;
      afk: number;
      detail: string | null;
    }[]
  ).map((r) => ({
    start: Date.parse(r.start_utc),
    end: Date.parse(r.end_utc),
    app: r.app,
    // 旧数据里可能有子域名，汇总时并到主域名
    detail: r.detail && BROWSERS[r.app] && !r.detail.startsWith("（") ? siteOf(r.detail) : r.detail,
    afk: !!r.afk,
  }));
}

export interface DeviceSummary {
  source: "activitywatch" | "builtin" | "none";
  rangeMinutes: number;
  /** 有采集数据覆盖的分钟数（服务没开、电脑睡眠时没有数据） */
  coveredMinutes: number;
  afkMinutes: number;
  /** 按应用合计；details 是该应用里按网站 / 窗口标题的细分（开启细节记录后才有） */
  apps: { app: string; minutes: number; details: { label: string; minutes: number }[] }[];
}

/** 某个时间段内的电脑使用摘要：按应用（以及网站 / 窗口）合计的前台分钟数，离开键鼠单独算 */
export async function deviceSummary(start: number, end: number): Promise<DeviceSummary> {
  const useAW = await awAvailable();
  const spans = useAW ? await awSpans(start, end).catch(() => builtinSpans(start, end)) : builtinSpans(start, end);
  const clip = (s: Span) => Math.max(0, Math.min(s.end, end) - Math.max(s.start, start));
  // 离开键鼠优先：被离开时段覆盖的前台时间不再计入应用
  const afkSpans = spans.filter((s) => s.afk);
  const afkMs = afkSpans.reduce((a, s) => a + clip(s), 0);
  const byApp = new Map<string, { ms: number; details: Map<string, number> }>();
  for (const s of spans) {
    if (s.afk) continue;
    let ms = clip(s);
    for (const a of afkSpans) ms -= Math.max(0, Math.min(s.end, a.end, end) - Math.max(s.start, a.start, start));
    if (ms <= 0) continue;
    const e = byApp.get(s.app) ?? { ms: 0, details: new Map<string, number>() };
    e.ms += ms;
    if (s.detail) e.details.set(s.detail, (e.details.get(s.detail) ?? 0) + ms);
    byApp.set(s.app, e);
  }
  const appsMs = [...byApp.values()].reduce((a, b) => a + b.ms, 0);
  const apps = [...byApp.entries()]
    .map(([app, v]) => ({
      app,
      minutes: Math.round(v.ms / 60000),
      details: [...v.details.entries()]
        .map(([label, ms]) => ({ label, minutes: Math.round(ms / 60000) }))
        .filter((d) => d.minutes > 0)
        .sort((a, b) => b.minutes - a.minutes),
    }))
    .filter((a) => a.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes);
  return {
    source: spans.length === 0 ? "none" : useAW ? "activitywatch" : "builtin",
    rangeMinutes: Math.round((end - start) / 60000),
    coveredMinutes: Math.round(Math.min(end - start, appsMs + afkMs) / 60000),
    afkMinutes: Math.round(afkMs / 60000),
    apps,
  };
}

/** 一个应用的文字描述，例如“Google Chrome 50 分钟（overleaf.com 35、youtube.com 15）” */
export function appLine(a: DeviceSummary["apps"][number], maxDetails = 3): string {
  const d = a.details.slice(0, maxDetails).map((x) => `${x.label} ${x.minutes}`);
  return `${a.app} ${a.minutes} 分钟${d.length ? `（${d.join("、")}）` : ""}`;
}

/** 给 AI 的一行文字；没有数据或用户关闭“发给 AI”时返回 null */
export function summaryForAI(s: DeviceSummary): string | null {
  if (!deviceSettings().sendToAI || s.source === "none" || s.coveredMinutes === 0) return null;
  const top = s.apps.slice(0, 6).map((a) => appLine(a)).join("、");
  return `电脑使用参照（${s.source === "activitywatch" ? "ActivityWatch" : "内置采集"}，覆盖 ${s.coveredMinutes}/${s.rangeMinutes} 分钟）：前台 ${top || "无"}；离开键鼠 ${s.afkMinutes} 分钟。只作参照：前台开着不等于专注（同一个浏览器里可能是写论文也可能是看视频），离开键鼠也可能在思考、看纸质材料或开会；手机使用不在其中。`;
}

export async function deviceStatus() {
  const s = deviceSettings();
  return {
    platform: process.platform,
    supported: process.platform === "darwin",
    enabled: s.enabled,
    activitywatch: await awAvailable(),
    lastSample,
    lastError,
    detailError: s.detail ? detailError : null,
    settings: s,
  };
}
