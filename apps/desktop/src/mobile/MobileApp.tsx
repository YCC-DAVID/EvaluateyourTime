import { useEffect, useRef, useState } from "react";
import { api, ApiError, hm, lastScoreAction, MOBILE_TOKEN_KEY, type ChatMessage, type ChatThread, type Meta } from "../api.ts";
import { ActionCard, applyAction, RichText } from "../components/ChatView.tsx";
import { VoiceButton } from "../components/VoiceButton.tsx";
import { useAppRefresh } from "../useAppRefresh.ts";
import { lang, tr } from "../i18n.ts";

// 手机版：只有对话。连不上 Mac 时消息先存在手机上，连上后按顺序自动发出（带上写下的时间）。
// 页面本身由离线外壳缓存，Mac 没开也能打开、能看之前的对话、能写新消息。

const NEW = "__new__"; // 还没建好的新对话
const K = {
  meta: "tm.m.meta",
  threads: "tm.m.threads",
  thread: "tm.m.thread",
  msgs: (id: string) => `tm.m.msgs.${id}`,
  queue: "tm.m.queue",
};
interface Queued {
  cid: string;
  thread: string; // 对话 id，或 NEW
  text: string;
  event: boolean;
  written_at: string;
  error?: string;
}
const load = <T,>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
};
const save = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* 存满了就算了，下次联网再取 */
  }
};
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
/** 网络层失败（Mac 没开 / 不在同一个 WiFi / 证书没信任），不是服务返回的错误 */
const isOffline = (e: unknown) => !(e instanceof ApiError);
const when = (iso: string) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? hm(iso) : `${d.getMonth() + 1}/${d.getDate()} ${hm(iso)}`;
};
async function ping(): Promise<boolean> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch("/api/mobile/ping", { signal: ctl.signal, cache: "no-store" });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export function MobileApp() {
  const [token, setToken] = useState(() => localStorage.getItem(MOBILE_TOKEN_KEY));
  // 在 Mac 本机打开（127.0.0.1）不需要配对：本机接口本来就不要令牌
  const local = ["127.0.0.1", "localhost"].includes(location.hostname);
  if (!token && !local) return <Pairing onPaired={(t) => (localStorage.setItem(MOBILE_TOKEN_KEY, t), setToken(t))} />;
  return (
    <MobileChat
      onUnpaired={() => {
        localStorage.removeItem(MOBILE_TOKEN_KEY);
        setToken(null);
      }}
    />
  );
}

function Pairing({ onPaired }: { onPaired: (token: string) => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("iPhone");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const standalone = (navigator as any).standalone === true || matchMedia("(display-mode: standalone)").matches;

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/mobile/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code.trim(), name }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || tr("配对失败（{0}）", [r.status]));
      onPaired(j.token);
    } catch (e) {
      setErr(e instanceof TypeError ? tr("连不上 Mac：确认手机和 Mac 在同一个 WiFi，Mac 没有睡眠，并且已经安装并信任了本地证书") : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="m-pair">
      <img className="m-pair-icon" src="/m/icon-smile-180.png" alt={tr("时间记录")} />
      <h2>{tr("连接到你的 Mac")}</h2>
      {!standalone && (
        <p className="m-hint">
          {tr("建议先点 Safari 的分享按钮 ›")} <b>{tr("添加到主屏幕")}</b>{tr("，再从主屏幕打开后配对（主屏幕上的应用和 Safari 是分开保存的）。")}
        </p>
      )}
      <p className="muted">{tr("在 Mac 上打开“设置 › 手机”，点“生成配对码”，把 6 位数字填在这里。")}</p>
      <input className="m-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="000000" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
      <label className="m-field">
        {tr("这台手机叫")}
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <button className="primary m-wide" disabled={busy || code.length !== 6} onClick={submit}>
        {busy ? tr("配对中…") : tr("配对")}
      </button>
      {err && <div className="error-text">{err}</div>}
    </div>
  );
}

function MobileChat({ onUnpaired }: { onUnpaired: () => void }) {
  const [meta, setMeta] = useState<Meta | null>(() => load<Meta | null>(K.meta, null));
  const [threads, setThreads] = useState<ChatThread[]>(() => load(K.threads, []));
  const [threadId, setThreadIdRaw] = useState<string>(() => load(K.thread, NEW));
  const [messages, setMessages] = useState<ChatMessage[]>(() => load(K.msgs(load(K.thread, NEW)), []));
  const [queue, setQueueRaw] = useState<Queued[]>(() => load(K.queue, []));
  const [online, setOnline] = useState<boolean | null>(null);
  const [sendingCid, setSendingCid] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sheet, setSheet] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  // 刷新和发送在异步回调里需要最新值
  const qRef = useRef(queue);
  const tRef = useRef(threadId);
  const flushing = useRef(false);

  const setQueue = (q: Queued[]) => {
    qRef.current = q;
    save(K.queue, q);
    setQueueRaw(q);
  };
  const setThreadId = (id: string) => {
    tRef.current = id;
    save(K.thread, id);
    setThreadIdRaw(id);
    setMessages(id === NEW ? [] : load(K.msgs(id), []));
  };
  const handle = (e: unknown) => {
    if (e instanceof ApiError && e.status === 401) onUnpaired();
    else if (isOffline(e)) setOnline(false);
    else setNotice((e as Error).message);
  };

  async function refresh() {
    try {
      const [m, ts] = await Promise.all([api.meta(), api.chatThreads()]);
      if (m.language && m.language !== lang) {
        localStorage.setItem("ui.lang", m.language);
        location.reload();
        return;
      }
      setMeta(m);
      save(K.meta, m);
      setThreads(ts);
      save(K.threads, ts);
      setOnline(true);
      let id = tRef.current;
      if (id !== NEW && !ts.some((t) => t.id === id)) id = ts[0]?.id ?? NEW; // 在 Mac 上删掉了
      if (id !== tRef.current) setThreadId(id);
      if (id !== NEW) {
        const list = await api.chatList(id);
        save(K.msgs(id), list);
        if (tRef.current === id) setMessages(list);
      }
    } catch (e) {
      handle(e);
    }
  }

  /** 按顺序发出存着的消息；连不上就停下，等下次 */
  async function flush() {
    if (flushing.current || !qRef.current.some((q) => !q.error)) return;
    flushing.current = true;
    try {
      if (!(await ping())) return setOnline(false);
      setOnline(true);
      while (true) {
        const q = qRef.current.find((x) => !x.error);
        if (!q) break;
        let tid = q.thread;
        if (tid === NEW) {
          tid = (await api.chatNewThread()).id;
          setQueue(qRef.current.map((x) => (x.thread === NEW ? { ...x, thread: tid } : x)));
          if (tRef.current === NEW) setThreadId(tid);
        }
        setSendingCid(q.cid);
        try {
          await api.chatSend(tid, q.text, q.event, { client_id: q.cid, written_at: q.written_at });
          setQueue(qRef.current.filter((x) => x.cid !== q.cid));
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) break; // 正在处理，下次再取结果
          if (e instanceof ApiError && e.status !== 401) {
            // AI 出错之类：标出来，不自动重试，点“重试”再发
            setQueue(qRef.current.map((x) => (x.cid === q.cid ? { ...x, error: e.message } : x)));
            continue;
          }
          throw e;
        }
        const list = await api.chatList(tid);
        save(K.msgs(tid), list);
        if (tRef.current === tid) setMessages(list);
      }
      api.chatThreads().then((ts) => (setThreads(ts), save(K.threads, ts))).catch(() => {});
    } catch (e) {
      handle(e);
    } finally {
      flushing.current = false;
      setSendingCid(null);
    }
  }

  useEffect(() => {
    refresh().then(flush);
    const wake = () => document.visibilityState === "visible" && refresh().then(flush);
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    // 有没发出的消息时，每 20 秒试一次
    const t = setInterval(() => qRef.current.some((q) => !q.error) && flush(), 20_000);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      clearInterval(t);
    };
  }, []);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, queue.length, sendingCid]);

  function send(msg: string, event = false) {
    const m = msg.trim();
    if (!m) return;
    if (!event) setText("");
    setQueue([...qRef.current, { cid: uid(), thread: tRef.current, text: m, event, written_at: new Date().toISOString() }]);
    setTimeout(flush, 0);
  }

  async function act(msg: ChatMessage, idx: number, apply: boolean) {
    setBusyAction(`${msg.id}:${idx}`);
    setNotice(null);
    try {
      let updated: ChatMessage;
      if (!apply) updated = await api.chatAction(msg.id, idx, { status: "dismissed" });
      else {
        try {
          const result = await applyAction(msg.actions[idx]);
          updated = await api.chatAction(msg.id, idx, { status: "applied", result });
        } catch (e) {
          if (isOffline(e)) throw e;
          updated = await api.chatAction(msg.id, idx, { status: "failed", error: (e as Error).message });
        }
        api.meta().then((m) => (setMeta(m), save(K.meta, m))).catch(() => {});
      }
      setMessages((x) => {
        const next = x.map((m) => (m.id === updated.id ? updated : m));
        save(K.msgs(tRef.current), next);
        return next;
      });
    } catch (e) {
      if (isOffline(e)) {
        setOnline(false);
        setNotice(tr("连不上 Mac，改动要等连上后才能应用"));
      } else handle(e);
    } finally {
      setBusyAction(null);
    }
  }

  // 主屏幕应用没有刷新按钮：服务更新后在顶部提示
  const updated = useAppRefresh(() => {});
  const pending = queue.filter((q) => q.thread === threadId);
  const waiting = queue.filter((q) => !q.error).length;
  const cur = threads.find((t) => t.id === threadId);
  const last = messages[messages.length - 1];
  const scoreHere = lastScoreAction(messages);

  return (
    <div className="m-app">
      {updated && (
        <button className="m-update" onClick={() => location.reload()}>
          {tr("有新版本 · 点此刷新")}
        </button>
      )}
      <header className="m-head">
        <button className="m-icon-btn" onClick={() => setSheet(true)} aria-label={tr("对话列表")}>
          ☰
        </button>
        <div className="m-title">
          <strong>{cur?.title ?? tr("新对话")}</strong>
          <span className={`m-status ${online === false ? "off" : online ? "on" : ""}`}>
            {online === false ? tr("连不上 Mac{0}", [waiting ? tr(" · {0} 条待发送", [waiting]) : ""]) : online ? (sendingCid ? tr("发送中…") : tr("已连接")) : tr("连接中…")}
          </span>
        </div>
        <button className="m-icon-btn" onClick={() => setThreadId(NEW)} aria-label={tr("新对话")}>
          {tr("＋")}
        </button>
      </header>

      <main className="m-scroll">
        {messages.length === 0 && pending.length === 0 && (
          <div className="m-empty">
            <p className="muted">{tr("说说刚才做了什么，或者想怎么安排")}</p>
            <div className="chips">
              {[tr("刚才这一个小时在看论文"), tr("今天的时间都去哪了"), tr("这周目标进展怎么样？")].map((s) => (
                <button key={s} className="chip" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) =>
          m.role === "event" ? (
            <div key={m.id} className="event-line">
              {m.content}
            </div>
          ) : (
            <div key={m.id} className={`bubble-row ${m.role}`}>
              <div className={`bubble ${m.role}`}>
                <div className="bubble-text">{m.role === "assistant" ? <RichText text={m.content} /> : m.content}</div>
                {m.role === "user" && m.written_at && Date.parse(m.created_at) - Date.parse(m.written_at) > 120_000 && (
                  <div className="m-written">{tr("写于")} {when(m.written_at)}{tr("，连上后发出")}</div>
                )}
                {meta && m.actions.length > 0 && (
                  <div className="action-list">
                    {m.actions.map((a, i) => (
                      <ActionCard
                        key={i}
                        a={a}
                        scoreHere={scoreHere.has(`${m.id}:${i}`)}
                        meta={meta}
                        busy={!!busyAction || online === false}
                        onApply={() => act(m, i, true)}
                        onDismiss={() => act(m, i, false)}
                        onDataChanged={() => api.meta().then((x) => (setMeta(x), save(K.meta, x))).catch(() => {})}
                        onScoreConfirmed={(e) => send(tr("已确认「{0}」的评分：{1} 分", [e.title ?? e.raw_text.slice(0, 20), e.score?.overall]), true)}
                        onOpenEntry={() => setNotice(tr("记录详情请在 Mac 上查看"))}
                      />
                    ))}
                  </div>
                )}
                {m.role === "assistant" && m === last && pending.length === 0 && m.quick_replies.length > 0 && (
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
        {pending.map((q) =>
          q.event ? (
            <div key={q.cid} className="event-line">
              {q.text} {tr("· 待发送")}
            </div>
          ) : (
            <div key={q.cid} className="bubble-row user">
              <div className={`bubble user m-queued${q.error ? " failed" : ""}`}>
                <div className="bubble-text">{q.text}</div>
                <div className="m-q-state">
                  {q.error ? (
                    <>
                      {tr("发送失败：")}{q.error}
                      <button
                        className="link small"
                        onClick={() => {
                          setQueue(qRef.current.map((x) => (x.cid === q.cid ? { ...x, error: undefined } : x)));
                          setTimeout(flush, 0);
                        }}
                      >
                        {tr("重试")}
                      </button>
                      <button className="link small" onClick={() => setQueue(qRef.current.filter((x) => x.cid !== q.cid))}>
                        {tr("删除")}
                      </button>
                    </>
                  ) : sendingCid === q.cid ? (
                    tr("发送中…")
                  ) : (
                    tr("{0} · 等连上 Mac 后发送", [when(q.written_at)])
                  )}
                </div>
              </div>
            </div>
          ),
        )}
        {sendingCid && pending.some((q) => q.cid === sendingCid) && (
          <div className="bubble-row assistant">
            <div className="bubble assistant typing">{tr("思考中…")}</div>
          </div>
        )}
        <div ref={endRef} />
      </main>

      {notice && (
        <div className="m-notice" onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}
      <footer className="m-input">
        <textarea rows={1} placeholder={online === false ? tr("连不上 Mac，先写下来，连上后自动发送") : tr("说说做了什么…")} value={text} onChange={(e) => setText(e.target.value)} />
        {meta && <VoiceButton serverAsr={meta.asr.server} onText={(t) => setText((p) => (p ? tr("{0}，{1}", [p, t]) : t))} />}
        <button className="primary" disabled={!text.trim()} onClick={() => send(text)}>
          {tr("发送")}
        </button>
      </footer>

      {sheet && (
        <div className="m-sheet-bg" onClick={() => setSheet(false)}>
          <div className="m-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="m-sheet-head">
              <strong>{tr("对话")}</strong>
              <button
                className="primary"
                onClick={() => {
                  setThreadId(NEW);
                  setSheet(false);
                }}
              >
                {tr("＋ 新对话")}
              </button>
            </div>
            <div className="m-sheet-list">
              {threads.map((t) => (
                <button
                  key={t.id}
                  className={`thread-item${t.id === threadId ? " on" : ""}`}
                  onClick={() => {
                    setThreadId(t.id);
                    setSheet(false);
                    refresh();
                  }}
                >
                  <span className="thread-title">{t.title}</span>
                  <span className="thread-meta muted">
                    {when(t.updated_at)} · {t.count} {tr("条")}
                  </span>
                </button>
              ))}
              {threads.length === 0 && <div className="muted small">{tr("还没有对话")}</div>}
            </div>
            <p className="muted small">{tr("对话改名、删除请在 Mac 上操作。")}</p>
          </div>
        </div>
      )}
    </div>
  );
}
