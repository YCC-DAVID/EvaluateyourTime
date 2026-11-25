import type { CSSProperties } from "react";
import { tr } from "../i18n.ts";

// 进度拖条：实色是原来的进度，浅色是这次拖动的变化（倒退时为红色），右侧显示变化量。
// onCommit 在松手或键盘调整结束时触发，用于需要立即保存的地方。

export function ProgressSlider(props: {
  value: number;
  base: number;
  color: string;
  disabled?: boolean;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
}) {
  const { value, base } = props;
  const lo = Math.min(value, base);
  const hi = Math.max(value, base);
  const delta = value - base;
  const commit = () => props.onCommit?.(value);
  return (
    <span className={`pslider-wrap${props.disabled ? " disabled" : ""}`}>
      <input
        type="range"
        className="pslider"
        min={0}
        max={100}
        step={1}
        value={value}
        disabled={props.disabled}
        aria-label={tr("进度")}
        style={
          {
            "--c": props.color,
            "--d": delta < 0 ? "color-mix(in srgb, var(--poor) 55%, transparent)" : `color-mix(in srgb, ${props.color} 40%, transparent)`,
            "--lo": `${lo}%`,
            "--hi": `${hi}%`,
          } as CSSProperties
        }
        onChange={(e) => props.onChange(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
      />
      <span className="pslider-val">
        {value}%
        {delta !== 0 && <span className={delta > 0 ? "up" : "down"}>{delta > 0 ? ` +${delta}` : ` ${delta}`}</span>}
      </span>
    </span>
  );
}
