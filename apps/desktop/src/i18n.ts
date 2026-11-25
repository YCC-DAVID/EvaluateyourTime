// 界面语言：中文（源文本）和英文。
// 用法：tr("记录 {0} 分钟", [n])。中文原文就是键，英文在 locales/en.json 里；找不到就显示中文。
// 切换语言会刷新页面（简单可靠，不用每个组件订阅语言变化）。
import en from "./locales/en.json";

export type Lang = "zh" | "en";
const KEY = "ui.lang";

function detect(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "zh" || v === "en") return v;
  } catch {
    /* 没有 localStorage（例如在服务端）时用中文 */
  }
  return "zh";
}

export const lang: Lang = typeof window === "undefined" ? "zh" : detect();
/** 日期、数字格式用的地区 */
export const locale = lang === "en" ? "en-US" : "zh-CN";

const dict: Record<string, string> = lang === "en" ? (en as Record<string, string>) : {};

export function tr(zh: string, args?: unknown[]): string {
  let s = dict[zh] ?? zh;
  if (args) s = s.replace(/\{(\d+)\}/g, (m, i) => (Number(i) < args.length ? String(args[Number(i)] ?? "") : m));
  return s;
}

/** 切换语言：记在本机，并告诉服务端（AI 回复也用这个语言），然后刷新 */
export async function setLang(next: Lang) {
  localStorage.setItem(KEY, next);
  await fetch("/api/settings/language", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ language: next }) }).catch(() => {});
  location.reload();
}
