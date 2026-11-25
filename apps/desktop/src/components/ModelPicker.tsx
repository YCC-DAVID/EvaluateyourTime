import { useEffect, useMemo, useRef, useState } from "react";
import { tr } from "../i18n.ts";

// 模型 / 强度选择，像常见 chatbot 的输入框那样：左边选来源，中间选模型，右边选思考强度。
// 顶栏和对话输入框各放一个，改了互相同步（通过 window 事件）。
// API key、用量、测试连接在“设置 › AI 服务”。

type Provider = "api" | "claude-cli" | "codex-cli";
type Effort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
interface CatalogModel {
  id: string;
  label: string;
  note?: string;
  efforts: Effort[];
}
interface Info {
  settings: { provider: Provider | ""; apiModel: string; claudeModel: string; codexModel: string; chatEffort: Effort | "" };
  effective: { provider: Provider; model: string; chatEffort: Effort };
  keyConfigured: boolean;
  keyFromEnv: boolean;
  cli: { claude: string | null; codex: string | null };
}

const PROVIDERS: { key: Provider; label: string; icon: string; sub: string }[] = [
  { key: "claude-cli", label: tr("Claude 订阅"), icon: "✳", sub: tr("本机 Claude Code，占订阅额度") },
  { key: "codex-cli", label: tr("ChatGPT 订阅"), icon: "◎", sub: tr("本机 Codex，占订阅额度") },
  { key: "api", label: "Claude API", icon: "⌘", sub: tr("API key，按用量计费") },
];
const FIELD = { api: "apiModel", "claude-cli": "claudeModel", "codex-cli": "codexModel" } as const;
const EFFORT_LABEL: Record<Effort, string> = { low: tr("低"), medium: tr("中"), high: tr("高"), xhigh: tr("超高"), max: tr("最高"), ultra: tr("极限") };
const EFFORT_NOTE: Partial<Record<Effort, string>> = { low: tr("回得快"), high: tr("想得更细"), max: tr("很慢、很耗额度") };
const EVENT = "ai-settings-changed";

const req = async (method: string, url: string, body?: unknown) => {
  const r = await fetch(`/api${url}`, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || tr("请求失败（{0}）", [r.status]));
  return j;
};

export function ModelPicker({ placement = "down", onOpenSettings }: { placement?: "up" | "down"; onOpenSettings: () => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [catalog, setCatalog] = useState<Record<Provider, CatalogModel[]> | null>(null);
  const [open, setOpen] = useState(false);
  const [browse, setBrowse] = useState<Provider>("claude-cli");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const load = () => req("GET", "/ai/settings").then((i: Info) => setInfo(i)).catch(() => {});
  useEffect(() => {
    load();
    req("GET", "/ai/catalog").then(setCatalog).catch(() => {});
    const on = () => load();
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  useEffect(() => {
    if (!open) return;
    load();
    req("GET", "/ai/catalog").then(setCatalog).catch(() => {});
    if (info) setBrowse(info.effective.provider);
    setQ("");
    setTimeout(() => search.current?.focus(), 0);
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const p = info?.effective.provider ?? "claude-cli";
  const curId = info ? (info.settings[FIELD[p]] ?? "") : "";
  const curModel = catalog?.[p].find((m) => m.id === curId);
  const effort = info?.effective.chatEffort ?? "low";
  const models = useMemo(() => {
    const list = catalog?.[browse] ?? [];
    const s = q.trim().toLowerCase();
    return s ? list.filter((m) => `${m.label} ${m.id} ${m.note ?? ""}`.toLowerCase().includes(s)) : list;
  }, [catalog, browse, q]);
  if (!info) return null;

  const available = (x: Provider) => (x === "claude-cli" ? !!info.cli.claude : x === "codex-cli" ? !!info.cli.codex : info.keyConfigured || info.keyFromEnv);
  // 右栏的强度：按当前在用的模型（没在目录里就按 Claude 的五档）
  const efforts: Effort[] = curModel?.efforts ?? ["low", "medium", "high", "xhigh", "max"];

  async function save(patch: Record<string, unknown>) {
    setBusy(true);
    setErr(null);
    try {
      await req("PUT", "/ai/settings", patch);
      await load();
      window.dispatchEvent(new Event(EVENT));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const shortName = curModel?.label && curModel.id ? curModel.label : info.effective.model.replace(/^claude-/, "").replace(/ 默认模型$/, tr(" 默认"));
  const browseInfo = PROVIDERS.find((x) => x.key === browse)!;

  return (
    <div className="model-picker" ref={box}>
      <button className={`mp-button${open ? " on" : ""}`} onClick={() => setOpen(!open)} title={tr("切换模型和思考强度")}>
        <span className="mp-icon">{PROVIDERS.find((x) => x.key === p)?.icon}</span>
        {shortName} · {EFFORT_LABEL[effort]}
        <span className="mp-caret">▾</span>
      </button>
      {open && (
        <div className={`mp-pop ${placement}`}>
          <div className="mp-body">
            <div className="mp-rail">
              {PROVIDERS.map((x) => (
                <button key={x.key} className={`mp-rail-btn${browse === x.key ? " on" : ""}${available(x.key) ? "" : " off"}`} title={tr("{0}：{1}", [x.label, x.sub])} onClick={() => setBrowse(x.key)}>
                  {x.icon}
                  {p === x.key && <i className="mp-rail-dot" />}
                </button>
              ))}
            </div>
            <div className="mp-models">
              <input ref={search} className="mp-search" placeholder={tr("搜索模型…")} value={q} onChange={(e) => setQ(e.target.value)} />
              <div className="mp-src muted small">
                {browseInfo.label} · {browseInfo.sub}
              </div>
              {!available(browse) ? (
                <div className="mp-empty small">
                  {browse === "api" ? tr("还没有 API key。") : tr("本机没有找到 {0}，需要先安装并登录。", [browse === "claude-cli" ? "Claude Code" : "Codex"])}
                  <button
                    className="link small"
                    onClick={() => {
                      setOpen(false);
                      onOpenSettings();
                    }}
                  >
                    {tr("去设置")}
                  </button>
                </div>
              ) : (
                <div className="mp-list">
                  {models.map((m) => {
                    const on = p === browse && curId === m.id;
                    return (
                      <button key={m.id || "default"} className={`mp-item${on ? " on" : ""}`} disabled={busy} onClick={() => save({ provider: browse, [FIELD[browse]]: m.id })}>
                        <span className="mp-item-label">{m.label}</span>
                        {m.note && <span className="muted small">{m.note}</span>}
                        {on && <span className="mp-check">✓</span>}
                      </button>
                    );
                  })}
                  {models.length === 0 && <div className="muted small">{tr("没有匹配的模型")}</div>}
                </div>
              )}
            </div>
            <div className="mp-efforts">
              <div className="mp-col-head">
                <span>{tr("思考强度")}</span>
                <span className="muted small">{shortName}</span>
              </div>
              {efforts.map((e) => (
                <button key={e} className={`mp-item${effort === e ? " on" : ""}`} disabled={busy} onClick={() => save({ chatEffort: e })}>
                  <span className="mp-item-label">{EFFORT_LABEL[e]}</span>
                  <span className="muted small">{e === "low" ? tr("默认 · 回得快") : (EFFORT_NOTE[e] ?? "")}</span>
                  {effort === e && <span className="mp-check">✓</span>}
                </button>
              ))}
            </div>
          </div>
          <div className="mp-foot">
            <span className="muted small">{tr("强度用于对话；记录分析和评分用固定强度。")}{err && <span className="error-text"> {err}</span>}</span>
            <button
              className="link small"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
            >
              {tr("API key · 用量 →")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
