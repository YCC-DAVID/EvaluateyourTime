import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MobileApp } from "./MobileApp.tsx";
import "../styles.css";
import "./mobile.css";

// 离线外壳：只在 https 下可用（手机访问走本地证书的 https）
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("/m/sw.js", { scope: "/m/" }).catch(() => {});
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MobileApp />
  </StrictMode>,
);
