// How a price move spreads across Sydney's stations. Pure functions over decoded series.
//
// A "move" is a window of time and a direction (rises or cuts). A station has "moved" once
// its price is at least STEP c/L above (or below) what it was at the start of the window,
// and the time that first happened is its arrival time. If moves travelled as geographic
// waves, arrival time would change smoothly across the map and neighbours would move
// together; if they're set by head office, stations of one brand move together wherever
// they are. spread() measures both.

import type { Series, Station } from './data';
import { DAY, formatDay, HOUR, sydneyDays } from './time';

export type Direction = 1 | -1;

export interface TimeWindow {
    start: number;
    end: number;
}

/** A change of at least this many c/L counts as a station moving. */
export const STEP = 2;

/** Index of the last point at or before t, or -1 if there is none. */
export function indexAt(times: number[], t: number): number {
    let lo = 0;
    let hi = times.length - 1;
    let found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid] <= t) {
            found = mid;
            lo = mid + 1;
        } else hi = mid - 1;
    }
    return found;
}

export function priceAt(series: Series, t: number): number | undefined {
    const i = indexAt(series.times, t);
    return i < 0 ? undefined : series.prices[i];
}

export function median(values: ArrayLike<number>): number {
    const sorted = Float64Array.from(values).sort();
    const n = sorted.length;
    if (!n) return NaN;
    return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

export function quantile(values: ArrayLike<number>, q: number): number {
    const sorted = Float64Array.from(values).sort();
    if (!sorted.length) return NaN;
    const i = (sorted.length - 1) * q;
    const lo = Math.floor(i);
    return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (i - lo);
}

/** Hourly times from `from` to `to`. */
export function hourlyGrid(from: number, to: number): number[] {
    const grid: number[] = [];
    for (let t = Math.ceil(from / HOUR) * HOUR; t <= to; t += HOUR) grid.push(t);
    return grid;
}

/** The median of every station's current price at each time of an ascending grid. */
export function cityMedian(series: Series[], grid: number[]): (number | null)[] {
    const columns = grid.map(() => [] as number[]);
    for (const s of series) {
        let i = -1;
        for (let g = 0; g < grid.length; g++) {
            while (i + 1 < s.times.length && s.times[i + 1] <= grid[g]) i++;
            if (i >= 0) columns[g].push(s.prices[i]);
        }
    }
    return columns.map((prices) => (prices.length ? median(prices) : null));
}

export interface Activity {
    start: number;
    binMs: number;
    rises: number[];
    cuts: number[];
}

/** How many prices went up and down in each bin, with bins aligned to Sydney midnight. */
export function activity(series: Series[], start: number, end: number, binMs: number): Activity {
    const bins = Math.max(1, Math.ceil((end - start) / binMs));
    const rises = new Array<number>(bins).fill(0);
    const cuts = new Array<number>(bins).fill(0);
    for (const s of series) {
        for (let i = 1; i < s.times.length; i++) {
            const bin = Math.floor((s.times[i] - start) / binMs);
            if (bin < 0 || bin >= bins) continue;
            const delta = s.prices[i] - s.prices[i - 1];
            if (delta > 0.05) rises[bin]++;
            else if (delta < -0.05) cuts[bin]++;
        }
    }
    return { start, binMs, rises, cuts };
}

export interface Arrival {
    series: Series;
    /** Price at the start of the window. */
    base: number;
    /** When the station first moved by STEP in the move's direction, or null if it didn't. */
    at: number | null;
    /** Price change over the whole window. */
    change: number;
}

/** Every station with a known price at the window start, and when (if) it joined the move. */
export function arrivals(series: Series[], win: TimeWindow, direction: Direction, step = STEP): Arrival[] {
    const result: Arrival[] = [];
    for (const s of series) {
        const i0 = indexAt(s.times, win.start);
        if (i0 < 0) continue;
        const base = s.prices[i0];
        let at: number | null = null;
        let i = i0 + 1;
        for (; i < s.times.length && s.times[i] <= win.end; i++) {
            if (at === null && direction * (s.prices[i] - base) >= step - 1e-9) at = s.times[i];
        }
        result.push({ series: s, base, at, change: s.prices[i - 1] - base });
    }
    return result;
}

export interface Move extends TimeWindow {
    id: string;
    kind: 'round' | 'turn';
    direction: Direction;
    /** Share of stations that moved. */
    breadth: number;
    label: string;
}

/** Share of stations with a known price that moved during the window. */
export function breadth(series: Series[], win: TimeWindow, direction: Direction): number {
    const all = arrivals(series, win, direction);
    return all.length ? all.filter((a) => a.at !== null).length / all.length : 0;
}

/**
 * Turning points of the city median: a zigzag that only turns once the median has come
 * back by at least `threshold` c/L from its last high or low.
 */
export function turningPoints(values: (number | null)[], threshold: number): number[] {
    const pivots: number[] = [];
    let direction = 0;
    let hi = -1;
    let lo = -1;
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v === null) continue;
        if (hi < 0) {
            hi = lo = i;
            continue;
        }
        if (direction >= 0 && v > values[hi]!) hi = i;
        if (direction <= 0 && v < values[lo]!) lo = i;
        if (direction === 0 && values[hi]! - values[lo]! >= threshold) {
            direction = hi > lo ? 1 : -1;
            pivots.push(direction === 1 ? lo : hi);
            if (direction === 1) lo = hi;
            else hi = lo;
        } else if (direction === 1 && values[hi]! - v >= threshold) {
            pivots.push(hi);
            direction = -1;
            lo = i;
        } else if (direction === -1 && v - values[lo]! >= threshold) {
            pivots.push(lo);
            direction = 1;
            hi = i;
        }
    }
    if (direction !== 0) pivots.push(direction === 1 ? hi : lo);
    return pivots;
}

const percent = (x: number) => `${Math.round(x * 100)}%`;

/**
 * Moves worth looking at: the widest single-day rounds of rises or cuts (prices in Sydney
 * change in daily rounds, mostly in the morning), and the turns of the city-wide cycle.
 */
export function detectMoves(series: Series[], from: number, to: number): Move[] {
    const moves: Move[] = [];

    const rounds: Move[] = [];
    for (const day of sydneyDays(from, to)) {
        const win = { start: day, end: Math.min(to, day + DAY) };
        if (win.start < from || win.end - win.start < 12 * HOUR) continue;
        for (const direction of [1, -1] as Direction[]) {
            const share = breadth(series, win, direction);
            if (share < 0.25) continue;
            rounds.push({
                ...win,
                id: `round-${direction}-${day}`,
                kind: 'round',
                direction,
                breadth: share,
                label: `${formatDay(day)}: ${percent(share)} of stations ${direction === 1 ? 'raised' : 'cut'} prices`,
            });
        }
    }
    // The widest few of each direction, so a long run of rises doesn't crowd out the cuts.
    for (const direction of [1, -1]) {
        moves.push(...rounds.filter((m) => m.direction === direction).sort((a, b) => b.breadth - a.breadth).slice(0, 5));
    }

    const grid = hourlyGrid(from, to);
    const medians = cityMedian(series, grid);
    const pivots = turningPoints(medians, 3);
    for (let k = 0; k + 1 < pivots.length; k++) {
        const start = grid[pivots[k]];
        // A pivot at the very start of the data is just where the data starts, not a turn.
        if (start - from < DAY) continue;
        const direction: Direction = medians[pivots[k + 1]]! > medians[pivots[k]]! ? 1 : -1;
        const end = Math.min(grid[pivots[k + 1]], start + 7 * DAY, to);
        const days = Math.max(1, Math.round((end - start) / DAY));
        moves.push({
            start,
            end,
            id: `turn-${start}`,
            kind: 'turn',
            direction,
            breadth: breadth(series, { start, end }, direction),
            label: `${direction === 1 ? 'Rises' : 'Cuts'} from ${formatDay(start)} (${days} day${days === 1 ? '' : 's'})`,
        });
    }

    return moves.sort((a, b) => a.start - b.start);
}

// --- How it spread ---------------------------------------------------------------------

const CBD = { lat: -33.8688, lng: 151.2093 };
const KM_PER_DEG_LAT = 111.2;
const KM_PER_DEG_LNG = KM_PER_DEG_LAT * Math.cos((CBD.lat * Math.PI) / 180);

/** Kilometres east and north of the CBD. */
export const toKm = (s: Station) => ({ x: (s.lng - CBD.lng) * KM_PER_DEG_LNG, y: (s.lat - CBD.lat) * KM_PER_DEG_LAT });

export const NEAR_KM = 3;
export const FAR_KM = 15;

export interface Front {
    /** Share of the variation in arrival time a single straight front explains. */
    r2: number;
    /** Compass bearing the front travels towards, in degrees. */
    bearing: number;
    kmPerHour: number;
}

export interface BrandSpread {
    brand: string;
    total: number;
    moved: number;
    first: number | null;
    median: number | null;
}

export type Verdict = 'wave' | 'brand' | 'brand-weak' | 'local' | 'none';

export interface Spread {
    total: number;
    moved: number;
    first: number | null;
    /** When half and 90% of the stations that moved had moved. */
    half: number | null;
    ninety: number | null;
    /** Median hours between two stations moving, for pairs of each kind (null: too few pairs). */
    gaps: {
        nearOtherBrand: number | null;
        farOtherBrand: number | null;
        farSameBrand: number | null;
    };
    front: Front | null;
    brands: BrandSpread[];
    verdict: Verdict;
}

const MIN_PAIRS = 20;

/** Least-squares plane t = a + b*x + c*y through arrival times. */
export function fitFront(points: { x: number; y: number; t: number }[]): Front | null {
    const n = points.length;
    if (n < 10) return null;
    let mx = 0;
    let my = 0;
    let mt = 0;
    for (const p of points) {
        mx += p.x / n;
        my += p.y / n;
        mt += p.t / n;
    }
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    let sxt = 0;
    let syt = 0;
    let stt = 0;
    for (const p of points) {
        const dx = p.x - mx;
        const dy = p.y - my;
        const dt = p.t - mt;
        sxx += dx * dx;
        syy += dy * dy;
        sxy += dx * dy;
        sxt += dx * dt;
        syt += dy * dt;
        stt += dt * dt;
    }
    const det = sxx * syy - sxy * sxy;
    if (!det || !stt) return null;
    const b = (sxt * syy - syt * sxy) / det; // hours per km east
    const c = (syt * sxx - sxt * sxy) / det; // hours per km north
    const r2 = (b * sxt + c * syt) / stt;
    const bearing = ((Math.atan2(b, c) * 180) / Math.PI + 360) % 360;
    return { r2: Math.max(0, r2), bearing, kmPerHour: 1 / Math.hypot(b, c) };
}

export function spread(all: Arrival[], stations: Station[]): Spread {
    const moved = all.filter((a): a is Arrival & { at: number } => a.at !== null).sort((a, b) => a.at - b.at);
    const times = moved.map((a) => a.at);

    // Pairwise: how far apart in time did two stations move, by distance and brand?
    const km = moved.map((a) => toKm(stations[a.series.station]));
    const brand = moved.map((a) => stations[a.series.station].brand);
    const nearOther: number[] = [];
    const farOther: number[] = [];
    const farSame: number[] = [];
    for (let i = 0; i < moved.length; i++) {
        for (let j = i + 1; j < moved.length; j++) {
            const d = Math.hypot(km[i].x - km[j].x, km[i].y - km[j].y);
            const gap = Math.abs(times[i] - times[j]) / HOUR;
            const same = brand[i] === brand[j];
            if (d < NEAR_KM && !same) nearOther.push(gap);
            else if (d >= FAR_KM) (same ? farSame : farOther).push(gap);
        }
    }
    const gapOf = (gaps: number[]) => (gaps.length >= MIN_PAIRS ? median(gaps) : null);
    const gaps = { nearOtherBrand: gapOf(nearOther), farOtherBrand: gapOf(farOther), farSameBrand: gapOf(farSame) };

    const front = fitFront(moved.map((a, i) => ({ ...km[i], t: (a.at - times[0]) / HOUR })));

    const byBrand = new Map<string, Arrival[]>();
    for (const a of all) {
        const name = stations[a.series.station].brand;
        if (!byBrand.has(name)) byBrand.set(name, []);
        byBrand.get(name)!.push(a);
    }
    const brands: BrandSpread[] = [...byBrand].map(([name, list]) => {
        const at = list.filter((a) => a.at !== null).map((a) => a.at!);
        return {
            brand: name,
            total: list.length,
            moved: at.length,
            first: at.length ? Math.min(...at) : null,
            median: at.length ? median(at) : null,
        };
    });

    return {
        total: all.length,
        moved: moved.length,
        first: moved.length ? times[0] : null,
        half: moved.length ? quantile(times, 0.5) : null,
        ninety: moved.length ? quantile(times, 0.9) : null,
        gaps,
        front,
        brands,
        verdict: verdictOf(gaps, front),
    };
}

/**
 * - wave: one straight front explains a good share of the timing.
 * - local: neighbours of different brands move clearly closer together in time than
 *   stations far apart.
 * - brand: stations of the same brand far apart move much closer together in time than
 *   neighbours of different brands; brand-weak: somewhat closer.
 */
export function verdictOf(gaps: Spread['gaps'], front: Front | null): Verdict {
    if (front && front.r2 >= 0.3) return 'wave';
    const { nearOtherBrand, farOtherBrand, farSameBrand } = gaps;
    const byPlace = nearOtherBrand !== null && farOtherBrand !== null ? nearOtherBrand / farOtherBrand : 1;
    const byBrand = farSameBrand !== null && nearOtherBrand !== null ? farSameBrand / nearOtherBrand : 1;
    if (byPlace <= 0.7 && byPlace < byBrand) return 'local';
    if (byBrand <= 0.6) return 'brand';
    if (byBrand <= 0.85) return 'brand-weak';
    return 'none';
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
export const compass = (bearing: number) => COMPASS[Math.round(bearing / 45) % 8];
