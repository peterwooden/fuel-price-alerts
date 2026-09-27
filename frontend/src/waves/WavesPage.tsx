import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Arrival, arrivals, breadth, detectMoves, Direction, indexAt, Move, quantile, spread, STEP, TimeWindow } from './analysis';
import { BrandStrip, StripRow } from './BrandStrip';
import { arrivalColor, arrivalGradient, changeColor, changeGradient } from './colors';
import { loadPrices, PriceData } from './data';
import { MapPoint, StationMap } from './StationMap';
import { formatDay, formatDayTime, formatShortDate, formatTime, formatWithin, HOUR, startOfSydneyDay } from './time';
import { Timeline } from './Timeline';
import { Verdict } from './Verdict';
import './waves.css';

// Lambda Function URL of the public API, injected at build time by build-and-deploy.sh.
const PUBLIC_API_URL = process.env.REACT_APP_PUBLIC_API_URL ?? '/';

const FUELS: [string, string][] = [
    ['U91', 'Unleaded 91'],
    ['E10', 'E10'],
    ['P95', 'Premium 95'],
    ['P98', 'Premium 98'],
    ['DL', 'Diesel'],
];
const MAX_BRAND_ROWS = 9;
const FIRST_MOVERS = 6;
const REPLAY_MS = 20000;

interface Selection extends TimeWindow {
    direction: Direction;
    moveId: string | null;
}

const WORDS = {
    1: { past: 'raised', present: 'raise', noun: 'rises', relation: 'above' },
    '-1': { past: 'cut', present: 'cut', noun: 'cuts', relation: 'below' },
};

const signed = (c: number) => `${c > 0 ? '+' : c < 0 ? '−' : '±'}${Math.abs(c).toFixed(1)}c`;
const windowLabel = (w: TimeWindow) =>
    startOfSydneyDay(w.start) === w.start && w.end - w.start <= 25 * HOUR && startOfSydneyDay(w.end) === w.end
        ? formatDay(w.start)
        : `${formatDayTime(w.start)} to ${formatDayTime(w.end)}`;

/** Default: the round that reached the most stations. */
const defaultMove = (moves: Move[]) =>
    moves.filter((m) => m.kind === 'round').sort((a, b) => b.breadth - a.breadth)[0] ?? moves[0];

export default function WavesPage() {
    const [data, setData] = useState<PriceData | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        loadPrices(`${PUBLIC_API_URL}sydney-prices.json`).then(setData, (e: Error) => setError(e.message));
    }, []);

    return (
        <div className="waves">
            <div className="shadow-lg w-full py-2 bg-white">
                <div className="container mx-auto flex flex-row justify-between items-center px-5">
                    <Link to="/" className="font-bold text-xl">
                        Fuel Price Alerts
                    </Link>
                    <Link to="/account" className="text-blue-600 underline">
                        Get price alerts
                    </Link>
                </div>
            </div>
            <main className="container mx-auto px-4 py-6">
                <h1 className="text-2xl font-bold">How price changes move through Sydney</h1>
                <p className="waves-lede max-w-3xl">
                    Do price rises roll across the city like a wave, or do they land everywhere at once? Pick a move below and
                    see when each station followed it, or replay it.
                </p>
                {error && <p className="waves-status text-red-700">{error}</p>}
                {!error && !data && <p className="waves-status">Loading prices…</p>}
                {data && (
                    <ErrorBoundary>
                        <Explorer data={data} />
                    </ErrorBoundary>
                )}
            </main>
        </div>
    );
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError() {
        return { failed: true };
    }
    componentDidCatch(error: Error) {
        console.error('Price waves failed to render', error);
    }
    render() {
        return this.state.failed ? <p className="waves-status text-red-700">Something went wrong drawing this page. Reload to try again.</p> : this.props.children;
    }
}

function Explorer({ data }: { data: PriceData }) {
    const [fuel, setFuel] = useState('U91');
    const series = useMemo(() => data.fuels[fuel] ?? [], [data, fuel]);
    const moves = useMemo(() => detectMoves(series, data.from, data.to), [series, data]);

    const [selection, setSelection] = useState<Selection | null>(null);
    useEffect(() => {
        const move = defaultMove(moves);
        setSelection(move ? { ...move, moveId: move.id } : { start: data.to - 24 * HOUR, end: data.to, direction: 1, moveId: null });
    }, [moves, data.to]);

    if (!selection) return null;
    return (
        <MoveExplorer
            data={data}
            fuel={fuel}
            setFuel={setFuel}
            series={series}
            moves={moves}
            selection={selection}
            setSelection={setSelection}
        />
    );
}

interface ExplorerProps {
    data: PriceData;
    fuel: string;
    setFuel: (fuel: string) => void;
    series: PriceData['fuels'][string];
    moves: Move[];
    selection: Selection;
    setSelection: (s: Selection) => void;
}

function MoveExplorer({ data, fuel, setFuel, series, moves, selection, setSelection }: ExplorerProps) {
    const { direction } = selection;
    const words = WORDS[direction];
    const all = useMemo(() => arrivals(series, selection, direction), [series, selection, direction]);
    const result = useMemo(() => spread(all, data.stations), [all, data.stations]);

    // Position of each station in the order they moved, 0 (first) to 1 (last); ties share.
    const movedTimes = useMemo(
        () => all.filter((a) => a.at !== null).map((a) => a.at!).sort((a, b) => a - b),
        [all],
    );
    const orderOf = (at: number) => orderIn(movedTimes, at);

    const [view, setView] = useState<'arrival' | 'replay'>('arrival');
    const [playhead, setPlayhead] = useState(selection.start);
    const playheadRef = useRef(playhead);
    playheadRef.current = playhead;
    const [playing, setPlaying] = useState(false);
    const [speed, setSpeed] = useState(1);
    const [hovered, setHovered] = useState<number | null>(null);
    useEffect(() => {
        setPlaying(false);
        setPlayhead(selection.start);
    }, [selection]);
    useEffect(() => {
        if (!playing) return;
        let frame = 0;
        let last = performance.now();
        let t = playheadRef.current;
        const tick = (frameTime: number) => {
            t = Math.min(selection.end, t + ((frameTime - last) / REPLAY_MS) * speed * (selection.end - selection.start));
            last = frameTime;
            setPlayhead(t);
            if (t >= selection.end) setPlaying(false);
            else frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [playing, speed, selection]);

    // Colour scale for the replay: the 90th percentile change, at least 4c.
    const changeMax = useMemo(
        () => (all.length ? Math.max(4, Math.ceil(quantile(all.map((a) => Math.abs(a.change)), 0.9))) : 4),
        [all],
    );
    const span = selection.end - selection.start;
    const pulseMs = Math.max(20 * 60 * 1000, span / 40);
    const replay = view === 'replay';
    // The playhead is reset by an effect after the selection changes; until then keep it inside the window.
    const now = Math.min(selection.end, Math.max(selection.start, playhead));
    const priceNow = (a: Arrival) => a.series.prices[indexAt(a.series.times, now)];

    const points: MapPoint[] = all.map((a) => {
        const s = data.stations[a.series.station];
        if (replay) {
            const i = indexAt(a.series.times, now);
            const change = a.series.prices[i] - a.base;
            const changedAt = a.series.times[i];
            return {
                lat: s.lat,
                lng: s.lng,
                fill: changeColor(change, changeMax),
                z: Math.abs(change),
                pulse: changedAt > selection.start && now - changedAt <= pulseMs,
            };
        }
        return a.at === null
            ? { lat: s.lat, lng: s.lng, fill: null, z: -2 }
            : { lat: s.lat, lng: s.lng, fill: arrivalColor(orderOf(a.at)), z: -orderOf(a.at) };
    });
    const pointOf = useMemo(() => new Map(all.map((a, i) => [a.series.station, i])), [all]);
    const hoveredArrival = hovered === null ? undefined : all[pointOf.get(hovered) ?? -1];

    const describe = (station: number) => {
        const a = all[pointOf.get(station) ?? -1];
        const s = data.stations[station];
        if (!a) return { name: `${s.name} (${s.brand})`, detail: '' };
        const detail = replay
            ? `${priceNow(a).toFixed(1)} c/L at ${formatTime(now)}, ${signed(priceNow(a) - a.base)} since the start`
            : a.at !== null
            ? `${capitalise(words.past)} ${formatDayTime(a.at)}; ${a.base.toFixed(1)} → ${(a.base + a.change).toFixed(1)} c/L over the window`
            : `Didn't ${words.present} by ${STEP}c; ${signed(a.change)} over the window`;
        return { name: `${s.name} (${s.brand})`, detail };
    };

    const rows = useMemo(() => brandRows(all, data), [all, data]);
    const domain: [number, number] = movedTimes.length
        ? padDomain(movedTimes[0], movedTimes[movedTimes.length - 1])
        : [selection.start, selection.end];

    const onTimelineSelect = (win: TimeWindow) => {
        const up = breadth(series, win, 1);
        const down = breadth(series, win, -1);
        setSelection({ ...win, direction: up >= down ? 1 : -1, moveId: null });
    };

    return (
        <>
            <div className="waves-controls" role="group" aria-label="Choose what to look at">
                <label>
                    Fuel
                    <select value={fuel} onChange={(e) => setFuel(e.target.value)}>
                        {FUELS.filter(([code]) => data.fuels[code]?.length).map(([code, name]) => (
                            <option key={code} value={code}>
                                {name}
                            </option>
                        ))}
                    </select>
                </label>
                <label>
                    Move
                    <select
                        value={selection.moveId ?? 'custom'}
                        onChange={(e) => {
                            const move = moves.find((m) => m.id === e.target.value);
                            if (move) setSelection({ ...move, moveId: move.id });
                        }}
                    >
                        {selection.moveId === null && <option value="custom">{windowLabel(selection)} (from the timeline)</option>}
                        <optgroup label="Turns of the price cycle">
                            {moves
                                .filter((m) => m.kind === 'turn')
                                .map((m) => (
                                    <option key={m.id} value={m.id}>
                                        {m.label}
                                    </option>
                                ))}
                        </optgroup>
                        <optgroup label="Widest daily rounds">
                            {moves
                                .filter((m) => m.kind === 'round')
                                .map((m) => (
                                    <option key={m.id} value={m.id}>
                                        {m.label}
                                    </option>
                                ))}
                        </optgroup>
                    </select>
                </label>
                <div className="waves-segmented" role="radiogroup" aria-label="Direction">
                    {([1, -1] as Direction[]).map((d) => (
                        <button
                            key={d}
                            role="radio"
                            aria-checked={direction === d}
                            className={direction === d ? 'active' : ''}
                            onClick={() => setSelection({ ...selection, direction: d, moveId: null })}
                        >
                            {d === 1 ? 'Rises' : 'Cuts'}
                        </button>
                    ))}
                </div>
            </div>

            <section className="waves-card">
                <Timeline
                    series={series}
                    from={data.from}
                    to={data.to}
                    selection={selection}
                    playhead={replay ? now : null}
                    onSelect={onTimelineSelect}
                />
            </section>

            <section className="waves-card">
                <div className="waves-window">
                    {windowLabel(selection)} · {words.noun} of {STEP}c or more
                </div>
                <Verdict spread={result} verb={`${words.past} prices`} />
            </section>

            <div className="waves-grid">
                <section className="waves-card waves-map-card">
                    <div className="waves-card-header">
                        <div className="waves-segmented" role="radiogroup" aria-label="Map view">
                            <button role="radio" aria-checked={!replay} className={!replay ? 'active' : ''} onClick={() => setView('arrival')}>
                                When each station moved
                            </button>
                            <button role="radio" aria-checked={replay} className={replay ? 'active' : ''} onClick={() => setView('replay')}>
                                Replay
                            </button>
                        </div>
                        {replay && (
                            <div className="waves-replay">
                                <button
                                    className="waves-button"
                                    onClick={() => {
                                        if (!playing && now >= selection.end) setPlayhead(selection.start);
                                        setPlaying(!playing);
                                    }}
                                >
                                    {playing ? 'Pause' : now >= selection.end ? 'Play again' : 'Play'}
                                </button>
                                <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Replay speed">
                                    <option value={0.5}>Slow</option>
                                    <option value={1}>Normal</option>
                                    <option value={3}>Fast</option>
                                </select>
                                <input
                                    type="range"
                                    min={selection.start}
                                    max={selection.end}
                                    step={60 * 1000}
                                    value={now}
                                    onChange={(e) => {
                                        setPlaying(false);
                                        setPlayhead(Number(e.target.value));
                                    }}
                                    aria-label="Replay time"
                                />
                            </div>
                        )}
                    </div>
                    <StationMap
                        points={points}
                        highlight={hovered === null ? null : pointOf.get(hovered) ?? null}
                        onHover={(i) => setHovered(i === null ? null : all[i].series.station)}
                        arrow={!replay && result.verdict === 'wave' && result.front ? { bearing: result.front.bearing } : null}
                        tooltip={hoveredArrival && hovered !== null && <StationTooltip {...describe(hovered)} />}
                    >
                        {replay && <div className="waves-clock">{formatDayTime(now)}</div>}
                        <div className="waves-legend">
                            {replay ? (
                                <>
                                    <div className="waves-legend-title">Change since {formatDayTime(selection.start)}</div>
                                    <div className="waves-gradient" style={{ background: changeGradient }} />
                                    <div className="waves-legend-scale">
                                        <span>−{changeMax}c</span>
                                        <span>0</span>
                                        <span>+{changeMax}c</span>
                                    </div>
                                    <div className="waves-legend-item">
                                        <span className="waves-ring pulse" /> just changed
                                    </div>
                                </>
                            ) : (
                                <>
                                    <div className="waves-legend-title">When stations {words.past} prices</div>
                                    <div className="waves-gradient" style={{ background: arrivalGradient }} />
                                    <div className="waves-legend-scale">
                                        <span>first</span>
                                        <span>last</span>
                                    </div>
                                    {result.half !== null && movedTimes.length > 0 && (
                                        <div className="waves-legend-note">
                                            From {formatWithin(movedTimes[0], span)}; half by {formatWithin(result.half, span)}
                                        </div>
                                    )}
                                    <div className="waves-legend-item">
                                        <span className="waves-ring" /> didn't {words.present}
                                    </div>
                                </>
                            )}
                        </div>
                    </StationMap>
                </section>

                <section className="waves-card">
                    <h3 className="waves-card-title">When each brand {words.past} prices</h3>
                    <p className="waves-card-subtitle">One dot per station, ticks at each brand's median. Leaders at the top.</p>
                    <BrandStrip
                        rows={rows}
                        domain={domain}
                        highlight={hovered}
                        onHover={setHovered}
                        describe={describe}
                    />
                    <h3 className="waves-card-title mt-5">First to {words.present} prices</h3>
                    <ol className="waves-first">
                        {all
                            .filter((a) => a.at !== null)
                            .sort((a, b) => a.at! - b.at!)
                            .slice(0, FIRST_MOVERS)
                            .map((a) => {
                                const s = data.stations[a.series.station];
                                return (
                                    <li
                                        key={s.code}
                                        className={hovered === a.series.station ? 'active' : ''}
                                        onMouseEnter={() => setHovered(a.series.station)}
                                        onMouseLeave={() => setHovered(null)}
                                    >
                                        <span className="waves-first-time">{formatWithin(a.at!, span)}</span>
                                        <span>
                                            {s.name} <span className="waves-first-brand">{s.brand}</span>
                                        </span>
                                    </li>
                                );
                            })}
                    </ol>
                </section>
            </div>

            <details className="waves-card waves-table">
                <summary>All {all.length} stations as a table</summary>
                <StationTable all={all} data={data} direction={direction} />
            </details>

            <p className="waves-footnote">
                Prices from NSW FuelCheck for {data.stations.length} Sydney stations, {formatShortDate(data.from)} to{' '}
                {formatShortDate(data.to)}, updated {formatDayTime(data.generatedAt)} (Sydney time). A station counts as having{' '}
                {words.past} its price once it is {STEP} c/L {words.relation} what it was at the start of the selected window. Gaps are medians over every pair of stations. The wave-front fit is how much of the timing
                one straight front moving across the city explains.
            </p>
        </>
    );
}

const capitalise = (s: string) => s[0].toUpperCase() + s.slice(1);

function StationTooltip({ name, detail }: { name: string; detail: string }) {
    return (
        <>
            <div className="waves-tooltip-title">{name}</div>
            <div>{detail}</div>
        </>
    );
}

function lowerBound(sorted: number[], value: number): number {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] < value) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/** Position of `at` in ascending `sorted`, 0 (first) to 1 (last); equal times share a position. */
function orderIn(sorted: number[], at: number): number {
    if (sorted.length < 2) return 0;
    return (lowerBound(sorted, at) + lowerBound(sorted, at + 1) - 1) / 2 / (sorted.length - 1);
}

function padDomain(a: number, b: number): [number, number] {
    const pad = Math.max((b - a) * 0.04, 10 * 60 * 1000);
    return [a - pad, b + pad];
}

/** One row per brand, leaders first; small brands folded into "Other brands". */
function brandRows(all: Arrival[], data: PriceData): StripRow[] {
    const moved = all.filter((a) => a.at !== null).map((a) => a.at!).sort((x, y) => x - y);
    const groups = new Map<string, Arrival[]>();
    for (const a of all) {
        const brand = data.stations[a.series.station].brand;
        if (!groups.has(brand)) groups.set(brand, []);
        groups.get(brand)!.push(a);
    }
    const row = (brand: string, list: Arrival[]): StripRow => {
        const times = list.filter((a) => a.at !== null).map((a) => a.at!).sort((x, y) => x - y);
        return {
            brand,
            total: list.length,
            moved: times.length,
            median: times.length ? quantile(times, 0.5) : null,
            dots: list.filter((a) => a.at !== null).map((a) => ({ station: a.series.station, at: a.at!, order: orderIn(moved, a.at!) })),
        };
    };
    const big = [...groups].filter(([, list]) => list.length >= 3).sort((a, b) => b[1].length - a[1].length);
    const shown = big.slice(0, MAX_BRAND_ROWS - 1).map(([brand, list]) => row(brand, list));
    const shownNames = new Set(shown.map((r) => r.brand));
    const rest = all.filter((a) => !shownNames.has(data.stations[a.series.station].brand));
    const byMedian = (a: StripRow, b: StripRow) => (a.median ?? Infinity) - (b.median ?? Infinity) || b.total - a.total;
    return [...shown.sort(byMedian), ...(rest.length ? [row('Other brands', rest)] : [])];
}

function StationTable({ all, data, direction }: { all: Arrival[]; data: PriceData; direction: Direction }) {
    const sorted = [...all].sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
    return (
        <table>
            <thead>
                <tr>
                    <th>Station</th>
                    <th>Brand</th>
                    <th className="num">Price at start</th>
                    <th>{capitalise(WORDS[direction].past)} at</th>
                    <th className="num">Change over window</th>
                </tr>
            </thead>
            <tbody>
                {sorted.map((a) => {
                    const s = data.stations[a.series.station];
                    return (
                        <tr key={s.code}>
                            <td>{s.name}</td>
                            <td>{s.brand}</td>
                            <td className="num">{a.base.toFixed(1)}</td>
                            <td>{a.at === null ? '–' : formatDayTime(a.at)}</td>
                            <td className="num">{signed(a.change)}</td>
                        </tr>
                    );
                })}
            </tbody>
        </table>
    );
}
