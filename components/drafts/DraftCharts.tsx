import type { ReactNode } from "react";

function ChartFrame({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="relative h-[220px] w-full overflow-hidden rounded-lg border border-line bg-surface-2 p-3" role="img" aria-label={label}>
      <div className="pointer-events-none absolute inset-x-3 bottom-8 top-3 flex flex-col justify-between" aria-hidden>
        {[0, 1, 2, 3].map((line) => <span key={line} className="block h-px bg-line/70" />)}
      </div>
      {children}
    </div>
  );
}

export function UtilizationChart({ values }: { values: readonly number[] }) {
  const width = 720;
  const height = 164;
  const max = 100;
  const gap = 5;
  const barWidth = (width - gap * (values.length - 1)) / values.length;

  return (
    <ChartFrame label="Sample charger utilization across 24 hours">
      <svg viewBox={`0 0 ${width} 200`} className="relative z-10 h-full w-full" preserveAspectRatio="none">
        {values.map((value, index) => {
          const barHeight = (value / max) * height;
          const x = index * (barWidth + gap);
          const y = height - barHeight + 8;
          return (
            <g key={index}>
              <title>{`${String(index).padStart(2, "0")}:00 · ${value}% utilization`}</title>
              <rect x={x} y={y} width={barWidth} height={barHeight} rx={3} fill="var(--accent)" opacity={0.2 + value / 140} />
              {index % 4 === 0 && (
                <text x={x + barWidth / 2} y={192} textAnchor="middle" fill="var(--ink-3)" fontSize="10">
                  {String(index).padStart(2, "0")}:00
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </ChartFrame>
  );
}

export function DemandForecastChart({
  actual,
  forecast,
}: {
  actual: readonly number[];
  forecast: readonly number[];
}) {
  const values = [...actual, ...forecast];
  const width = 720;
  const height = 150;
  const max = Math.max(...values) * 1.12;
  const step = width / Math.max(1, values.length - 1);
  const point = (value: number, index: number) => `${index * step},${height - (value / max) * height + 8}`;
  const actualPoints = actual.map(point).join(" ");
  const forecastPoints = forecast.map((value, index) => point(value, index + actual.length - 1)).join(" ");
  const area = `0,${height + 8} ${values.map(point).join(" ")} ${width},${height + 8}`;

  return (
    <ChartFrame label="Sample seven-day battery-swap demand forecast">
      <svg viewBox={`0 0 ${width} 200`} className="relative z-10 h-full w-full" preserveAspectRatio="none">
        <defs>
          <linearGradient id="forecastArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <polygon points={area} fill="url(#forecastArea)" />
        <polyline points={actualPoints} fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <polyline points={forecastPoints} fill="none" stroke="var(--info)" strokeWidth="3" strokeDasharray="8 7" strokeLinecap="round" strokeLinejoin="round" />
        {values.map((value, index) => {
          const [x, y] = point(value, index).split(",").map(Number);
          return (
            <g key={index}>
              <title>{`Day ${index + 1} · ${value} predicted swaps`}</title>
              <circle cx={x} cy={y} r={4} fill={index < actual.length ? "var(--accent)" : "var(--surface)"} stroke="var(--accent)" strokeWidth="2" />
              <text x={x} y={190} textAnchor="middle" fill="var(--ink-3)" fontSize="10">D{index + 1}</text>
            </g>
          );
        })}
      </svg>
    </ChartFrame>
  );
}
