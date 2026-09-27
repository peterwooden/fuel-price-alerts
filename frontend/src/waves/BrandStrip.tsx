import React, { useRef, useState } from 'react';
import { arrivalColor, ink } from './colors';
import { timeTicks } from './ticks';
import { formatWithin } from './time';
import { useWidth } from './useWidth';

export interface StripDot {
    /** Index into the page's station list. */
    station: number;
    at: number;
    /** Position in the order stations moved, 0 (first) to 1 (last). */
    order: number;
}

export interface StripRow {
    brand: string;
    total: number;
    moved: number;
    median: number | null;
    dots: StripDot[];
}

interface Props {
    rows: StripRow[];
    domain: [number, number];
    highlight: number | null;
    onHover: (station: number | null) => void;
    describe: (station: number) => { name: string; detail: string };
}

const LABEL_W = 154;
const ROW_H = 34;
const AXIS_H = 22;
const R = 4;

/** Deterministic vertical jitter so stations at the same time don't hide each other. */
const jitter = (station: number) => ((((station * 2654435761) >>> 0) % 1000) / 1000 - 0.5) * (ROW_H - 2 * R - 8);

export function BrandStrip({ rows, domain, highlight, onHover, describe }: Props) {
    const ref = useRef<HTMLDivElement>(null);
    const width = useWidth(ref, 400);
    const plotW = Math.max(80, width - LABEL_W - 12);
    const [t0, t1] = domain;
    const x = (t: number) => LABEL_W + ((t - t0) / (t1 - t0 || 1)) * plotW;
    const height = rows.length * ROW_H + AXIS_H;
    const [hover, setHover] = useState<{ station: number; x: number; y: number } | null>(null);
    const when = (t: number) => formatWithin(t, t1 - t0);

    const onMove = (e: React.PointerEvent) => {
        const box = ref.current!.getBoundingClientRect();
        const px = e.clientX - box.left;
        const py = e.clientY - box.top;
        const row = rows[Math.floor(py / ROW_H)];
        let best: { station: number; x: number; y: number } | null = null;
        let bestD = 12 * 12;
        if (row) {
            const cy = Math.floor(py / ROW_H) * ROW_H + ROW_H / 2;
            for (const dot of row.dots) {
                const dx = x(dot.at);
                const dy = cy + jitter(dot.station);
                const d = (dx - px) ** 2 + (dy - py) ** 2;
                if (d < bestD) {
                    bestD = d;
                    best = { station: dot.station, x: dx, y: dy };
                }
            }
        }
        setHover(best);
        onHover(best?.station ?? null);
    };

    return (
        <div ref={ref} className="waves-chart relative">
            <svg
                width={width}
                height={height}
                onPointerMove={onMove}
                onPointerLeave={() => {
                    setHover(null);
                    onHover(null);
                }}
                role="img"
                aria-label="When stations of each brand moved"
            >
                {timeTicks(t0, t1, Math.max(2, Math.floor(plotW / 70))).map(({ t, label }) => (
                    <g key={t}>
                        <line x1={x(t)} x2={x(t)} y1={0} y2={rows.length * ROW_H} stroke={ink.grid} />
                        <text x={x(t)} y={height - 6} textAnchor="middle" className="waves-tick">
                            {label}
                        </text>
                    </g>
                ))}
                {rows.map((row, i) => {
                    const cy = i * ROW_H + ROW_H / 2;
                    return (
                        <g key={row.brand}>
                            <text x={0} y={cy - 2} className="waves-row-label">
                                {row.brand}
                            </text>
                            <text x={0} y={cy + 12} className="waves-tick">
                                {row.moved} of {row.total}
                                {row.median !== null && ` · ${when(row.median)}`}
                            </text>
                            {row.dots.map((dot) => (
                                <circle
                                    key={dot.station}
                                    cx={x(dot.at)}
                                    cy={cy + jitter(dot.station)}
                                    r={dot.station === highlight ? R + 2 : R}
                                    fill={arrivalColor(dot.order)}
                                    stroke={dot.station === highlight ? ink.primary : ink.surface}
                                    strokeWidth={dot.station === highlight ? 2 : 1.5}
                                />
                            ))}
                            {row.median !== null && (
                                <line x1={x(row.median)} x2={x(row.median)} y1={cy - ROW_H / 2 + 3} y2={cy + ROW_H / 2 - 3} stroke={ink.primary} strokeWidth={2} />
                            )}
                            <line x1={LABEL_W} x2={LABEL_W + plotW} y1={(i + 1) * ROW_H} y2={(i + 1) * ROW_H} stroke={ink.grid} />
                        </g>
                    );
                })}
            </svg>
            {hover && (
                <div className="waves-tooltip" style={{ left: Math.min(hover.x + 12, width - 220), top: hover.y + 10 }}>
                    <div className="waves-tooltip-title">{describe(hover.station).name}</div>
                    <div>{describe(hover.station).detail}</div>
                </div>
            )}
        </div>
    );
}
