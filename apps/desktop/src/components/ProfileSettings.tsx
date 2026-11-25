import { useState } from "react";
import { PROFILE_PRESETS, presetActivities, type CommonActivity, type Profile } from "../../../../modules/profile.ts";
import { api, type Meta } from "../api.ts";

// 身份与常见活动：决定记录页“常见”按钮，也告诉 AI 你大致在做什么样的工作

export function ProfileSettings({ meta, onChanged }: { meta: Meta; onChanged: () => void }) {
  const [p, setP] = useState<Profile>(meta.profile);
  const [newLabel, setNewLabel] = useState("");
  const [newCat, setNewCat] = useState("cat_work");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const cat = (id: string) => meta.categories.find((c) => c.id === id);
  const dirty = JSON.stringify(p) !== JSON.stringify(meta.profile);

  const pickRole = (key: string) => {
    if (key === "custom") return setP({ ...p, role: "custom", roleLabel: p.role === "custom" ? p.roleLabel : "" });
    const preset = PROFILE_PRESETS.find((x) => x.key === key)!;
    // 换身份时用该身份的默认常见活动
    setP({ ...p, role: key, roleLabel: preset.label, activities: presetActivities(key) });
  };

  async function save() {
    setMsg(null);
    setErr(null);
    try {
      const saved = await api.saveProfile(p);
      setP(saved);
      setMsg("已保存");
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const add = () => {
    const label = newLabel.trim();
    if (!label || p.activities.some((a) => a.label === label)) return;
    setP({ ...p, activities: [...p.activities, { label, cat: newCat } as CommonActivity] });
    setNewLabel("");
  };

  return (
    <div className="card">
      <h3>身份与常见活动</h3>
      <p className="muted">身份决定记录页的“常见”按钮，也会告诉 AI 你的“工作”通常指什么（例如博士的读论文、做实验，上班族的开会、写文档）。</p>
      <div className="chips">
        {PROFILE_PRESETS.map((x) => (
          <button key={x.key} className={`chip${p.role === x.key ? " on" : ""}`} onClick={() => pickRole(x.key)}>
            {x.label}
          </button>
        ))}
        <button className={`chip${p.role === "custom" ? " on" : ""}`} onClick={() => pickRole("custom")}>
          自定义
        </button>
      </div>
      <div className="form-grid" style={{ marginTop: 10 }}>
        {p.role === "custom" && (
          <label>
            身份名称
            <input value={p.roleLabel} placeholder="例如：医生、高中老师" onChange={(e) => setP({ ...p, roleLabel: e.target.value })} />
          </label>
        )}
        <label className="wide">
          补充一句（可选）
          <input
            value={p.description}
            placeholder="例如：CS 方向博士三年级，主要做机器人学习；或：产品经理，常和研发、设计开会"
            onChange={(e) => setP({ ...p, description: e.target.value })}
          />
        </label>
      </div>
      <div className="small muted" style={{ margin: "10px 0 4px" }}>
        常见活动（记录时点一下就填进描述；颜色只是提示，不决定分类，点 × 删除）：
      </div>
      <div className="chips">
        {p.activities.map((a) => (
          <span key={a.label} className="chip tinted small-chip" style={{ "--c": cat(a.cat)?.color ?? "#9aa0a6" } as React.CSSProperties}>
            {a.label}
            <button className="icon" title="删除" onClick={() => setP({ ...p, activities: p.activities.filter((x) => x.label !== a.label) })}>
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="actions">
        <input value={newLabel} placeholder="新的常见活动" style={{ width: 140 }} onChange={(e) => setNewLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <select value={newCat} onChange={(e) => setNewCat(e.target.value)}>
          {meta.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button onClick={add}>添加</button>
        <span className="spacer" />
        <button className="primary" disabled={!dirty || (p.role === "custom" && !p.roleLabel.trim())} onClick={save}>
          保存
        </button>
      </div>
      {msg && <div className="ok-text small">{msg}</div>}
      {err && <div className="error-text small">{err}</div>}
    </div>
  );
}
