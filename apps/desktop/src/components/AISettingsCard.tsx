import { useEffect, useState } from "react";
import { locale, tr } from "../i18n.ts";

// 设置页：AI 服务（换后端 / 换模型 / 换 API key）和用量。
// API key 只写不读：保存到 macOS 钥匙串，页面上永远不显示。

type Provider = "api" | "claude-cli" | "codex-cli";
interface Info {
  settings: { provider: Provider | ""; apiModel: string; claudeModel: string; codexModel: string; baseURL: string };
  effective: { provider: Provider; model: string; baseURL: string };
  keyConfigured: boolean;
  keyFromEnv: boolean;
  cli: { claude: string | null; codex: string | null };
}
interface UsageRow {
  provider: Provider;
  calls: number;
  failed: number;
  input: number;
  output: number;
  cached: number;
  cost: number | null;
}
interface Usage {
  today: UsageRow[];
  week: UsageRow[];
  month: UsageRow[];
  rateLimit: { at: string; values: Record<string, string> } | null;
  lastLimitHit: { at: string; provider: string; error: string } | null;
}

const PROVIDERS: { key: Provider; label: string; sub: string }[] = [
  { key: "claude-cli", label: tr("Claude 订阅"), sub: tr("用本机已登录的 Claude Code，占订阅额度") },
  { key: "codex-cli", label: tr("ChatGPT 订阅"), sub: tr("用本机已登录的 Codex，占订阅额度") },
  { key: "api", label: "Claude API", sub: tr("用 API key，按用量计费") },
];
const MODEL_HINTS: Record<Provider, string[]> = {
  "claude-cli": ["opus", "sonnet", "haiku", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"],
  "codex-cli": [],
  api: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"],
};
const fmtTok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const req = async (method: string, url: string, body?: unknown) => {
  const r = await fetch(`/api${url}`, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || tr("请求失败（{0}）", [r.status]));
  return j;
};

export function AISettingsCard({ onChanged }: { onChanged: () => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [draft, setDraft] = useState<Info["settings"] | null>(null);
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const load = async () => {
    const i: Info = await req("GET", "/ai/settings");
    setInfo(i);
    setDraft({ ...i.settings, provider: i.settings.provider || i.effective.provider });
    setUsage(await req("GET", "/ai/usage"));
    if (i.keyConfigured || i.keyFromEnv) req("GET", "/ai/models").then((m) => setModels(m.models ?? [])).catch(() => {});
  };
  useEffect(() => {
    load().catch((e) => setErr(e.message));
  }, []);
  if (!info || !draft) return null;

  const p = draft.provider as Provider;
  const modelField = p === "api" ? "apiModel" : p === "claude-cli" ? "claudeModel" : "codexModel";
  const hints = p === "api" && models.length ? models : MODEL_HINTS[p];
  const cliMissing = (p === "claude-cli" && !info.cli.claude) || (p === "codex-cli" && !info.cli.codex);

  async function save(extra: Record<string, unknown> = {}) {
    setMsg(null);
    setErr(null);
    try {
      await req("PUT", "/ai/settings", { ...draft, ...extra });
      setKey("");
      await load();
      setMsg(tr("已保存"));
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function test() {
    setTesting(true);
    setMsg(null);
    setErr(null);
    try {
      await req("PUT", "/ai/settings", draft);
      const r = await req("POST", "/ai/test");
      setMsg(tr("连接正常：{0}，{1} 秒", [r.model, (r.ms / 1000).toFixed(1)]));
      await load();
      onChanged();
    } catch (e) {
      setErr(tr("连接失败：{0}", [(e as Error).message]));
      setUsage(await req("GET", "/ai/usage"));
    } finally {
      setTesting(false);
    }
  }

  const periodRows = (rows: UsageRow[]) =>
    rows.length === 0 ? (
      <span className="muted">{tr("没有调用")}</span>
    ) : (
      rows.map((r) => (
        <div key={r.provider} className="usage-line">
          <span className="usage-prov">{PROVIDERS.find((x) => x.key === r.provider)?.label ?? r.provider}</span>
          <span>{r.calls} {tr("次")}{r.failed ? tr("（失败 {0}）", [r.failed]) : ""}</span>
          <span className="muted">
            {tr("输入")} {fmtTok(r.input)} {tr("· 输出")} {fmtTok(r.output)}
            {r.cached ? tr(" · 缓存 {0}", [fmtTok(r.cached)]) : ""}
          </span>
          <span>
            {r.cost == null
              ? r.provider === "codex-cli"
                ? tr("费用：订阅内")
                : ""
              : r.provider === "api"
                ? tr("约 ${0}", [r.cost.toFixed(2)])
                : tr("等价 API 约 ${0}（订阅内不另收费）", [r.cost.toFixed(2)])}
          </span>
        </div>
      ))
    );

  const rl = usage?.rateLimit?.values;

  return (
    <div className="card">
      <h3>{tr("AI 服务")}</h3>
      <div className="provider-grid">
        {PROVIDERS.map((x) => {
          const missing = (x.key === "claude-cli" && !info.cli.claude) || (x.key === "codex-cli" && !info.cli.codex);
          return (
            <button key={x.key} className={`provider${p === x.key ? " on" : ""}`} onClick={() => setDraft({ ...draft, provider: x.key })}>
              <strong>{x.label}</strong>
              <span className="small muted">{x.sub}</span>
              <span className="small">
                {x.key === "claude-cli"
                  ? info.cli.claude
                    ? tr("已安装 {0}", [info.cli.claude])
                    : tr("未安装 Claude Code")
                  : x.key === "codex-cli"
                    ? info.cli.codex
                      ? tr("已安装 {0}", [info.cli.codex])
                      : tr("未安装 Codex")
                    : info.keyConfigured
                      ? tr("已保存 key（钥匙串）")
                      : info.keyFromEnv
                        ? tr("使用 .env 里的 key")
                        : tr("还没有 key")}
              </span>
              {missing && <span className="small error-text">{tr("需要先安装并登录")}</span>}
            </button>
          );
        })}
      </div>

      <div className="form-grid" style={{ marginTop: 10 }}>
        <label>
          {tr("模型")}
          <input
            list="model-hints"
            value={draft[modelField]}
            placeholder={p === "api" ? "claude-opus-5-5" : p === "claude-cli" ? tr("留空用 Claude Code 默认模型") : tr("留空用 Codex 默认模型")}
            onChange={(e) => setDraft({ ...draft, [modelField]: e.target.value })}
          />
          <datalist id="model-hints">
            {hints.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        {p === "api" && (
          <>
            <label>
              {tr("API key（保存到钥匙串，不会显示）")}
              <input type="password" autoComplete="off" value={key} placeholder={info.keyConfigured ? tr("已保存；要更换就填新的") : "sk-ant-…"} onChange={(e) => setKey(e.target.value)} />
            </label>
            <label className="wide">
              {tr("API 地址（可选，用代理或网关时填）")}
              <input value={draft.baseURL} placeholder="https://api.anthropic.com" onChange={(e) => setDraft({ ...draft, baseURL: e.target.value })} />
            </label>
          </>
        )}
      </div>
      <div className="actions">
        <button className="primary" onClick={() => save(key.trim() ? { apiKey: key.trim() } : {})}>
          {tr("保存")}
        </button>
        <button disabled={testing || cliMissing} onClick={test}>
          {testing ? tr("测试中…") : tr("测试连接")}
        </button>
        {p === "api" && info.keyConfigured && (
          <button className="link danger" onClick={() => window.confirm(tr("从钥匙串删除 API key？")) && save({ clearKey: true })}>
            {tr("删除 key")}
          </button>
        )}
        <span className="spacer" />
        <span className="muted small">
          {tr("当前在用：")}{PROVIDERS.find((x) => x.key === info.effective.provider)?.label} · {info.effective.model}
        </span>
      </div>
      {msg && <div className="ok-text small">{msg}</div>}
      {err && <div className="error-text small">{err}</div>}

      {usage && (
        <div className="usage">
          <h4>{tr("用量（本应用发起的调用）")}</h4>
          <div className="usage-grid">
            <span className="muted small">{tr("今天")}</span>
            <div>{periodRows(usage.today)}</div>
            <span className="muted small">{tr("本周")}</span>
            <div>{periodRows(usage.week)}</div>
            <span className="muted small">{tr("本月")}</span>
            <div>{periodRows(usage.month)}</div>
          </div>
          {rl && (
            <div className="small" style={{ marginTop: 6 }}>
              {tr("API 每分钟剩余（")}{new Date(usage.rateLimit!.at).toLocaleTimeString(locale, { hour12: false })}{tr("）：请求")} {rl["requests-remaining"] ?? "?"}/{rl["requests-limit"] ?? "?"} {tr("· 输入 token")} {fmtTok(Number(rl["input-tokens-remaining"] ?? rl["tokens-remaining"] ?? 0))}/{fmtTok(Number(rl["input-tokens-limit"] ?? rl["tokens-limit"] ?? 0))}
            </div>
          )}
          {usage.lastLimitHit && (
            <div className="small error-text" style={{ marginTop: 4 }}>
              {tr("最近一次碰到用量上限：")}{new Date(usage.lastLimitHit.at).toLocaleString(locale, { hour12: false })}{tr("（")}{usage.lastLimitHit.provider}{tr("）")}
            </div>
          )}
          <p className="muted small">
            {tr("订阅（Claude Code / Codex）的剩余额度没有官方接口可查，这里显示的是本应用用了多少；碰到上限时会在这里提示。API 的账户余额要在 Anthropic 控制台查看。")}
          </p>
        </div>
      )}
    </div>
  );
}
