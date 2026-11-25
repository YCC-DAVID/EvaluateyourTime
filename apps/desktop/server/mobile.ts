// 手机访问（同一个 WiFi 下）：
//  - 默认关闭。打开后另起两个监听：
//      https://<本机名>.local:5443  —— 手机用的聊天页和接口，必须带配对令牌
//      http://<局域网 IP>:5181/setup —— 只用来下载本地证书，不提供任何数据
//  - 证书：本机生成一个只属于你的根证书（私钥不离开这台 Mac），手机安装并信任一次。
//  - 配对：设置页生成 6 位配对码（10 分钟内有效、只能用一次、输错 5 次作废），手机换到设备令牌；令牌只存哈希，可随时撤销。
//  - 手机只能用对话需要的接口（对话、记录、目标、语音转写）；电脑使用数据、导出、日历、AI 设置等一律拒绝。
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { DATA_DIR, db, getSetting, newId, nowIso, setSetting } from "./db.ts";

export const HTTPS_PORT = Number(process.env.MOBILE_PORT || 5443);
export const SETUP_PORT = Number(process.env.MOBILE_SETUP_PORT || 5181);
const TLS_DIR = path.join(DATA_DIR, "tls");
const OPENSSL = fs.existsSync("/usr/bin/openssl") ? "/usr/bin/openssl" : "openssl";

db.exec(`
CREATE TABLE IF NOT EXISTS paired_devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, last_seen TEXT, revoked INTEGER NOT NULL DEFAULT 0);
`);

// ---------- 网络信息 ----------

export function localHostName(): string {
  try {
    return `${execFileSync("scutil", ["--get", "LocalHostName"], { encoding: "utf8" }).trim()}.local`;
  } catch {
    return `${os.hostname().replace(/\.local$/, "")}.local`;
  }
}
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) out.push(a.address);
  return out;
}

// ---------- 证书 ----------

const f = (n: string) => path.join(TLS_DIR, n);
function ssl(args: string[]) {
  execFileSync(OPENSSL, args, { cwd: TLS_DIR, stdio: "pipe" });
}
/** 根证书：第一次打开手机访问时生成，之后一直用同一个（手机只需信任一次） */
function ensureCA() {
  if (fs.existsSync(f("ca.crt")) && fs.existsSync(f("ca.key"))) return;
  fs.writeFileSync(
    f("ca.cnf"),
    `[req]
distinguished_name=dn
x509_extensions=v3_ca
prompt=no
[dn]
CN=Time Record Local CA (${os.hostname().replace(/[^\w.-]/g, "")})
O=time-evaluate-agent
[v3_ca]
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
`,
  );
  ssl(["req", "-x509", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "3650", "-keyout", "ca.key", "-out", "ca.crt", "-config", "ca.cnf"]);
  fs.chmodSync(f("ca.key"), 0o600);
}
/** 服务证书：本机名和局域网 IP 变了、或快到期时重新签（用同一个根证书，手机不用重新信任） */
function ensureServerCert() {
  const names = [localHostName(), "localhost"];
  const ips = [...lanAddresses(), "127.0.0.1"];
  const want = JSON.stringify({ names, ips });
  const metaPath = f("server.json");
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf8")) : null;
  const fresh = meta && meta.sans === want && Date.parse(meta.expires) - Date.now() > 30 * 86400_000 && fs.existsSync(f("server.crt"));
  if (fresh) return;
  fs.writeFileSync(
    f("server.ext"),
    `basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=${[...names.map((n) => `DNS:${n}`), ...ips.map((i) => `IP:${i}`)].join(",")}
`,
  );
  ssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", `/CN=${names[0]}`]);
  // iOS 要求服务证书有效期不超过 825 天
  ssl(["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.crt", "-days", "800", "-sha256", "-extfile", "server.ext"]);
  fs.chmodSync(f("server.key"), 0o600);
  fs.writeFileSync(metaPath, JSON.stringify({ sans: want, expires: new Date(Date.now() + 800 * 86400_000).toISOString() }));
}
export function ensureTLS() {
  fs.mkdirSync(TLS_DIR, { recursive: true, mode: 0o700 });
  ensureCA();
  ensureServerCert();
}
/** iPhone 描述文件：只包含根证书（公钥部分） */
function caMobileconfig(): string {
  const pem = fs.readFileSync(f("ca.crt"), "utf8");
  const der = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const uuid = (seed: string) => {
    const h = crypto.createHash("sha256").update(seed + der).digest("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`.toUpperCase();
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>PayloadContent</key><array><dict>
    <key>PayloadType</key><string>com.apple.security.root</string>
    <key>PayloadVersion</key><integer>1</integer>
    <key>PayloadIdentifier</key><string>com.time-evaluate-agent.ca.cert</string>
    <key>PayloadUUID</key><string>${uuid("cert")}</string>
    <key>PayloadDisplayName</key><string>时间记录本地证书</string>
    <key>PayloadContent</key><data>${der}</data>
  </dict></array>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadVersion</key><integer>1</integer>
  <key>PayloadIdentifier</key><string>com.time-evaluate-agent.ca</string>
  <key>PayloadUUID</key><string>${uuid("profile")}</string>
  <key>PayloadDisplayName</key><string>时间记录（家里 Mac 的本地证书）</string>
  <key>PayloadDescription</key><string>让 iPhone 信任你自己 Mac 上的时间记录服务。只用于同一个 WiFi 下访问这台 Mac。</string>
  <key>PayloadOrganization</key><string>time-evaluate-agent</string>
</dict></plist>
`;
}

// ---------- 配对与令牌 ----------

const hashToken = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
let pairing: { code: string; expires: number; attempts: number } | null = null;

export function newPairingCode() {
  pairing = { code: String(crypto.randomInt(0, 1_000_000)).padStart(6, "0"), expires: Date.now() + 10 * 60_000, attempts: 0 };
  return { code: pairing.code, expires: new Date(pairing.expires).toISOString() };
}
function pair(code: string, name: string): string {
  if (!pairing || Date.now() > pairing.expires) throw new MobileError(400, "配对码已过期：在 Mac 的“设置 › 手机”里重新生成");
  if (code !== pairing.code) {
    if (++pairing.attempts >= 5) pairing = null;
    throw new MobileError(400, pairing ? "配对码不对" : "输错太多次，配对码已作废：请在 Mac 上重新生成");
  }
  pairing = null;
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare(`INSERT INTO paired_devices (id,name,token_hash,created_at,last_seen) VALUES (?,?,?,?,?)`).run(
    newId("dev"),
    name.trim().slice(0, 40) || "iPhone",
    hashToken(token),
    nowIso(),
    nowIso(),
  );
  return token;
}
function deviceForToken(token: string) {
  const d = db.prepare(`SELECT id,name FROM paired_devices WHERE token_hash=? AND revoked=0`).get(hashToken(token)) as { id: string; name: string } | undefined;
  if (d) db.prepare(`UPDATE paired_devices SET last_seen=? WHERE id=?`).run(nowIso(), d.id);
  return d;
}
export function listDevices() {
  return db.prepare(`SELECT id,name,created_at,last_seen FROM paired_devices WHERE revoked=0 ORDER BY created_at DESC`).all();
}
export function revokeDevice(id: string) {
  db.prepare(`UPDATE paired_devices SET revoked=1 WHERE id=?`).run(id);
}

class MobileError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// ---------- 手机能用哪些接口 ----------

/** 对话需要的：对话、记录（建记录、评分、引导）、目标、语音转写、读 AI 设置 */
function phoneAllowed(method: string, p: string): boolean {
  if (/\/device(\/|-|$)|device-draft/.test(p)) return false; // 电脑使用数据不给手机
  if (p === "/version" || p === "/meta" || p.startsWith("/chat") || p.startsWith("/entries") || p.startsWith("/goals") || p === "/asr") return true;
  if (method === "GET" && (p === "/ai/settings" || p === "/ai/catalog")) return true;
  return false;
}

function guard(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith("/api/")) {
    // 页面只给手机版（以及它的静态资源）
    if (/^\/(apple-touch-icon(-precomposed)?|favicon)\.png$/.test(req.path) || req.path === "/m" || req.path.startsWith("/m/") || req.path.startsWith("/assets/") || req.path.startsWith("/@") || req.path.startsWith("/node_modules/") || req.path.startsWith("/src/") || req.path.startsWith("/modules/"))
      return next();
    return res.redirect("/m/");
  }
  const p = req.path.slice(4);
  if (p === "/mobile/ping") return res.json({ ok: true, at: nowIso() });
  if (p === "/mobile/pair" && req.method === "POST") {
    try {
      return res.json({ token: pair(String(req.body?.code ?? "").trim(), String(req.body?.name ?? "")) });
    } catch (e) {
      return res.status(e instanceof MobileError ? e.status : 500).json({ error: (e as Error).message });
    }
  }
  const token = /^Bearer (.+)$/.exec(req.get("authorization") ?? "")?.[1];
  const dev = token ? deviceForToken(token) : undefined;
  if (!dev) return res.status(401).json({ error: "这台手机还没配对，或配对已被撤销", unpaired: true });
  if (!phoneAllowed(req.method, p)) return res.status(403).json({ error: "手机端不能使用这个功能" });
  next();
}

// ---------- 开关与监听 ----------

let servers: { https: https.Server; setup: http.Server } | null = null;
let lastError: string | null = null;
let mainApp: express.Express | null = null;

export const mobileEnabled = () => getSetting<boolean>("mobile_enabled", false);

function setupPage(host: string) {
  const url = `https://${host}:${HTTPS_PORT}/m/`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>时间记录 · 手机设置</title>
<style>body{font:16px -apple-system,sans-serif;max-width:560px;margin:24px auto;padding:0 18px;color:#1d2433;line-height:1.6}
a.btn{display:inline-block;background:#3b6cf6;color:#fff;padding:10px 16px;border-radius:10px;text-decoration:none;margin:6px 0}
ol li{margin:8px 0}.muted{color:#6b7280;font-size:14px}code{background:#f1f3f7;padding:1px 5px;border-radius:4px}</style></head><body>
<h2>在 iPhone 上用时间记录</h2>
<p class="muted">这个页面只用来装证书，不包含任何记录。请用 <b>Safari</b> 打开。</p>
<ol>
<li><a class="btn" href="/ca.mobileconfig">下载本地证书</a><br><span class="muted">提示“此网站正尝试下载一个配置描述文件”时点“允许”。</span></li>
<li>打开 iPhone 的 <b>设置 › 通用 › VPN 与设备管理</b>（或设置首页顶部的“已下载描述文件”），点“时间记录”，安装。</li>
<li>打开 <b>设置 › 通用 › 关于本机 › 证书信任设置</b>，打开“Time Record Local CA”的开关。</li>
<li><a class="btn" href="${url}">打开聊天页</a><br><span class="muted">在 Safari 里点分享按钮 › <b>添加到主屏幕</b>，以后从主屏幕打开。</span></li>
<li>从主屏幕打开后，输入 Mac 上“设置 › 手机”显示的 6 位配对码。</li>
</ol>
<p class="muted">证书只让手机信任你这台 Mac；私钥留在 Mac 上。不想用了可以在“VPN 与设备管理”里删除描述文件。</p>
</body></html>`;
}

function start() {
  if (servers || !mainApp) return;
  try {
    ensureTLS();
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use(guard);
    app.use(mainApp);
    const hs = https.createServer({ key: fs.readFileSync(f("server.key")), cert: fs.readFileSync(f("server.crt")) }, app);
    const setupApp = express();
    setupApp.get("/ca.mobileconfig", (_req, res) => {
      res.setHeader("Content-Type", "application/x-apple-aspen-config");
      res.setHeader("Content-Disposition", 'attachment; filename="time-record.mobileconfig"');
      res.send(caMobileconfig());
    });
    setupApp.use((_req, res) => res.type("html").send(setupPage(localHostName())));
    const onErr = (e: NodeJS.ErrnoException) => {
      lastError = e.code === "EADDRINUSE" ? `端口 ${e.message.match(/:(\d+)/)?.[1] ?? ""} 被占用` : e.message;
      console.error("手机访问启动失败：", lastError);
      stop();
    };
    hs.on("error", onErr);
    const ss = http.createServer(setupApp);
    ss.on("error", onErr);
    hs.listen(HTTPS_PORT, "0.0.0.0");
    ss.listen(SETUP_PORT, "0.0.0.0");
    servers = { https: hs, setup: ss };
    lastError = null;
    console.log(`手机访问已打开：https://${localHostName()}:${HTTPS_PORT}/m/`);
  } catch (e) {
    lastError = (e as Error).message;
    console.error("手机访问启动失败：", lastError);
  }
}
function stop() {
  servers?.https.close();
  servers?.setup.close();
  servers = null;
}

/** 服务启动时调用：传入主应用（接口 + 页面），按设置决定是否打开 */
export function initMobile(app: express.Express) {
  mainApp = app;
  if (mobileEnabled()) start();
}
export function setMobileEnabled(on: boolean) {
  setSetting("mobile_enabled", on);
  if (on) start();
  else stop();
}
export function mobileStatus() {
  const host = localHostName();
  const ips = lanAddresses();
  return {
    enabled: mobileEnabled(),
    running: !!servers,
    error: lastError,
    host,
    ips,
    url: `https://${host}:${HTTPS_PORT}/m/`,
    setupUrl: ips[0] ? `http://${ips[0]}:${SETUP_PORT}/setup` : null,
    pairing: pairing && Date.now() < pairing.expires ? { code: pairing.code, expires: new Date(pairing.expires).toISOString() } : null,
    devices: listDevices(),
  };
}
