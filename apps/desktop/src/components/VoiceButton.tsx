import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { locale, tr } from "../i18n.ts";

// 语音输入：配置了服务端转写时录音上传；否则使用浏览器自带的语音识别。
// 转写结果只是追加到文本框里，用户可以先修改再分析。

type SR = any;
const SpeechRecognitionCtor: SR | undefined =
  typeof window !== "undefined" ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : undefined;

export function VoiceButton({ serverAsr, onText }: { serverAsr: boolean; onText: (t: string) => void }) {
  const [state, setState] = useState<"idle" | "listening" | "transcribing">("idle");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<SR | null>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);

  const supported = serverAsr ? typeof MediaRecorder !== "undefined" : !!SpeechRecognitionCtor;

  useEffect(() => () => { recRef.current?.abort?.(); mediaRef.current?.stream.getTracks().forEach((t) => t.stop()); }, []);

  async function start() {
    setError(null);
    if (serverAsr) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mr = new MediaRecorder(stream);
        const chunks: Blob[] = [];
        mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        mr.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop());
          setState("transcribing");
          try {
            const text = await api.asr(new Blob(chunks, { type: mr.mimeType }));
            if (text.trim()) onText(text.trim());
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setState("idle");
          }
        };
        mediaRef.current = mr;
        mr.start();
        setState("listening");
      } catch {
        setError(tr("无法使用麦克风（检查浏览器权限）"));
      }
      return;
    }
    const rec = new SpeechRecognitionCtor();
    rec.lang = locale;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (ev: any) => {
      let finalText = "";
      let tmp = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else tmp += r[0].transcript;
      }
      if (finalText) onText(finalText);
      setInterim(tmp);
    };
    rec.onerror = (ev: any) => {
      setError(ev.error === "not-allowed" ? tr("麦克风权限被拒绝") : ev.error === "network" ? tr("语音识别需要联网") : tr("语音识别出错：{0}", [ev.error]));
    };
    rec.onend = () => {
      setState("idle");
      setInterim("");
    };
    recRef.current = rec;
    rec.start();
    setState("listening");
  }

  function stop() {
    if (serverAsr) mediaRef.current?.stop();
    else recRef.current?.stop();
  }

  if (!supported)
    return (
      <span className="muted small" title={tr("当前浏览器不支持语音识别；可在 .env 配置 ASR 服务")}>
        {tr("语音不可用")}
      </span>
    );

  return (
    <span className="voice">
      <button
        type="button"
        className={`mic${state === "listening" ? " on" : ""}`}
        onClick={state === "listening" ? stop : start}
        disabled={state === "transcribing"}
      >
        {state === "listening" ? tr("■ 停止") : state === "transcribing" ? tr("转写中…") : tr("🎙 语音")}
      </button>
      {interim && <span className="muted small">{interim}</span>}
      {error && <span className="error-text small">{error}</span>}
    </span>
  );
}
