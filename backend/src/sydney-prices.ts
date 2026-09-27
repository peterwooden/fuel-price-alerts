// A compact public copy of recent Sydney prices, for the price-waves page on the site.
// Like the Parquet files it is derived from the history CSVs, so it can always be rebuilt
// (scripts/build-sydney-prices.ts). Ingest rewrites it; the PublicApi Lambda serves it.
//
//   public/sydney-prices.json.gz
//
// Prices are public data (NSW FuelCheck); nothing about users is in here.

import type { StationMap } from './trends';

export const SYDNEY = { name: 'Sydney', south: -34.2, west: 150.55, north: -33.5, east: 151.35 };
export const SYDNEY_FUELS = ['U91', 'E10', 'P95', 'P98', 'DL'];
/** How much history the file covers. */
export const SYDNEY_DAYS = 60;
/** How far before the window to look for the price each series entered it with. */
export const CARRY_IN_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export interface SydneyPrices {
    version: 1;
    generatedAt: string;
    /** The window, inclusive. Point times are minutes since `from`. */
    from: string;
    to: string;
    region: typeof SYDNEY;
    stations: { code: string; name: string; brand: string; lat: number; lng: number }[];
    /**
     * Per fuel, one entry per station: [index into stations, [minutes, price, minutes, price, ...]].
     * Minutes are since `from`, and the first point may be negative: it is the last price before
     * the window, carried into it. Prices are in tenths of a cent (1999 = 199.9 c/L).
     */
    series: Record<string, [number, number[]][]>;
}

const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The UTC days of history files the window (plus its carry-in lookback) needs, oldest first. */
export function sydneyPricesDays(from: number, to: number): string[] {
    const days: string[] = [];
    for (let d = Date.parse(isoDay(from - CARRY_IN_DAYS * DAY_MS)); isoDay(d) <= isoDay(to); d += DAY_MS) {
        days.push(isoDay(d));
    }
    return days;
}

export const inSydney = ({ latitude, longitude }: { latitude: number; longitude: number }) =>
    latitude >= SYDNEY.south && latitude <= SYDNEY.north && longitude >= SYDNEY.west && longitude <= SYDNEY.east;

/** Build the public file from price history rows (PRICE_COLUMNS order), in any order. */
export function buildSydneyPrices(
    rows: Iterable<string[]>,
    stations: StationMap,
    from: number,
    to: number,
    generatedAt = new Date(),
): SydneyPrices {
    const carryInFrom = from - CARRY_IN_DAYS * DAY_MS;
    // `${code}|${fuel}` -> time -> tenths of a cent; the carry-in point is the latest before `from`.
    const points = new Map<string, Map<number, number>>();
    const carryIn = new Map<string, [number, number]>();
    for (const [code, , fuelType, price, timestamp] of rows) {
        if (!SYDNEY_FUELS.includes(fuelType)) continue;
        const station = stations[code];
        if (!station || !inSydney(station)) continue;
        const ts = Date.parse(timestamp);
        if (ts < carryInFrom || ts > to) continue;
        const key = `${code}|${fuelType}`;
        const tenths = Math.round(Number(price) * 10);
        if (ts < from) {
            const prior = carryIn.get(key);
            if (!prior || prior[0] < ts) carryIn.set(key, [ts, tenths]);
        } else {
            if (!points.has(key)) points.set(key, new Map());
            points.get(key)!.set(ts, tenths);
        }
    }

    const codes = [...new Set([...points.keys(), ...carryIn.keys()].map((key) => key.split('|')[0]))].sort();
    const index = new Map(codes.map((code, i) => [code, i]));
    const series: SydneyPrices['series'] = Object.fromEntries(SYDNEY_FUELS.map((fuel) => [fuel, []]));
    for (const key of [...new Set([...points.keys(), ...carryIn.keys()])].sort()) {
        const [code, fuelType] = key.split('|');
        const sorted = [...(points.get(key) ?? new Map<number, number>())].sort((a, b) => a[0] - b[0]);
        const prior = carryIn.get(key);
        if (prior) sorted.unshift(prior);
        const flat: number[] = [];
        for (const [ts, tenths] of sorted) flat.push(Math.floor((ts - from) / MINUTE_MS), tenths);
        series[fuelType].push([index.get(code)!, flat]);
    }

    return {
        version: 1,
        generatedAt: generatedAt.toISOString(),
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        region: SYDNEY,
        stations: codes.map((code) => {
            const s = stations[code];
            return { code, name: s.name, brand: s.brand, lat: s.latitude, lng: s.longitude };
        }),
        series,
    };
}

/** The window the file covers when built at time t: the SYDNEY_DAYS days up to t. */
export const sydneyPricesWindow = (t: number) => ({ from: t - SYDNEY_DAYS * DAY_MS, to: t });
