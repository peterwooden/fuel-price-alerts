import React, { useMemo, useRef, useState } from 'react';
import { activity, cityMedian, hourlyGrid, TimeWindow } from './analysis';
import { CUT, ink, RISE } from './colors';
import type { Series } from './data';
import { niceTicks, timeTicks } from './ticks';
import { formatDay, formatDayTime, formatHours, formatTime, HOUR, startOfSydneyDay } from './time';
import { useWidth } from './useWidth';

interface Props {
    series: Series[];
    from: number;
    to: number;
    selection: TimeWindow;
    playhead: number | null;
    /** A click picks that Sydney day; a drag picks the dragged range. */
    onSelect: (win: TimeWindow) => void;
}

const M = { left: 40, right: 8 };
const PRICE_H = 72;
const GAP = 26;
const ACTIVITY_H = 96;
const AXIS_H = 20;
const TOP = 18;
const HEIGHT = TOP + PRICE_H + GAP + ACTIVITY_H + AXIS_H;
const BIN_HOURS = [1, 2, 3, 6, 12, 24];

export function Timeline({ series, from, to, selection, playhead, onSelect }: Props) {
    const ref = useRef<HTMLDivElement>(null);
    const width = useWidth(ref);
    const plotW = Math.max(100, width - M.left - M.right);

    const grid = useMemo(() => hourlyGrid(from, to), [from, to]);
    const medians = useMemo(() => cityMedian(series, grid), [series, grid]);
    const binHours = BIN_HOURS.find((h) => (to - from) / (h * HOUR) <= plotW / 3) ?? 24;
    const act = useMemo(() => activity(series, startOfSydneyDay(from), to, binHours * HOUR), [series, from, to, binHours]);

    const x = (t: number) => M.left + ((t - from) / (to - from)) * plotW;
    const tAt = (px: number) => from + ((px - M.left) / plotW) * (to - from);

    const known = medians.filter((m): m is number => m !== null);
    const priceTicks = niceTicks(Math.min(...known), Math.max(...known), 3);
    const pMin = Math.min(priceTicks[0], ...known);
    const pMax = Math.max(priceTicks[priceTicks.length - 1], ...known);
    const yPrice = (p: number) => TOP + PRICE_H - ((p - pMin) / (pMax - pMin || 1)) * PRICE_H;
    const pricePath = useMemo(() => {
        let d = '';
        medians.forEach((m, i) => {
            if (m === null) return;
            d += `${d ? 'L' : 'M'}${x(grid[i]).toFixed(1)},${yPrice(m).toFixed(1)}`;
        });
        return d;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [medians, grid, plotW, pMin, pMax]);

    const actTop = TOP + PRICE_H + GAP;
    const maxCount = Math.max(1, ...act.rises, ...act.cuts);
    const countTicks = niceTicks(0, maxCount, 2).filter((v) => v > 0);
    const countMax = Math.max(maxCount, countTicks[countTicks.length - 1] ?? 1);
    const zeroY = actTop + ACTIVITY_H / 2;
    const yCount = (n: number) => (n / countMax) * (ACTIVITY_H / 2);
    const binPx = (act.binMs / (to - from)) * plotW;
    const barW = Math.max(1, binPx - (binPx >= 6 ? 2 : binPx >= 3 ? 1 : 0));

    const bars = useMemo(
        () =>
            act.rises.map((rises, i) => {
                const t0 = act.start + i * act.binMs;
                const left = x(t0) + (binPx - barW) / 2;
                if (left + barW < M.left || left > M.left + plotW) return null;
                return (
                    <g key={i}>
                        {rises > 0 && <rect x={left} y={zeroY - yCount(rises)} width={barW} height={yCount(rises)} fill={RISE} />}
                        {act.cuts[i] > 0 && <rect x={left} y={zeroY} width={barW} height={yCount(act.cuts[i])} fill={CUT} />}
                    </g>
                );
            }),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [act, plotW, countMax],
    );

    const [hover, setHover] = useState<number | null>(null);
    const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);
    const localX = (e: React.PointerEvent) => e.clientX - ref.current!.getBoundingClientRect().left;
    const clampX = (px: number) => Math.min(M.left + plotW, Math.max(M.left, px));

    const onPointerDown = (e: React.PointerEvent<SVGRectElement>) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const px = clampX(localX(e));
        setDrag({ x0: px, x1: px });
    };
    const onPointerMove = (e: React.PointerEvent) => {
        const px = clampX(localX(e));
        setHover(px);
        if (drag) setDrag({ ...drag, x1: px });
    };
    const onPointerUp = () => {
        if (!drag) return;
        const [a, b] = [drag.x0, drag.x1].sort((p, q) => p - q);
        setDrag(null);
        if (b - a < 4) {
            const day = startOfSydneyDay(tAt(a));
            onSelect({ start: Math.max(from, day), end: Math.min(to, startOfSydneyDay(day + 25 * HOUR)) });
        } else {
            onSelect({ start: Math.round(tAt(a) / HOUR) * HOUR, end: Math.round(tAt(b) / HOUR) * HOUR });
        }
    };

    const hoverT = hover === null ? null : tAt(hover);
    const hoverBin = hoverT === null ? -1 : Math.floor((hoverT - act.start) / act.binMs);
    const hoverMedian = hoverT === null ? null : medians[Math.max(0, Math.min(grid.length - 1, Math.round((hoverT - grid[0]) / HOUR)))];
    const binLabel = binHours === 24 ? 'day' : `${binHours} h`;
    const band = drag ? { a: Math.min(drag.x0, drag.x1), b: Math.max(drag.x0, drag.x1) } : { a: x(selection.start), b: x(selection.end) };

    return (
        <div ref={ref} className="waves-chart relative select-none">
            <svg width={width} height={HEIGHT} role="img" aria-label="Sydney median price and number of price changes over time">
                {/* Median price */}
                <text x={M.left} y={11} className="waves-chart-title">
                    Median price, c/L
                </text>
                {priceTicks.map((p) => (
                    <g key={p}>
                        <line x1={M.left} x2={M.left + plotW} y1={yPrice(p)} y2={yPrice(p)} stroke={ink.grid} />
                        <text x={M.left - 6} y={yPrice(p) + 4} textAnchor="end" className="waves-tick">
                            {p}
                        </text>
                    </g>
                ))}
                <path d={pricePath} fill="none" stroke={ink.secondary} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

                {/* Price changes */}
                <text x={M.left} y={actTop - 8} className="waves-chart-title">
                    Price changes per {binLabel}
                </text>
                <g transform={`translate(${M.left + 16 + `Price changes per ${binLabel}`.length * 6.6}, ${actTop - 17})`}>
                    <rect width={10} height={10} rx={2} fill={RISE} />
                    <text x={14} y={9} className="waves-tick">
                        rises
                    </text>
                    <rect x={52} width={10} height={10} rx={2} fill={CUT} />
                    <text x={66} y={9} className="waves-tick">
                        cuts
                    </text>
                </g>
                {countTicks.map((n) => (
                    <g key={n}>
                        <line x1={M.left} x2={M.left + plotW} y1={zeroY - yCount(n)} y2={zeroY - yCount(n)} stroke={ink.grid} />
                        <line x1={M.left} x2={M.left + plotW} y1={zeroY + yCount(n)} y2={zeroY + yCount(n)} stroke={ink.grid} />
                        <text x={M.left - 6} y={zeroY - yCount(n) + 4} textAnchor="end" className="waves-tick">
                            {n}
                        </text>
                        <text x={M.left - 6} y={zeroY + yCount(n) + 4} textAnchor="end" className="waves-tick">
                            {n}
                        </text>
                    </g>
                ))}
                {bars}
                <line x1={M.left} x2={M.left + plotW} y1={zeroY} y2={zeroY} stroke={ink.axis} />

                {/* Time axis */}
                {timeTicks(from, to, Math.max(2, Math.floor(plotW / 90))).map(({ t, label }) => (
                    <text key={t} x={x(t)} y={HEIGHT - 5} textAnchor="middle" className="waves-tick">
                        {label}
                    </text>
                ))}

                {/* Selection, playhead, crosshair */}
                <rect x={band.a} y={TOP - 2} width={Math.max(1, band.b - band.a)} height={HEIGHT - TOP - AXIS_H + 2} className="waves-selection" />
                {playhead !== null && <line x1={x(playhead)} x2={x(playhead)} y1={TOP - 2} y2={HEIGHT - AXIS_H} stroke={ink.primary} strokeWidth={1.5} />}
                {hover !== null && !drag && <line x1={hover} x2={hover} y1={TOP - 2} y2={HEIGHT - AXIS_H} stroke={ink.muted} />}
                <rect
                    x={M.left}
                    y={0}
                    width={plotW}
                    height={HEIGHT}
                    fill="transparent"
                    style={{ cursor: 'crosshair', touchAction: 'none' }}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerLeave={() => setHover(null)}
                />
            </svg>
            {hover !== null && hoverT !== null && !drag && hoverBin >= 0 && hoverBin < act.rises.length && (
                <div className="waves-tooltip" style={{ left: Math.min(hover + 12, width - 190), top: TOP }}>
                    <div className="waves-tooltip-title">
                        {binHours >= 24
                            ? formatDay(act.start + hoverBin * act.binMs)
                            : `${formatDayTime(act.start + hoverBin * act.binMs)}–${formatTime(act.start + (hoverBin + 1) * act.binMs)}`}
                    </div>
                    {hoverMedian !== null && (
                        <div>
                            <strong>{hoverMedian.toFixed(1)}</strong> c/L median
                        </div>
                    )}
                    <div>
                        <span className="waves-key" style={{ background: RISE }} />
                        <strong>{act.rises[hoverBin]}</strong> rises
                    </div>
                    <div>
                        <span className="waves-key" style={{ background: CUT }} />
                        <strong>{act.cuts[hoverBin]}</strong> cuts
                    </div>
                    <div className="waves-tooltip-hint">Click for this day, drag for a range</div>
                </div>
            )}
            <div className="sr-only">
                Selected {formatDayTime(selection.start)} to {formatDayTime(selection.end)} ({formatHours((selection.end - selection.start) / HOUR)}).
            </div>
        </div>
    );
}
