#!/usr/bin/env node
// 开机自启（macOS launchd 登录项）
//   npm run autostart:install    安装或更新：构建界面 → 同步程序到“应用支持”目录 → 首次迁移数据 → 注册并启动
//   npm run autostart:status     看运行状态
//   npm run autostart:stop       停止（下次登录还会启动）；要在终端里调试时用
//   npm run autostart:start      启动
//   npm run autostart:uninstall  取消开机自启（数据保留）
// 为什么不直接从桌面运行：macOS 不允许后台登录项读写“桌面”文件夹。
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LABEL = "com.time-evaluate-agent.server";
const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = os.homedir();
const BASE = path.join(HOME, "Library", "Application Support", "time-evaluate-agent");
const APP = path.join(BASE, "app");
const DATA = path.join(BASE, "data");
const LOGS = path.join(BASE, "logs");
const PLIST = path.join(HOME, "Library", "LaunchAgents", `${LABEL}.plist`);
const UID = process.getuid();
const DOMAIN = `gui/${UID}`;
const PORT = 5180;

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const quiet = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });
const step = (s) => console.log(`\n▸ ${s}`);

function nodePath() {
  // 用 Homebrew 的稳定链接，升级 node 后不会失效
  for (const p of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) if (fs.existsSync(p)) return p;
  return process.execPath;
}

function portInUseBy() {
  const r = quiet("lsof", ["-tiTCP:" + PORT, "-sTCP:LISTEN"]);
  return r.stdout.trim().split("\n").filter(Boolean);
}

function loaded() {
  return quiet("launchctl", ["print", `${DOMAIN}/${LABEL}`]).status === 0;
}

function plist() {
  const pathEnv = [path.join(HOME, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(nodePath())}</string>
    <string>${esc(path.join(APP, "node_modules", "tsx", "dist", "cli.mjs"))}</string>
    <string>${esc(path.join(APP, "apps", "desktop", "server", "index.ts"))}</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(APP)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key><string>production</string>
    <key>DATA_DIR</key><string>${esc(DATA)}</string>
    <key>PORT</key><string>${PORT}</string>
    <key>PATH</key><string>${esc(pathEnv)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${esc(path.join(LOGS, "server.log"))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(LOGS, "server.log"))}</string>
</dict>
</plist>
`;
}

const cmdOf = (pid) => quiet("ps", ["-o", "command=", "-p", String(pid)]).stdout.trim();
const ppidOf = (pid) => Number(quiet("ps", ["-o", "ppid=", "-p", String(pid)]).stdout.trim()) || 0;

/**
 * 端口被占用时：如果占着的是这个项目自己的开发服务（npm run dev / tsx watch），先把它停掉；
 * 是别的程序就报错，不动它。
 */
async function stopProjectDevServer(pids) {
  const ours = (c) => c.includes(PROJECT) && /apps\/desktop\/server\/index\.ts|tsx/.test(c);
  for (const pid of pids) {
    if (!ours(cmdOf(pid))) {
      throw new Error(`端口 ${PORT} 被别的程序占用（pid ${pid}：${cmdOf(pid).slice(0, 80)}），请先关掉它再安装。`);
    }
  }
  step("停掉终端里正在运行的开发服务（npm run dev），由后台服务接替");
  for (const pid of pids) {
    // 一并停掉外层的 tsx watch 和 npm run dev，免得它们把服务又拉起来
    const chain = [pid];
    for (let p = ppidOf(pid), i = 0; p > 1 && i < 3; p = ppidOf(p), i++) {
      const c = cmdOf(p);
      if (c.includes(PROJECT) || /npm run dev|tsx watch/.test(c)) chain.push(p);
      else break;
    }
    for (const p of chain.reverse()) quiet("kill", [String(p)]);
  }
  for (let i = 0; i < 20 && portInUseBy().length; i++) await new Promise((r) => setTimeout(r, 300));
  if (portInUseBy().length) throw new Error(`没能停掉占用端口 ${PORT} 的开发服务，请在运行 npm run dev 的终端里按 Control+C 后再试。`);
}

async function waitUp(seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/meta`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function install() {
  if (process.platform !== "darwin") throw new Error("开机自启目前只支持 macOS");
  const others = portInUseBy();
  if (others.length && !loaded()) await stopProjectDevServer(others);

  step("构建界面");
  run(path.join(PROJECT, "node_modules", ".bin", "vite"), ["build"], { cwd: PROJECT });

  step("编译时间记录助手（读日历、读写提醒事项）");
  try {
    run(process.execPath, [path.join(PROJECT, "scripts", "build-helper.mjs")], { cwd: PROJECT });
  } catch {
    console.log("  助手编译失败（需要 Xcode 命令行工具），日历和提醒事项功能暂时不可用");
  }

  step(`同步程序到 ${APP}`);
  fs.mkdirSync(APP, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(LOGS, { recursive: true });
  const items = ["package.json", "package-lock.json", "tsconfig.json", "vite.config.ts", "apps", "modules", "dist", "node_modules", ".env"].filter((f) =>
    fs.existsSync(path.join(PROJECT, f)),
  );
  run("rsync", ["-a", "--delete", ...items.map((f) => path.join(PROJECT, f) + (fs.statSync(path.join(PROJECT, f)).isDirectory() ? "" : "")), APP + "/"]);

  if (!fs.existsSync(path.join(DATA, "app.db"))) {
    const src = path.join(PROJECT, "data", "app.db");
    if (fs.existsSync(src)) {
      step("迁移数据（SQLite 在线备份，桌面上的原数据保留不动）");
      run("sqlite3", [src, `.backup '${path.join(DATA, "app.db").replace(/'/g, "''")}'`]);
      const dev = path.join(PROJECT, "data", "device.json");
      if (fs.existsSync(dev)) fs.copyFileSync(dev, path.join(DATA, "device.json"));
    }
  }

  step("注册登录项并启动");
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.writeFileSync(PLIST, plist());
  if (loaded()) {
    quiet("launchctl", ["bootout", `${DOMAIN}/${LABEL}`]);
    // bootout 是异步的：等旧服务完全退出，否则 bootstrap 会报 Input/output error
    for (let i = 0; i < 40 && (loaded() || portInUseBy().length); i++) await new Promise((r) => setTimeout(r, 250));
  }
  let ok = false;
  for (let i = 0; i < 5 && !ok; i++) {
    ok = quiet("launchctl", ["bootstrap", DOMAIN, PLIST]).status === 0 || loaded();
    if (!ok) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ok) throw new Error("launchctl bootstrap 失败；可以稍后再运行一次 npm run autostart:install");
  quiet("launchctl", ["enable", `${DOMAIN}/${LABEL}`]);
  if (await waitUp()) console.log(`\n✓ 已在后台运行：http://127.0.0.1:${PORT}\n  数据：${DATA}\n  日志：${path.join(LOGS, "server.log")}`);
  else console.log(`\n✗ 启动后没有响应，看日志：${path.join(LOGS, "server.log")}`);
}

async function status() {
  const p = quiet("launchctl", ["print", `${DOMAIN}/${LABEL}`]);
  if (p.status !== 0) return console.log("未安装开机自启（运行 npm run autostart:install）");
  const state = /state = (\S+)/.exec(p.stdout)?.[1];
  const pid = /pid = (\d+)/.exec(p.stdout)?.[1];
  console.log(`开机自启：已安装 · 状态 ${state ?? "未知"}${pid ? ` · pid ${pid}` : ""}`);
  try {
    const s = await (await fetch(`http://127.0.0.1:${PORT}/api/device/status`)).json();
    console.log(`服务：http://127.0.0.1:${PORT} 正常 · 电脑采集${s.enabled ? "开启" : "暂停"}${s.lastSample ? ` · 最近：${s.lastSample.app}` : ""}${s.lastError ? ` · 错误：${s.lastError}` : ""}`);
  } catch {
    console.log("服务：没有响应");
  }
  console.log(`数据：${DATA}\n日志：${path.join(LOGS, "server.log")}`);
}

const cmd = process.argv[2];
try {
  if (cmd === "install") await install();
  else if (cmd === "status") await status();
  else if (cmd === "stop") {
    quiet("launchctl", ["bootout", `${DOMAIN}/${LABEL}`]);
    console.log("已停止（下次登录会再启动；现在要启动运行 npm run autostart:start）");
  } else if (cmd === "start") {
    if (!fs.existsSync(PLIST)) throw new Error("还没安装，先运行 npm run autostart:install");
    if (!loaded()) run("launchctl", ["bootstrap", DOMAIN, PLIST]);
    console.log((await waitUp()) ? `✓ 已启动：http://127.0.0.1:${PORT}` : "✗ 没有响应，看日志");
  } else if (cmd === "uninstall") {
    quiet("launchctl", ["bootout", `${DOMAIN}/${LABEL}`]);
    if (fs.existsSync(PLIST)) fs.unlinkSync(PLIST);
    console.log(`已取消开机自启。数据保留在 ${DATA}`);
  } else console.log("用法：node scripts/autostart.mjs install|status|start|stop|uninstall");
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
}
