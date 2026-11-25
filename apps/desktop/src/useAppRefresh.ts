import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";

// 程序坞 / 主屏幕上的网页应用没有地址栏和刷新按钮，这里自己处理：
//  - 窗口回到前台时调用 onFocus（重新取数据）
//  - 回到前台和每分钟检查一次页面版本；服务更新过就返回 true，由界面提示“点此刷新”（不自动刷新，免得丢掉正在输入的内容）
export function useAppRefresh(onFocus: () => void): boolean {
  const [updated, setUpdated] = useState(false);
  const first = useRef<string | null>(null);
  const focusRef = useRef(onFocus);
  focusRef.current = onFocus;
  useEffect(() => {
    const check = () =>
      api
        .version()
        .then(({ build }) => {
          if (first.current == null) first.current = build;
          else if (build !== first.current) setUpdated(true);
        })
        .catch(() => {});
    const wake = () => {
      if (document.visibilityState !== "visible") return;
      focusRef.current();
      check();
    };
    check();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    const t = setInterval(check, 60_000);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      clearInterval(t);
    };
  }, []);
  return updated;
}
