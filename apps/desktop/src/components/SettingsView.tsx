import { useState } from "react";
import { api, type Meta } from "../api.ts";

export function SettingsView({ meta, onChanged }: { meta: Meta; onChanged: () => void }) {
  const [hours, setHours] = useState(String(meta.work_budget_minutes / 60));
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function saveBudget() {
    setMsg(null);
    setErr(null);
    try {
      await api.saveSettings({ work_budget_minutes: Math.round(Number(hours) * 60) });
      setMsg("已保存");
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function importFile(f: File) {
    setMsg(null);
    setErr(null);
    try {
      const data = JSON.parse(await f.text());
      const r = await api.importData(data);
      setMsg(`导入完成：${Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join("，")}`);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <main className="page">
      <h2>设置</h2>

      <div className="card">
        <h3>每日有效脑力工作预算</h3>
        <p className="muted">默认 6 小时。这是产品初始预算，不是医学上限，也不是每天必须完成的指标。只累计你确认过的工作时长。</p>
        <div className="actions">
          <input type="number" min={0.5} max={16} step={0.5} value={hours} onChange={(e) => setHours(e.target.value)} style={{ width: 90 }} />
          <span>小时</span>
          <button className="primary" onClick={saveBudget}>
            保存
          </button>
        </div>
      </div>

      <div className="card">
        <h3>AI 服务</h3>
        <table className="kv">
          <tbody>
            <tr>
              <td>模型</td>
              <td>{meta.ai.model}</td>
            </tr>
            <tr>
              <td>地址</td>
              <td>{meta.ai.base_url}</td>
            </tr>
            <tr>
              <td>API key</td>
              <td>{meta.ai.key_configured ? "已配置（只保存在本机 .env）" : "未在 .env 中配置"}</td>
            </tr>
            <tr>
              <td>语音转写</td>
              <td>{meta.asr.server ? "使用 .env 中配置的转写服务" : "使用浏览器自带语音识别"}</td>
            </tr>
          </tbody>
        </table>
        <p className="muted small">修改项目根目录的 .env 后重启服务生效。AI 只收到当前这段记录、分类、目标和当天更早记录的标题。</p>
      </div>

      <div className="card">
        <h3>数据</h3>
        <p className="muted">数据保存在本机 data/app.db。导出文件包含全部记录、目标和评分历史，可用于备份和恢复。</p>
        <div className="actions">
          <a className="button" href="/api/export" download>
            导出 JSON
          </a>
          <label className="button">
            导入 JSON
            <input type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
          </label>
        </div>
        {msg && <div className="ok-text">{msg}</div>}
        {err && <div className="error-text">{err}</div>}
      </div>

      <div className="card">
        <h3>分类</h3>
        <div className="dist-legend">
          {meta.categories.map((c) => (
            <span key={c.id}>
              <i style={{ background: c.color }} />
              {c.name}
            </span>
          ))}
        </div>
        <p className="muted small">分类不等于分数；同类活动在不同背景下可以有不同评价。自定义分类后续加入。</p>
      </div>
      <p className="muted small">设备 ID：{meta.device_id} · 评分规则 {meta.rules.version}</p>
    </main>
  );
}
