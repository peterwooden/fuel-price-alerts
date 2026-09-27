// Helpers for scripts that work on a local copy of the data bucket
// (`aws s3 sync s3://<data bucket> <dir>`).

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { gunzipSync } from 'zlib';
import { parseCsv, State } from '../src/store';
import { Point, SeriesMap, seriesKey, StationMap, WEEK_MS } from '../src/trends';

/** Rows of one history dataset, oldest day first. */
export function* historyRows(dir: string, dataset: 'prices' | 'alerts'): Generator<string[]> {
    const root = join(dir, 'history', dataset);
    if (!existsSync(root)) return;
    for (const day of readdirSync(root).sort()) {
        const file = join(root, day, `${dataset}.csv.gz`);
        if (existsSync(file)) yield* parseCsv(gunzipSync(readFileSync(file)).toString('utf8'));
    }
}

/** Parse an ISO UTC timestamp, tolerating Postgres' microsecond precision. */
export const parseTime = (iso: string) => Date.parse(iso.replace(/(\.\d{3})\d+Z$/, '$1Z'));

/**
 * The hot window as of time t, built from full history: for each series, the last point
 * before t - 1 week plus everything after it. Identical to pruning the full series.
 */
export function buildState(dir: string, t: number): State {
    const windowStart = t - WEEK_MS;
    const prior: Record<string, Point> = {};
    const recent: Record<string, Point[]> = {};
    for (const [code, , fuelType, price, timestamp] of historyRows(dir, 'prices')) {
        const key = seriesKey(code, fuelType);
        const ts = parseTime(timestamp);
        if (ts < windowStart) {
            if (!prior[key] || prior[key][0] < ts) prior[key] = [ts, price];
        } else {
            (recent[key] ??= []).push([ts, price]);
        }
    }
    const series: SeriesMap = {};
    for (const key of new Set([...Object.keys(prior), ...Object.keys(recent)])) {
        const points = [...(prior[key] ? [prior[key]] : []), ...(recent[key] ?? [])].sort((a, b) => a[0] - b[0]);
        series[key] = points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0]);
    }

    const lastAlert: Record<string, number> = {};
    for (const [code, fuelType, time] of historyRows(dir, 'alerts')) {
        const at = parseTime(time);
        const key = seriesKey(code, fuelType);
        if (at <= t && at > windowStart && !(lastAlert[key] >= at)) lastAlert[key] = at;
    }

    return { version: 1, updatedAt: new Date().toISOString(), series, lastAlert };
}

export function readStations(dir: string): StationMap {
    return JSON.parse(gunzipSync(readFileSync(join(dir, 'stations.json.gz'))).toString('utf8'));
}
