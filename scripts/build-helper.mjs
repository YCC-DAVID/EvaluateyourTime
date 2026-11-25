#!/usr/bin/env node
// 编译“时间记录助手”（读日历、读写提醒事项的小应用），放到“应用支持”目录，开发版和开机自启共用。
//   npm run helper:build
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(os.homedir(), "Library", "Application Support", "time-evaluate-agent", "TimeAgentHelper.app");
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.time-evaluate-agent.helper</string>
  <key>CFBundleName</key><string>时间记录助手</string>
  <key>CFBundleDisplayName</key><string>时间记录助手</string>
  <key>CFBundleExecutable</key><string>TimeAgentHelper</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSCalendarsFullAccessUsageDescription</key><string>读取你选中的日历里的日程，显示在时间记录的热力图和时间轴上，并关联到目标。数据只在本机使用。</string>
  <key>NSCalendarsUsageDescription</key><string>读取你选中的日历里的日程，显示在时间记录里。</string>
  <key>NSRemindersFullAccessUsageDescription</key><string>把你选中的提醒事项列表和时间记录里的目标双向同步（标题、截止日、完成状态）。</string>
  <key>NSRemindersUsageDescription</key><string>和时间记录里的目标同步待办。</string>
</dict></plist>
`;

if (process.platform !== "darwin") {
  console.log("只在 macOS 上需要");
  process.exit(0);
}
fs.mkdirSync(path.join(APP, "Contents", "MacOS"), { recursive: true });
fs.writeFileSync(path.join(APP, "Contents", "Info.plist"), plist);
console.log("▸ 编译时间记录助手…");
execFileSync(
  "swiftc",
  ["-O", path.join(PROJECT, "apps", "helper", "main.swift"), "-o", path.join(APP, "Contents", "MacOS", "TimeAgentHelper"), "-framework", "EventKit"],
  { stdio: "inherit" },
);
// 本地签名，系统才能记住授权
execFileSync("codesign", ["--force", "--sign", "-", APP], { stdio: "inherit" });
console.log(`✓ 已生成 ${APP}`);
