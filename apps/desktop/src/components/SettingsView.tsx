import { useState } from "react";
import { api, type Meta } from "../api.ts";
import { DeviceSettings } from "./DeviceSettings.tsx";
import { ProfileSettings } from "./ProfileSettings.tsx";
import { AISettingsCard } from "./AISettingsCard.tsx";
import { EKSettingsCard } from "./EKSettingsCard.tsx";
import { MobileSettingsCard } from "./MobileSettingsCard.tsx";
import { lang, setLang, tr } from "../i18n.ts";

const PROVIDER_LABEL = {
  api: tr("Claude API（API key，按用量计费）"),
  "claude-cli": tr("本机 Claude Code（使用你的订阅）"),
  "codex-cli": tr("本机 Codex（使用你的订阅）"),
} as const;

export function SettingsView({ meta, onChanged }: { meta: Meta; onChanged: () => void }) {
  const [hours, setHours] = useState(String(meta.work_budget_minutes / 60));
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function saveBudget() {
    setMsg(null);
    setErr(null);
    try {
      await api.saveSettings({ work_budget_minutes: Math.round(Number(hours) * 60) });
      setMsg(tr("已保存"));
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
      setMsg(tr("导入完成：{0}", [Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join(tr("，"))]));
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <main className="page">
      <h2>{tr("设置")}</h2>
      <nav className="settings-nav">
        {(
          [
            ["s-lang", "语言 / Language"],
            ["s-profile", tr("身份")],
            ["s-budget", tr("工作预算")],
            ["s-ai", tr("AI 服务")],
            ["s-device", tr("电脑使用")],
            ["s-ek", tr("日历与提醒事项")],
            ["s-mobile", tr("手机")],
            ["s-data", tr("数据")],
            ["s-cats", tr("分类")],
          ] as const
        ).map(([id, label]) => (
          <button key={id} className="chip" onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
            {label}
          </button>
        ))}
      </nav>

      <div className="card" id="s-lang">
        <h3>语言 / Language</h3>
        <div className="seg" role="tablist" aria-label="Language">
          {(
            [
              ["zh", "中文"],
              ["en", "English"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={lang === k} className={lang === k ? "on" : ""} onClick={() => lang !== k && setLang(k)}>
              {label}
            </button>
          ))}
        </div>
        <p className="muted small">{tr("界面和 AI 的回复（问题、评语、建议）都会换成这个语言。已经写下的记录内容不会被翻译。")}</p>
      </div>

      <div id="s-profile">
        <ProfileSettings meta={meta} onChanged={onChanged} />
      </div>

      <div className="card" id="s-budget">
        <h3>{tr("每日有效脑力工作预算")}</h3>
        <p className="muted">{tr("默认 6 小时。这是产品初始预算，不是医学上限，也不是每天必须完成的指标。只累计你确认过的工作时长。")}</p>
        <div className="actions">
          <input type="number" min={0.5} max={16} step={0.5} value={hours} onChange={(e) => setHours(e.target.value)} style={{ width: 90 }} />
          <span>{tr("小时")}</span>
          <button className="primary" onClick={saveBudget}>
            {tr("保存")}
          </button>
        </div>
      </div>

      <div id="s-ai">
        <AISettingsCard onChanged={onChanged} />
      </div>

      <div id="s-device">
        <DeviceSettings categories={meta.categories} />
      </div>

      <div id="s-ek">
        <EKSettingsCard meta={meta} onChanged={onChanged} />
      </div>

      <div id="s-mobile">
        <MobileSettingsCard />
      </div>

      <div className="card" id="s-data">
        <h3>{tr("数据")}</h3>
        <p className="muted">{tr("数据保存在本机 data/app.db。导出文件包含全部记录、目标和评分历史，可用于备份和恢复。")}</p>
        <div className="actions">
          <a className="button" href="/api/export" download>
            {tr("导出 JSON")}
          </a>
          <label className="button">
            {tr("导入 JSON")}
            <input type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
          </label>
        </div>
        {msg && <div className="ok-text">{msg}</div>}
        {err && <div className="error-text">{err}</div>}
      </div>

      <div className="card" id="s-cats">
        <h3>{tr("分类")}</h3>
        <div className="dist-legend">
          {meta.categories.map((c) => (
            <span key={c.id}>
              <i style={{ background: c.color }} />
              {tr(c.name)}
            </span>
          ))}
        </div>
        <p className="muted small">{tr("分类不等于分数；同类活动在不同背景下可以有不同评价。自定义分类后续加入。")}</p>
      </div>
      <p className="muted small">{tr("设备 ID：")}{meta.device_id} {tr("· 评分规则")} {meta.rules.version}</p>
    </main>
  );
}
