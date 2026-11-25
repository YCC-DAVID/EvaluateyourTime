import { useEffect, useRef, useState, type ReactNode } from "react";
import { GRADE_LABEL, gradeOf } from "../../../../modules/scoring/index.ts";
import { api, fmtMinutes, hm, lastScoreAction, TZ, type ChatAction, type ChatMessage, type ChatThread, type Meta } from "../api.ts";
import { VoiceButton } from "./VoiceButton.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { ChatScorePanel } from "./ChatScorePanel.tsx";
import { DeviceRef } from "./DeviceRef.tsx";
import type { Entry } from "../api.ts";
import { locale, tr } from "../i18n.ts";

// 对话模式：像聊天一样说做了什么、要改什么、想怎么规划。
// AI 回复文字，并把要写入的改动做成一张张操作卡片；点“应用”才真正保存（仍然是“用户确认后才保存”）。

const TYPE_LABEL: Record<ChatAction["type"], string> = {
  create_entry: tr("新建记录"),
  update_entry: tr("修改记录"),
  delete_entry: tr("删除记录"),
  score_entry: tr("评分"),
  create_goal: tr("新建目标"),
  update_goal: tr("修改目标"),
  update_goal_progress: tr("更新进度"),
  split_goal: tr("拆分目标"),
};

/** 只认两种格式：**粗体** 和以“- ”开头的列表行；其余原样显示（不用 innerHTML） */
export function RichText({ text }: { text: string }) {
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

const STARTERS = [tr("刚才这一个小时在看论文，中间刷了会儿手机"), tr("帮我看看今天的时间都去哪了"), tr("这周主要目标进展怎么样？"), tr("帮我把一个目标拆成几步")];

/** 执行一个操作：调用已有接口，返回给卡片显示的结果 */
export async function applyAction(a: ChatAction): Promise<NonNullable<ChatAction["result"]>> {
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
      const before = await api.getEntry(a.entry_id!);
      const patch: Record<string, unknown> = {};
      const timeChanged =
        !!a.start_iso && !!a.end_iso && (Date.parse(a.start_iso) !== Date.parse(before.start_utc) || Date.parse(a.end_iso) !== Date.parse(before.end_utc));
      const textChanged = !!a.text && a.text.trim() !== before.raw_text.trim();
      if (timeChanged) Object.assign(patch, { start: a.start_iso, end: a.end_iso });
      if (textChanged) patch.text = a.text;
      if (a.title?.trim() && a.title.trim() !== before.title) patch.title = a.title.trim().slice(0, 40);
      if (a.goal_id && a.goal_id !== before.goal_id) patch.goal_id = a.goal_id;
      if (Object.keys(patch).length) await api.updateEntry(a.entry_id!, patch);
      if (allocs.length) await api.review(a.entry_id!, { allocations: allocs, answers: [], goal_id: a.goal_id ?? before.goal_id });
      // 时间段变了又没给新分配：旧分配不再对得上，清掉，评分面板会重新问分配
      else if (timeChanged) await api.review(a.entry_id!, { allocations: [], answers: [] });
      const redo = timeChanged || textChanged || allocs.length > 0 || (!!a.goal_id && a.goal_id !== before.goal_id);
      return { entry_id: a.entry_id!, scored: true, redo, applied_at: new Date().toISOString() };
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

export function ActionCard(props: {
  a: ChatAction;
  /** 同一条记录后面还有更新的操作时为 false：评分面板只在最后一次出现 */
  scoreHere?: boolean;
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
            {new Date(a.start_iso).toLocaleDateString(locale, { month: "numeric", day: "numeric" })} {hm(a.start_iso)}–{hm(a.end_iso)} ·{" "}
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
                {tr(cat(x.category_id)?.name ?? "")} {x.minutes} {tr("分钟")}{x.note ? ` · ${x.note}` : ""}
              </span>
            ))}
          </div>
        )}
        {a.goal_id && <div className="ac-line muted">{tr("关联目标：")}{goal(a.goal_id)}</div>}
      </>
    );
  } else if (a.type === "create_goal" || a.type === "update_goal") {
    detail = (
      <div className="ac-line muted">
        {[a.title, a.level && { long: tr("长期"), short: tr("短期"), task: tr("任务") }[a.level], a.ddl && `DDL ${a.ddl}`, a.parent_id && tr("父目标 {0}", [goal(a.parent_id)]), a.weight != null && tr("占 {0}%", [a.weight])]
          .filter(Boolean)
          .join(" · ")}
        {a.description && <div>{a.description}</div>}
      </div>
    );
  } else if (a.type === "update_goal_progress") {
    const g = meta.goals.find((x) => x.id === a.goal_id);
    detail = (
      <div className="ac-line">
        {g?.title}{tr("：")}{g?.progress}% → <strong>{a.progress}%</strong>
        <div className="muted">{tr("推进了：")}{a.reason}</div>
      </div>
    );
  } else if (a.type === "split_goal") {
    detail = (
      <ol className="ac-steps">
        {a.steps.map((s, i) => (
          <li key={i}>
            {s.title} <span className="muted">{tr("· 占")} {s.weight}%{s.ddl ? ` · ${s.ddl}` : ""}</span>
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
      {a.status === "pending" && a.overlaps && a.overlaps.length > 0 && (
        <div className="ac-overlap small">
          {tr("⚠ 和已有记录重叠：")}{a.overlaps.map((o) => tr("「{0}」{1} 分钟", [o.title, o.minutes])).join(tr("、"))}{tr("。 应用后重叠部分只算这条，原记录在统计里相应减少；想改原记录的话，可以直接让我改它的时间。")}
        </div>
      )}
      {a.status === "pending" && (
        <div className="actions">
          <button className="primary" disabled={props.busy} onClick={props.onApply}>
            {tr("应用")}
          </button>
          <button disabled={props.busy} onClick={props.onDismiss}>
            {tr("忽略")}
          </button>
        </div>
      )}
      {a.status === "applied" && (
        <div className="ac-status ok-text">
          {tr("✓ 已应用")}{a.result?.text ? tr("：{0}", [a.result.text]) : ""}
          {a.result?.entry_id && (
            <button className="link small" onClick={() => props.onOpenEntry(a.result!.entry_id!)}>
              {tr("查看记录")}
            </button>
          )}
        </div>
      )}
      {a.status === "applied" && a.result?.entry_id && props.scoreHere === false && a.type !== "delete_entry" && (
        <div className="muted small">{tr("这条记录后面又改过，评分见下方最新一次。")}</div>
      )}
      {a.status === "applied" && a.result?.entry_id && props.scoreHere !== false && (a.result.scored || a.type === "create_entry" || a.type === "update_entry") && (
        <ChatScorePanel
          entryId={a.result.entry_id}
          redoSince={a.result.redo ? a.result.applied_at : undefined}
          meta={meta}
          autoScore={a.type !== "score_entry"}
          onChanged={props.onDataChanged}
          onConfirmed={props.onScoreConfirmed}
        />
      )}
      {a.status === "dismissed" && <div className="ac-status muted">{tr("已忽略")}</div>}
      {a.status === "failed" && <div className="ac-status error-text">{tr("应用失败：")}{a.error}</div>}
      {a.status === "invalid" && <div className="ac-status error-text">{tr("无法应用：")}{a.error}</div>}
    </div>
  );
}

export function ChatView(props: { meta: Meta; side: ReactNode; onDataChanged: () => void; onOpenEntry: (id: string) => void; onOpenSettings: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const LAST = "chat.lastThread";

  const loadThreads = () => api.chatThreads().then((t) => (setThreads(t), t));
  async function openThread(id: string | null) {
    setThreadId(id);
    setError(null);
    if (id) localStorage.setItem(LAST, id);
    setMessages(id ? await api.chatList(id) : []);
  }
  useEffect(() => {
    loadThreads()
      .then((t) => {
        const last = localStorage.getItem(LAST);
        return openThread(t.find((x) => x.id === last)?.id ?? t[0]?.id ?? null);
      })
      .catch((e) => setError(e.message));
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
    let tid = threadId;
    try {
      // 还没有对话就先建一个
      if (!tid) {
        tid = (await api.chatNewThread()).id;
        setThreadId(tid);
        localStorage.setItem(LAST, tid);
      }
      const reply = await api.chatSend(tid, m, event);
      const list = await api.chatList(tid);
      setMessages(list.length ? list : [...messages, optimistic, reply]);
    } catch (e) {
      setError((e as Error).message);
      if (!event) setText(m);
      setMessages((x) => x.filter((y) => y.id !== optimistic.id));
      if (tid) api.chatList(tid).then(setMessages).catch(() => {});
    } finally {
      loadThreads().catch(() => {});
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

  const cur = threads.find((t) => t.id === threadId);
  const scoreHere = lastScoreAction(messages);
  const dayLabel = (iso: string) => {
    const d = new Date(iso);
    const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86400000);
    if (days === 0) return hm(iso);
    if (days === 1) return tr("昨天");
    if (days < 7) return tr("{0} 天前", [days]);
    return d.toLocaleDateString(locale, { month: "numeric", day: "numeric" });
  };

  return (
    <main className="chat-layout">
      <aside className="chat-threads card">
        <button
          className="primary new-thread"
          disabled={sending}
          onClick={async () => {
            const t = await api.chatNewThread();
            await loadThreads();
            await openThread(t.id);
          }}
        >
          {tr("＋ 新对话")}
        </button>
        <div className="thread-list">
          {threads.length === 0 && <div className="muted small">{tr("还没有对话")}</div>}
          {threads.map((t) => (
            <div
              key={t.id}
              className={`thread-item${t.id === threadId ? " on" : ""}`}
              onClick={() => !sending && t.id !== threadId && openThread(t.id)}
              title={tr("双击改名")}
              onDoubleClick={async () => {
                const name = window.prompt(tr("对话名称（留空恢复为第一句话）"), t.custom_title ? t.title : "");
                if (name === null) return;
                await api.chatRenameThread(t.id, name);
                loadThreads();
              }}
            >
              <span className="thread-title">{t.title}</span>
              <span className="thread-meta muted">
                {dayLabel(t.updated_at)} · {t.count} {tr("条")}
              </span>
              <button
                className="icon thread-del"
                title={tr("删除这个对话")}
                onClick={async (e) => {
                  e.stopPropagation();
                  if (!window.confirm(tr("删除对话“{0}”？（已应用的改动不受影响）", [t.title]))) return;
                  await api.chatDeleteThread(t.id);
                  const rest = await loadThreads();
                  if (t.id === threadId) await openThread(rest[0]?.id ?? null);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </aside>
      <section className="chat-col card">
        <div className="card-head">
          <h3>{cur?.title ?? tr("新对话")}</h3>
        </div>
        <div className="muted small chat-hint">{tr("说说做了什么、想改什么、怎么规划；改动要点“应用”才保存")}</div>
        <div className="chat-scroll">
          {messages.length === 0 && !sending && (
            <div className="chat-empty">
              <p className="muted">{tr("可以这样开始：")}</p>
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
                        scoreHere={scoreHere.has(`${m.id}:${i}`)}
                        meta={props.meta}
                        busy={!!busyAction}
                        onApply={() => act(m, i, true)}
                        onDismiss={() => act(m, i, false)}
                        onDataChanged={props.onDataChanged}
                        onScoreConfirmed={(e) => {
                          const g = props.meta.goals.find((x) => x.id === e.goal_id);
                          send(tr("已确认「{0}」的评分：{1} 分{2}", [e.title ?? e.raw_text.slice(0, 20), e.score?.overall, g ? tr("；关联目标「{0}」现在进度 {1}%", [g.title, g.progress]) : ""]), true);
                        }}
                        onOpenEntry={props.onOpenEntry}
                      />
                    ))}
                    {m.actions.filter((a) => a.status === "pending").length > 1 && (
                      <button className="link small" disabled={!!busyAction} onClick={() => applyAll(m)}>
                        {tr("全部应用")}
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
              <div className="bubble assistant typing">{tr("思考中…")}</div>
            </div>
          )}
          <div ref={endRef} />
        </div>
        {error && <div className="banner error">{error}</div>}
        <div className="chat-input">
          <textarea
            rows={2}
            placeholder={tr("例如：下午两点到五点改论文，中间开了个半小时的会。Enter 发送，Shift+Enter 换行")}
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
            <ModelPicker placement="up" onOpenSettings={props.onOpenSettings} />
            <span className="spacer" />
            <VoiceButton serverAsr={props.meta.asr.server} onText={(t) => setText((p) => (p ? tr("{0}，{1}", [p, t]) : t))} />
            <button className="primary" disabled={sending || !text.trim()} onClick={() => send()}>
              {tr("发送")}
            </button>
          </div>
        </div>
      </section>
      <aside className="chat-side">{props.side}</aside>
    </main>
  );
}
