import { useRef, useState } from "react";

// 单序列阶梯折线图：进度、累计时长都是“到某个时刻跳变一次”的量，用阶梯线而不是斜线连接。
// 一张图只画一个量（不做双纵轴）；悬停时竖线吸附到最近的数据点，提示框显示该点详情。
//
// 横轴是“距现在多久”的对数刻度：x ∝ log(1 + 距今时长 / 1 小时)，最右边是现在。
// 最近一天占大部分宽度，越早的时间压缩得越厉害，这样刚做的事不会挤成一个点。
// 有未到期的 DDL 时，右侧约三分之一是“未来”区，同样按对数刻度画到 DDL，能看出还剩多远。

export interface StepPoint {
  t: number; // epoch ms
  v: number;
  /** 提示框内容：第一行是数值，其余是说明 */
  tip: string[];
}

const W = 360;
const H = 150;
const M = { top: 12, right: 44, bottom: 22, left: 34 };

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const f = (age: number) => Math.log1p(Math.max(0, age) / HOUR);

// 候选刻度（距今时长）；实际只取不重叠的几个
const TICK_AGES = [0, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 3 * DAY, 5 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 60 * DAY, 90 * DAY];
const fmtAge = (age: number) => (age === 0 ? "现在" : age < DAY ? `${age / HOUR}小时前` : `${age / DAY}天前`);

export function StepChart(props: {
  title: string;
  points: StepPoint[]; // 按时间升序；第一个点是起点
  /** 横轴最早的时刻（通常是目标创建时间） */
  start: number;
  yMax: number;
  yTicks: number[];
  yFormat: (v: number) => string;
  color: string;
  now: number;
  /** 截止时间；在未来时画出未来区和 DDL 线，已过期时在过去区标出 */
  ddl?: number | null;
  /** 到 DDL 时应达到的值（进度图为 100），画一条从现在到 DDL 的虚线表示需要的节奏 */
  pace?: number;
}) {
  const { points, yMax, color, now } = props;
  const ddl = props.ddl ?? null;
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;
  // 至少显示最近一天，刻度才稳定
  const maxAge = Math.max(now - props.start, DAY);
  const future = ddl != null && ddl > now + HOUR;
  const nowX = M.left + iw * (future ? 0.68 : 1);
  const x = (t: number) =>
    t <= now
      ? M.left + (nowX - M.left) * (1 - f(now - t) / f(maxAge))
      : nowX + (M.left + iw - nowX) * (future ? Math.min(1, f(t - now) / f(ddl! - now)) : 0);
  const y = (v: number) => M.top + ih - (Math.min(v, yMax) / yMax) * ih;

  // 阶梯路径：每个点水平延续到下一个点再竖直跳变，最后延续到“现在”
  let d = "";
  points.forEach((p, i) => {
    d += i === 0 ? `M${x(p.t)},${y(p.v)}` : `H${x(p.t)}V${y(p.v)}`;
  });
  const endT = now;
  if (points.length) d += `H${x(endT)}`;
  const area = points.length ? `${d}V${y(0)}H${x(points[0].t)}Z` : "";

  // x 轴刻度：从“现在”往前取，彼此至少隔 54 个单位（中文标签约 45 宽），避免文字重叠
  const ticks: number[] = [];
  for (const age of TICK_AGES) {
    if (age > maxAge) break;
    const px = x(now - age);
    if (ticks.every((a) => Math.abs(x(now - a) - px) >= 54)) ticks.push(age);
  }
  // 未来区刻度：+1天、+3天……，DDL 本身单独标
  const futureTicks: number[] = [];
  if (future) {
    for (const ahead of [DAY, 2 * DAY, 3 * DAY, 7 * DAY, 14 * DAY, 30 * DAY]) {
      if (ahead >= ddl! - now) break;
      const px = x(now + ahead);
      // 和“现在”、DDL 标签、已有的未来刻度都要隔开
      if (px - nowX >= 40 && M.left + iw - px >= 40 && futureTicks.every((t) => px - x(now + t) >= 36)) futureTicks.push(ahead);
    }
  }
  // 按日历日算剩几天，和目标卡片上的“还剩 N 天”一致
  const dayStart = (t: number) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const daysLeft = ddl != null ? Math.round((dayStart(ddl) - dayStart(now)) / DAY) : null;

  const onMove = (e: React.PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    let bestDist = Infinity;
    points.forEach((p, i) => {
      const dist = Math.abs(x(p.t) - px);
      if (dist < bestDist) { bestDist = dist; best = i; }
    });
    setHover(points.length ? best : null);
  };

  const last = points.at(-1);
  const hp = hover != null ? points[hover] : null;

  return (
    <figure className="stepchart">
      <figcaption>{props.title}</figcaption>
      <div className="stepchart-plot">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`${props.title}：${last ? props.yFormat(last.v) : "无数据"}`}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {props.yTicks.map((v) => (
            <g key={v}>
              <line className="grid" x1={M.left} x2={W - M.right} y1={y(v)} y2={y(v)} />
              <text className="axis" x={M.left - 6} y={y(v) + 4} textAnchor="end">
                {props.yFormat(v)}
              </text>
            </g>
          ))}
          {future && <rect className="future-zone" x={nowX} y={M.top} width={M.left + iw - nowX} height={ih} />}
          {ticks.map((age) => {
            const tx = x(now - age);
            return (
              <g key={age}>
                {/* 竖向细线提示刻度不均匀 */}
                <line className={`grid vgrid${age === 0 && future ? " now" : ""}`} x1={tx} x2={tx} y1={M.top} y2={M.top + ih} />
                <text className="axis" x={tx} y={H - 6} textAnchor={age === 0 && !future ? "end" : "middle"}>
                  {fmtAge(age)}
                </text>
              </g>
            );
          })}
          {futureTicks.map((ahead) => (
            <g key={`f${ahead}`}>
              <line className="grid vgrid" x1={x(now + ahead)} x2={x(now + ahead)} y1={M.top} y2={M.top + ih} />
              <text className="axis" x={x(now + ahead)} y={H - 6} textAnchor="middle">
                +{ahead / DAY}天
              </text>
            </g>
          ))}
          {ddl != null && (future || (ddl >= props.start && ddl <= now)) && (
            <g>
              <line className="ddl-line" x1={x(ddl)} x2={x(ddl)} y1={M.top} y2={M.top + ih} />
              <text className="axis ddl-text" x={x(ddl) - 3} y={M.top + 10} textAnchor="end">
                {future ? (daysLeft === 0 ? "DDL · 今天截止" : `DDL · 剩 ${daysLeft} 天`) : "DDL（已过）"}
              </text>
              {future && (
                <text className="axis ddl-text" x={x(ddl)} y={H - 6} textAnchor="end">
                  DDL
                </text>
              )}
            </g>
          )}
          {future && props.pace != null && points.length > 0 && (
            <line className="pace-line" x1={nowX} y1={y(points.at(-1)!.v)} x2={x(ddl!)} y2={y(props.pace)} stroke={color} />
          )}
          {area && <path d={area} fill={color} opacity={0.1} />}
          {d && <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />}
          {points.slice(1).map((p, i) => (
            <circle key={i} cx={x(p.t)} cy={y(p.v)} r={4} fill={color} stroke="var(--card)" strokeWidth={2} />
          ))}
          {last && (
            <text
              className="direct-label"
              x={future ? x(endT) - 6 : x(endT) + 6}
              y={future ? y(last.v) - 7 : y(last.v) + 4}
              textAnchor={future ? "end" : "start"}
            >
              {props.yFormat(last.v)}
            </text>
          )}
          {hp && (
            <g pointerEvents="none">
              <line className="crosshair" x1={x(hp.t)} x2={x(hp.t)} y1={M.top} y2={M.top + ih} />
              <circle cx={x(hp.t)} cy={y(hp.v)} r={6} fill={color} stroke="var(--card)" strokeWidth={2} />
            </g>
          )}
        </svg>
        {hp && (
          <div className="chart-tip" style={{ left: `${(x(hp.t) / W) * 100}%`, top: `${(y(hp.v) / H) * 100}%` }}>
            <div className="tip-head">
              <i style={{ background: color }} />
              <strong>{hp.tip[0]}</strong>
            </div>
            {hp.tip.slice(1).map((line, i) => (
              <div key={i} className="tip-line">
                {line}
              </div>
            ))}
          </div>
        )}
      </div>
    </figure>
  );
}
