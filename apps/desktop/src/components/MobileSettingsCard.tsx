import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { locale, tr } from "../i18n.ts";

// 设置页：手机访问（同一个 WiFi 下用 iPhone 聊天）。默认关闭。

interface Status {
  enabled: boolean;
  running: boolean;
  error: string | null;
  host: string;
  ips: string[];
  url: string;
  setupUrl: string | null;
  pairing: { code: string; expires: string } | null;
  devices: { id: string; name: string; created_at: string; last_seen: string | null }[];
}
const req = async (method: string, url: string, body?: unknown) => {
  const r = await fetch(`/api${url}`, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || tr("请求失败（{0}）", [r.status]));
  return j;
};
const fmt = (s: string | null) => (s ? new Date(s).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "—");

function QR({ text }: { text: string }) {
  const [svg, setSvg] = useState("");
  useEffect(() => {
    QRCode.toString(text, { type: "svg", margin: 1, width: 150 }).then(setSvg).catch(() => setSvg(""));
  }, [text]);
  // 二维码 SVG 由本地库生成，内容只是网址
  return <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function MobileSettingsCard() {
  const [st, setSt] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => req("GET", "/mobile/status").then(setSt).catch((e) => setErr(e.message));
  useEffect(() => {
    load();
  }, []);
  // 配对码有效期内每 5 秒刷新一下，配对成功后设备列表会自动出现
  useEffect(() => {
    if (!st?.pairing) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [st?.pairing?.code]);
  if (!st) return null;

  const run = async (fn: () => Promise<Status>) => {
    setBusy(true);
    setErr(null);
    try {
      setSt(await fn());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3>{tr("手机")}</h3>
      <p className="muted">
        {tr("在同一个 WiFi 下用 iPhone 聊天（记录、评分、目标都能在对话里做）。Mac 没开或不在家时，手机上照样能写，消息先存在手机上，连上后自动发出。 数据仍然只在这台 Mac 上；手机拿不到电脑使用数据。")}
      </p>
      <label className="check-row">
        <input type="checkbox" checked={st.enabled} disabled={busy} onChange={(e) => run(() => req("PUT", "/mobile/enabled", { enabled: e.target.checked }))} />
        {tr("允许同一个 WiFi 下的手机访问")}
      </label>
      {st.enabled && !st.running && <div className="error-text small">{tr("没能启动：")}{st.error ?? tr("未知原因")}</div>}

      {st.enabled && st.running && (
        <>
          <div className="mobile-steps">
            <div className="mobile-step">
              <div className="step-head">{tr("① 装证书（每台手机一次）")}</div>
              {st.setupUrl ? <QR text={st.setupUrl} /> : <div className="muted small">{tr("没有找到局域网地址，确认 Mac 连着 WiFi")}</div>}
              <div className="small muted">{tr("用 iPhone 相机扫码，在 Safari 里按页面提示安装并信任证书。")}</div>
              {st.setupUrl && <code className="small">{st.setupUrl}</code>}
            </div>
            <div className="mobile-step">
              <div className="step-head">{tr("② 打开聊天页，添加到主屏幕")}</div>
              <QR text={st.url} />
              <div className="small muted">{tr("Safari 分享按钮 › 添加到主屏幕，以后从主屏幕打开。")}</div>
              <code className="small">{st.url}</code>
            </div>
            <div className="mobile-step">
              <div className="step-head">{tr("③ 配对")}</div>
              {st.pairing ? (
                <>
                  <div className="pair-code">{st.pairing.code}</div>
                  <div className="small muted">{tr("在手机上输入；")}{fmt(st.pairing.expires)} {tr("前有效，只能用一次")}</div>
                </>
              ) : (
                <button className="primary" disabled={busy} onClick={() => run(() => req("POST", "/mobile/pairing"))}>
                  {tr("生成配对码")}
                </button>
              )}
            </div>
          </div>

          <h4>{tr("已配对的手机")}</h4>
          {st.devices.length === 0 ? (
            <div className="muted small">{tr("还没有")}</div>
          ) : (
            <table className="kv">
              <tbody>
                {st.devices.map((d) => (
                  <tr key={d.id}>
                    <td>{d.name}</td>
                    <td className="muted small">
                      {tr("配对")} {fmt(d.created_at)} {tr("· 最近使用")} {fmt(d.last_seen)}
                    </td>
                    <td>
                      <button
                        className="link danger small"
                        onClick={() => window.confirm(tr("撤销“{0}”？它将不能再访问，需要重新配对。", [d.name])) && run(() => req("DELETE", `/mobile/devices/${d.id}`))}
                      >
                        {tr("撤销")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted small">
            {tr("第一次打开时 Mac 可能弹出“是否允许 node 接受传入的网络连接”，选允许。手机连的是")} {st.host}{tr("；Mac 睡眠时手机连不上，消息会先存在手机上。")}
          </p>
        </>
      )}
      {err && <div className="error-text small">{err}</div>}
    </div>
  );
}
