import { useEffect, useRef, useState, type ReactNode } from "react";
import { GRADE_LABEL, gradeOf } from "../../../../modules/scoring/index.ts";
import { api, fmtMinutes, hm, TZ, type ChatAction, type ChatMessage, type Meta } from "../api.ts";
import { VoiceButton } from "./VoiceButton.tsx";
import { ChatScorePanel } from "./ChatScorePanel.tsx";
import { DeviceRef } from "./DeviceRef.tsx";
import type { Entry } from "../api.ts";

// 对话模式：像聊天一样说做了什么、要改什么、想怎么规划。
// AI 回复文字，并把要写入的改动做成一张张操作卡片；点“应用”才真正保存（仍然是“用户确认后才保存”）。

const TYPE_LABEL: Record<ChatAction["type"], string> = {
  create_entry: "新建记录",
  update_entry: "修改记录",
  delete_entry: "删除记录",
  score_entry: "评分",
  create_goal: "新建目标",
  update_goal: "修改目标",
  update_goal_progress: "更新进度",
  split_goal: "拆分目标",
};

/** 只认两种格式：**粗体** 和以“- ”开头的列表行；其余原样显示（不用 innerHTML） */
function RichText({ text }: { text: string }) {
  const inline = (s: string) =>
    s.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : part));
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) blocks.push(<ul key={`l${blocks.length}`}>{list.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>);
    list = [];
  };
  for (const line of text.split("\n")) {
    const m = /^\s*[-•]\s+(.*)$/.exec(line);
    if (m) list.push(m[1]);
    else {
      flush();
      if (line.trim()) blocks.push(<p key={`p${blocks.length}`}>{inline(line)}</p>);
    }
  }
  flush();
  return <>{blocks}</>;
}

const STARTERS = ["刚才这一个小时在看论文，中间刷了会儿手机", "帮我看看今天的时间都去哪了", "这周主要目标进展怎么样？", "帮我把一个目标拆成几步"];

/** 执行一个操作：调用已有接口，返回给卡片显示的结果 */
async function applyAction(a: ChatAction): Promise<NonNullable<ChatAction["result"]>> {
  const allocs = a.allocations.map((x) => ({ category_id: x.category_id, minutes: x.minutes, note: x.note }));
  switch (a.type) {
    case "create_entry": {
      const e = await api.createEntry({ start: a.start_iso!, end: a.end_iso!, tz: TZ, text: a.text ?? a.summary, goal_id: a.goal_id });
      if (a.title?.trim()) await api.updateEntry(e.id, { title: a.title.trim().slice(0, 40) });
      if (allocs.length) await api.review(e.id, { allocations: allocs, answers: [], goal_id: a.goal_id });
      // 应用后接着走：没有分配先补分配，再问质量、评分，在卡片下展示完整的评分分析
      return { entry_id: e.id, scored: true };
    }
    case "update_entry": {
      const patch: Record<string, unknown> = {};
      if (a.start_iso && a.end_iso) Object.assign(patch, { start: a.start_iso, end: a.end_iso });
      if (a.text) patch.text = a.text;
      if (a.goal_id) patch.goal_id = a.goal_id;
      if (Object.keys(patch).length) await api.updateEntry(a.entry_id!, patch);
      if (allocs.length) await api.review(a.entry_id!, { allocations: allocs, answers: [], goal_id: a.goal_id ?? null });
      return { entry_id: a.entry_id!, scored: true };
    }
    case "delete_entry":
      await api.deleteEntry(a.entry_id!);
      return {};
    case "score_entry": {
      const e = await api.score(a.entry_id!);
      return { entry_id: e.id, scored: true };
    }
    case "create_goal": {
      const g = await api.createGoal({
        title: a.title!,
        level: a.level ?? "short",
        ddl: a.ddl,
        description: a.description,
        parent_id: a.parent_id,
        weight: a.weight ?? undefined,
      } as never);
      return { goal_id: g.id };
    }
    case "update_goal": {
      const patch: Record<string, unknown> = {};
      for (const k of ["title", "ddl", "description", "parent_id", "weight", "level"] as const) if (a[k] != null) patch[k] = a[k];
      await api.updateGoal(a.goal_id!, patch as never);
      return { goal_id: a.goal_id! };
    }
    case "update_goal_progress":
      await api.updateGoal(a.goal_id!, { progress: a.progress, progress_reason: a.reason } as never);
      return { goal_id: a.goal_id! };
    case "split_goal":
      await api.createChildren(a.goal_id!, a.steps);
      return { goal_id: a.goal_id! };
  }
}

function ActionCard(props: {
  a: ChatAction;
  meta: Meta;
  busy: boolean;
  onApply: () => void;
  onDismiss: () => void;
  onOpenEntry: (id: string) => void;
  onDataChanged: () => void;
  onScoreConfirmed: (e: Entry) => void;
}) {
  const { a, meta } = props;
  const goal = (id: string | null) => meta.goals.find((g) => g.id === id)?.title ?? id;
  const cat = (id: string) => meta.categories.find((c) => c.id === id);
  let detail: ReactNode = null;
  if (a.type === "create_entry" || a.type === "update_entry") {
    detail = (
      <>
        {a.start_iso && a.end_iso && (
          <div className="ac-line">
            {new Date(a.start_iso).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })} {hm(a.start_iso)}–{hm(a.end_iso)} ·{" "}
            {fmtMinutes(Math.round((Date.parse(a.end_iso) - Date.parse(a.start_iso)) / 60000))}
          </div>
        )}
        {a.start_iso && a.end_iso && <DeviceRef start={a.start_iso} end={a.end_iso} compact />}
        {a.text && <div className="ac-line muted">“{a.text}”</div>}
        {a.allocations.length > 0 && (
          <div className="ac-allocs">
            {a.allocations.map((x, i) => (
              <span key={i} className="ac-alloc" style={{ borderColor: cat(x.category_id)?.color }}>
                <i style={{ background: cat(x.category_id)?.color }} />
                {cat(x.category_id)?.name} {x.minutes} 分钟{x.note ? ` · ${x.note}` : ""}
              </span>
            ))}
          </div>
        )}
        {a.goal_id && <div className="ac-line muted">关联目标：{goal(a.goal_id)}</div>}
      </>
    );
  } else if (a.type === "create_goal" || a.type === "update_goal") {
    detail = (
      <div className="ac-line muted">
        {[a.title, a.level && { long: "长期", short: "短期", task: "任务" }[a.level], a.ddl && `DDL ${a.ddl}`, a.parent_id && `父目标 ${goal(a.parent_id)}`, a.weight != null && `占 ${a.weight}%`]
          .filter(Boolean)
          .join(" · ")}
        {a.description && <div>{a.description}</div>}
      </div>
    );
  } else if (a.type === "update_goal_progress") {
    const g = meta.goals.find((x) => x.id === a.goal_id);
    detail = (
      <div className="ac-line">
        {g?.title}：{g?.progress}% → <strong>{a.progress}%</strong>
        <div className="muted">推进了：{a.reason}</div>
      </div>
    );
  } else if (a.type === "split_goal") {
    detail = (
      <ol className="ac-steps">
        {a.steps.map((s, i) => (
          <li key={i}>
            {s.title} <span className="muted">· 占 {s.weight}%{s.ddl ? ` · ${s.ddl}` : ""}</span>
          </li>
        ))}
      </ol>
    );
  }

  return (
    <div className={`action-card st-${a.status}`}>
      <div className="ac-head">
        <span className="ac-type">{TYPE_LABEL[a.type]}</span>
        <span className="ac-summary">{a.summary}</span>
      </div>
      {detail}
      {a.status === "pending" && (
        <div className="actions">
          <button className="primary" disabled={props.busy} onClick={props.onApply}>
            应用
          </button>
          <button disabled={props.busy} onClick={props.onDismiss}>
            忽略
          </button>
        </div>
      )}
      {a.status === "applied" && (
        <div className="ac-status ok-text">
          ✓ 已应用{a.result?.text ? `：${a.result.text}` : ""}
          {a.result?.entry_id && (
            <button className="link small" onClick={() => props.onOpenEntry(a.result!.entry_id!)}>
              查看记录
            </button>
          )}
        </div>
      )}
      {a.status === "applied" && a.result?.entry_id && (a.result.scored || a.type === "create_entry" || a.type === "update_entry") && (
        <ChatScorePanel
          entryId={a.result.entry_id}
          meta={meta}
          autoScore={a.type !== "score_entry"}
          onChanged={props.onDataChanged}
          onConfirmed={props.onScoreConfirmed}
        />
      )}
      {a.status === "dismissed" && <div className="ac-status muted">已忽略</div>}
      {a.status === "failed" && <div className="ac-status error-text">应用失败：{a.error}</div>}
      {a.status === "invalid" && <div className="ac-status error-text">无法应用：{a.error}</div>}
    </div>
  );
}

export function ChatView(props: { meta: Meta; side: ReactNode; onDataChanged: () => void; onOpenEntry: (id: string) => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.chatList().then(setMessages).catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, sending]);

  /** 发消息；event=true 表示这是应用里发生的事（例如确认了评分），让 AI 接着推进 */
  async function send(msg = text, event = false) {
    const m = msg.trim();
    if (!m || sending) return;
    setSending(true);
    setError(null);
    if (!event) setText("");
    // 先把这条显示出来
    const optimistic: ChatMessage = { id: `tmp-${Date.now()}`, role: event ? "event" : "user", content: m, actions: [], quick_replies: [], model: null, created_at: new Date().toISOString() };
    setMessages((x) => [...x, optimistic]);
    try {
      const reply = await api.chatSend(m, event);
      const list = await api.chatList();
      setMessages(list.length ? list : [...messages, optimistic, reply]);
    } catch (e) {
      setError((e as Error).message);
      if (!event) setText(m);
      setMessages((x) => x.filter((y) => y.id !== optimistic.id));
      api.chatList().then(setMessages).catch(() => {});
    } finally {
      setSending(false);
    }
  }

  async function act(msg: ChatMessage, idx: number, apply: boolean) {
    const key = `${msg.id}:${idx}`;
    setBusyAction(key);
    try {
      let updated: ChatMessage;
      if (!apply) updated = await api.chatAction(msg.id, idx, { status: "dismissed" });
      else {
        try {
          const result = await applyAction(msg.actions[idx]);
          updated = await api.chatAction(msg.id, idx, { status: "applied", result });
        } catch (e) {
          updated = await api.chatAction(msg.id, idx, { status: "failed", error: (e as Error).message });
        }
        props.onDataChanged();
      }
      setMessages((x) => x.map((m) => (m.id === updated.id ? updated : m)));
    } finally {
      setBusyAction(null);
    }
  }

  async function applyAll(msg: ChatMessage) {
    for (let i = 0; i < msg.actions.length; i++) {
      if (msg.actions[i].status !== "pending") continue;
      // 顺序执行：后面的操作可能依赖前面创建的数据
      await act(msg, i, true);
    }
  }

  return (
    <main className="chat-layout">
      <section className="chat-col card">
        <div className="card-head">
          <h3>对话</h3>
          <span className="muted small">说说做了什么、想改什么、怎么规划；改动要点“应用”才保存</span>
          {messages.length > 0 && (
            <button
              className="link small"
              onClick={async () => {
                if (!window.confirm("清空对话记录？（已应用的改动不受影响）")) return;
                await api.chatClear();
                setMessages([]);
              }}
            >
              清空对话
            </button>
          )}
        </div>
        <div className="chat-scroll">
          {messages.length === 0 && !sending && (
            <div className="chat-empty">
              <p className="muted">可以这样开始：</p>
              <div className="chips">
                {STARTERS.map((s) => (
                  <button key={s} className="chip" onClick={() => send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, mi) =>
            m.role === "event" ? (
              <div key={m.id} className="event-line">
                {m.content}
              </div>
            ) : (
            <div key={m.id} className={`bubble-row ${m.role}`}>
              <div className={`bubble ${m.role}`}>
                <div className="bubble-text">{m.role === "assistant" ? <RichText text={m.content} /> : m.content}</div>
                {m.actions.length > 0 && (
                  <div className="action-list">
                    {m.actions.map((a, i) => (
                      <ActionCard
                        key={i}
                        a={a}
                        meta={props.meta}
                        busy={!!busyAction}
                        onApply={() => act(m, i, true)}
                        onDismiss={() => act(m, i, false)}
                        onDataChanged={props.onDataChanged}
                        onScoreConfirmed={(e) => {
                          const g = props.meta.goals.find((x) => x.id === e.goal_id);
                          send(`已确认「${e.title ?? e.raw_text.slice(0, 20)}」的评分：${e.score?.overall} 分${g ? `；关联目标「${g.title}」现在进度 ${g.progress}%` : ""}`, true);
                        }}
                        onOpenEntry={props.onOpenEntry}
                      />
                    ))}
                    {m.actions.filter((a) => a.status === "pending").length > 1 && (
                      <button className="link small" disabled={!!busyAction} onClick={() => applyAll(m)}>
                        全部应用
                      </button>
                    )}
                  </div>
                )}
                {m.role === "assistant" && mi === messages.length - 1 && !sending && m.quick_replies.length > 0 && (
                  <div className="chips quick-replies">
                    {m.quick_replies.map((q) => (
                      <button key={q} className="chip" onClick={() => send(q)}>
                        {q}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            ),
          )}
          {sending && (
            <div className="bubble-row assistant">
              <div className="bubble assistant typing">思考中…</div>
            </div>
          )}
          <div ref={endRef} />
        </div>
        {error && <div className="banner error">{error}</div>}
        <div className="chat-input">
          <textarea
            rows={2}
            placeholder="例如：下午两点到五点改论文，中间开了个半小时的会。Enter 发送，Shift+Enter 换行"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="chat-input-tools">
            <VoiceButton serverAsr={props.meta.asr.server} onText={(t) => setText((p) => (p ? `${p}，${t}` : t))} />
            <button className="primary" disabled={sending || !text.trim()} onClick={() => send()}>
              发送
            </button>
          </div>
        </div>
      </section>
      <aside className="chat-side">{props.side}</aside>
    </main>
  );
}
