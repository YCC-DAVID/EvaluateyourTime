// 本地服务：API + 网页界面，只监听本机地址。
import "dotenv/config";
import express from "express";
import path from "node:path";
import { api } from "./api.ts";

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

app.listen(PORT, HOST, () => {
  console.log(`时间记录已启动：http://127.0.0.1:${PORT}`);
});
