import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "apps/desktop",
  plugins: [react()],
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    // 两个页面：电脑版（/）和手机聊天版（/m/）
    rollupOptions: { input: { main: "apps/desktop/index.html", mobile: "apps/desktop/m/index.html" } },
  },
});
