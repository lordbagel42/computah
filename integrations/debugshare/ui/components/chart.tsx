import { useId, useState } from "react";
import { fmtDate, fmtTime } from "../lib.js";

type Series = { label: string; color: string; times: number[] };

const two = (n: number) => String(n).padStart(2, "0");
const tick = (t: number, span: number) => {
  const d = new Date(t);
  return span > 2 * 86_400_000
    ? `${d.toLocaleString(undefined, { month: "short" })} ${d.getDate()}`
    : `${two(d.getHours())}:${two(d.getMinutes())}`;
};

/** Axiom-style bucketed line chart over real timestamps (counts per bucket). */
export function TimeChart({
  series,
  height = 150,
  buckets = 48,
  label,
  width = 600,
}: {
  series: Series[];
  height?: number;
  buckets?: number;
  label: string;
  width?: number;
}) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const all = series.flatMap((s) => s.times).filter(Number.isFinite);
  if (all.length === 0)
    return (
      <p className="px-3 py-6 text-center font-mono text-[12px] text-faint">
        No timestamps to chart
      </p>
    );
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (max - min < 60_000) {
    min -= 30_000;
    max += 30_000;
  }
  const pad = (max - min) * 0.02;
  min -= pad;
  max += pad;
  const left = 34;
  const right = 8;
  const top = 10;
  const bottom = 22;
  const step = (max - min) / buckets;
  const counts = series.map((s) => {
    const c = new Array<number>(buckets).fill(0);
    for (const t of s.times)
      c[Math.min(buckets - 1, Math.floor((t - min) / step))]++;
    return c;
  });
  const peak = Math.max(1, ...counts.flat());
  const yTicks = [...new Set([0, Math.ceil(peak / 2), peak])];
  const x = (i: number) => left + ((width - left - right) * i) / buckets;
  const y = (v: number) => top + (height - top - bottom) * (1 - v / peak);
  const span = max - min;
  const xTicks = Array.from(
    { length: 5 },
    (_, i) => min + (span * (i + 0.5)) / 5,
  );
  const summary = series.map((s) => `${s.times.length} ${s.label}`).join(", ");
  return (
    <div className="px-2 pb-2 pt-1">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 pb-1 font-mono text-[11.5px] text-muted-foreground">
        {series.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <span
              className="h-0.5 w-3 rounded"
              style={{ background: s.color }}
            />
            {s.label} <span className="text-foreground">{s.times.length}</span>
          </span>
        ))}
        {hover !== null && (
          <span className="ml-auto tabular text-foreground">
            {fmtDate(new Date(min + hover * step))} →{" "}
            {fmtTime(new Date(min + (hover + 1) * step))}:{" "}
            {counts.map((c, i) => `${c[hover]} ${series[i].label}`).join(", ")}
          </span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${label}: ${summary} between ${fmtDate(new Date(min))} and ${fmtDate(new Date(max))}`}
        onMouseLeave={() => setHover(null)}
      >
        <title>{label}</title>
        {yTicks.map((v) => (
          <g key={v}>
            <line
              x1={left}
              x2={width - right}
              y1={y(v)}
              y2={y(v)}
              stroke="#232323"
            />
            <text
              x={left - 6}
              y={y(v) + 3}
              textAnchor="end"
              className="fill-[#6b6b6b] font-mono text-[9px]"
            >
              {v}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text
            key={t}
            x={x((t - min) / step)}
            y={height - 6}
            textAnchor="middle"
            className="fill-[#6b6b6b] font-mono text-[9px]"
          >
            {tick(t, span)}
          </text>
        ))}
        {counts.map((c, si) => {
          const points = c
            .map((v, i) => `${x(i)},${y(v)} ${x(i + 1)},${y(v)}`)
            .join(" ");
          return (
            <g key={series[si].label}>
              <defs>
                <linearGradient id={`${id}${si}`} x1="0" x2="0" y1="0" y2="1">
                  <stop
                    offset="0"
                    stopColor={series[si].color}
                    stopOpacity="0.18"
                  />
                  <stop
                    offset="1"
                    stopColor={series[si].color}
                    stopOpacity="0"
                  />
                </linearGradient>
              </defs>
              <polygon
                points={`${x(0)},${y(0)} ${points} ${x(buckets)},${y(0)}`}
                fill={`url(#${id}${si})`}
              />
              <polyline
                points={points}
                fill="none"
                stroke={series[si].color}
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </g>
          );
        })}
        {hover !== null && (
          <rect
            x={x(hover)}
            y={top}
            width={x(1) - x(0)}
            height={height - top - bottom}
            fill="#ffffff"
            opacity="0.05"
          />
        )}
        {counts[0].map((_, i) => (
          // biome-ignore lint/a11y/noStaticElementInteractions: pointer readout only; the svg aria-label carries the totals
          <rect
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed buckets
            key={i}
            x={x(i)}
            y={top}
            width={x(1) - x(0)}
            height={height - top - bottom}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </svg>
    </div>
  );
}

/** One horizontal stacked bar of status counts. */
export function StatusBar({
  counts,
  colors,
}: {
  counts: [string, number][];
  colors: Record<string, string>;
}) {
  const total = counts.reduce((a, [, n]) => a + n, 0) || 1;
  return (
    <div
      className="flex h-2 w-full overflow-hidden rounded-full bg-secondary"
      role="img"
      aria-label={counts.map(([s, n]) => `${n} ${s}`).join(", ")}
    >
      {counts.map(([s, n]) =>
        n ? (
          <span
            key={s}
            style={{ width: `${(100 * n) / total}%`, background: colors[s] }}
          />
        ) : null,
      )}
    </div>
  );
}
