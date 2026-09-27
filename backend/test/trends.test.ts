import { describe, expect, it } from 'vitest';
import {
    computeTrends,
    mergePoints,
    Point,
    prunePoints,
    recentPoints,
    selectAlerts,
    StationMap,
    trendAt,
    WEEK_MS,
} from '../src/trends';

const DAY = 24 * 60 * 60 * 1000;
const t = Date.parse('2026-09-27T00:00:00Z');
const station = (code: string, name = `Station ${code}`) => ({
    brand_id: '',
    station_id: '',
    brand: 'Brand',
    code,
    name,
    address: '',
    latitude: -33.8,
    longitude: 151.2,
    state: 'NSW',
});

describe('trendAt', () => {
    it('weights each price by how long it was in effect during the past week', () => {
        // 180 carried in from before the window for 4 days, then 200 for the last 3 days.
        const points: Point[] = [
            [t - 30 * DAY, '180'],
            [t - 3 * DAY, '200'],
        ];
        const trend = trendAt(points, t)!;
        const expected = (180 * 4 + 200 * 3) / 7;
        expect(trend.price).toBe(200);
        expect(trend.timeWeightedAverage).toBeCloseTo(expected, 10);
        expect(trend.change).toBeCloseTo((200 - expected) / expected, 10);
        expect(trend.prices.map((p) => p.price)).toEqual([180, 200]);
    });

    it('ignores points at or after t and keeps only the last point before the window', () => {
        const points: Point[] = [
            [t - 20 * DAY, '150'],
            [t - 10 * DAY, '160'],
            [t - 1 * DAY, '170'],
            [t, '999'],
            [t + DAY, '999'],
        ];
        expect(recentPoints(points, t).map((p) => p[1])).toEqual(['160', '170']);
        expect(trendAt(points, t)!.price).toBe(170);
    });

    it('matches the SQL quirk for a new series: the week is not renormalised', () => {
        // Only one point, 2 days old, no prior: SQL averages over the full week anyway.
        const trend = trendAt([[t - 2 * DAY, '200']], t)!;
        expect(trend.timeWeightedAverage).toBeCloseTo((200 * 2) / 7, 10);
    });

    it('returns nothing for a series with no points before t', () => {
        expect(trendAt([[t + DAY, '100']], t)).toBeUndefined();
    });
});

describe('computeTrends', () => {
    it('skips series whose station is unknown, as the SQL join did', () => {
        const stations: StationMap = { '1': station('1') };
        const trends = computeTrends({ '1|U91': [[t - DAY, '100']], '2|U91': [[t - DAY, '100']] }, stations, t);
        expect(trends.map((tr) => tr.code)).toEqual(['1']);
    });
});

describe('selectAlerts', () => {
    const stations: StationMap = { '1': station('1', 'Rising'), '2': station('2', 'Flat'), '3': station('3', 'Other') };
    const series = {
        '1|U91': [[t - 30 * DAY, '100'], [t - DAY, '120']] as Point[],
        '2|U91': [[t - 30 * DAY, '100']] as Point[],
        '3|U91': [[t - 30 * DAY, '100'], [t - DAY, '130']] as Point[],
    };
    const trends = computeTrends(series, stations, t);
    const subscriptions = [{ email: 'a@example.com', fuelType: 'U91', stations: ['2', '1'] }];

    it('emails all of a user’s series, most risen first, when one is newly rising', () => {
        const { emails, newAlerts } = selectAlerts({ trends, subscriptions, stations, lastAlert: {}, t });
        expect(emails).toHaveLength(1);
        expect(emails[0].alerts.map((a) => a.stationName)).toEqual(['Rising', 'Flat']);
        expect(newAlerts.sort()).toEqual(['1|U91', '3|U91']);
    });

    it('does not re-alert a series that alerted within the past week', () => {
        const lastAlert = { '1|U91': t - 6 * DAY };
        const { emails, newAlerts } = selectAlerts({ trends, subscriptions, stations, lastAlert, t });
        expect(emails).toHaveLength(0);
        expect(newAlerts).toEqual(['3|U91']);
    });

    it('alerts again once the previous alert is more than a week old', () => {
        const lastAlert = { '1|U91': t - WEEK_MS };
        expect(selectAlerts({ trends, subscriptions, stations, lastAlert, t }).emails).toHaveLength(1);
    });
});

describe('state maintenance', () => {
    it('mergePoints adds only unseen times and keeps order', () => {
        const series = { k: [[1, 'a'], [3, 'c']] as Point[] };
        expect(mergePoints(series, 'k', [[2, 'b'], [3, 'x'], [2, 'b']])).toEqual([[2, 'b']]);
        expect(series.k).toEqual([[1, 'a'], [2, 'b'], [3, 'c']]);
    });

    it('prunePoints keeps the point that carries the price into the window', () => {
        const points: Point[] = [
            [t - 30 * DAY, 'old'],
            [t - 8 * DAY, 'carry'],
            [t - 2 * DAY, 'in'],
            [t + DAY, 'future'],
        ];
        const pruned = prunePoints(points, t);
        expect(pruned.map((p) => p[1])).toEqual(['carry', 'in', 'future']);
        // Pruning must never change the answer for now or any later time.
        for (const at of [t, t + DAY, t + 5 * DAY]) expect(trendAt(pruned, at)).toEqual(trendAt(points, at));
    });
});

describe('parity with the original Postgres implementation', async () => {
    // Captured from get_price_trends_at_time on production data before Aurora was retired
    // (scripts/parity-check.ts). Each run is a moment when a real alert email went out.
    const fixture = (await import('./fixtures/sql-parity.json')).default as unknown as {
        stations: StationMap;
        series: Record<string, Point[]>;
        alerts: Record<string, number[]>;
        runs: { at: string; trends: { key: string; price: number; twa: number; change: number; n: number }[]; newAlerts: string[] }[];
    };

    for (const run of fixture.runs) {
        it(`reproduces SQL trends and alert decisions at ${run.at}`, () => {
            const at = Date.parse(run.at);
            const trends = computeTrends(fixture.series, fixture.stations, at);
            const byKey = new Map(trends.map((tr) => [`${tr.code}|${tr.fuelType}`, tr]));
            for (const expected of run.trends) {
                const actual = byKey.get(expected.key)!;
                expect(actual, expected.key).toBeDefined();
                expect(actual.price).toBe(expected.price);
                expect(actual.timeWeightedAverage).toBeCloseTo(expected.twa, 9);
                expect(actual.change).toBeCloseTo(expected.change, 9);
                expect(actual.prices).toHaveLength(expected.n);
            }
            expect(trends).toHaveLength(run.trends.length);

            const lastAlert: Record<string, number> = {};
            for (const [key, times] of Object.entries(fixture.alerts)) {
                const recent = times.filter((time) => time <= at && time > at - WEEK_MS);
                if (recent.length) lastAlert[key] = Math.max(...recent);
            }
            const { newAlerts } = selectAlerts({ trends, subscriptions: [], stations: fixture.stations, lastAlert, t: at });
            expect(newAlerts.sort()).toEqual(run.newAlerts);
        });
    }
});
