// 本地服务：API + 网页界面，只监听本机地址。
import "dotenv/config";
import express from "express";
import path from "node:path";
import { api } from "./api.ts";
import { startWatcher } from "./device.ts";
import { DATA_DIR } from "./db.ts";

const PORT = Number(process.env.PORT || 5180);
const HOST = "127.0.0.1"; // 不暴露到局域网或公网

const app = express();
app.use("/api", api);

if (process.env.NODE_ENV === "production") {
  const dist = path.resolve("dist");
  app.use(express.static(dist));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({ configFile: path.resolve("vite.config.ts"), server: { middlewareMode: true }, appType: "spa" });
  app.use(vite.middlewares);
}

const server = app.listen(PORT, HOST, () => {
  console.log(`时间记录已启动：http://127.0.0.1:${PORT}（数据：${DATA_DIR}）`);
  // 端口拿到了才开始采集：同一时间只有一个服务在记录电脑使用
  startWatcher();
});
server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") {
    console.error(`端口 ${PORT} 已被占用。如果装了开机自启，服务已经在后台运行：直接打开 http://127.0.0.1:${PORT}`);
    console.error("要在终端里调试，先运行 npm run autostart:stop");
    process.exit(1);
  }
  throw e;
});
