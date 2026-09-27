import { describe, expect, it } from 'vitest';
import { buildSydneyPrices, CARRY_IN_DAYS, sydneyPricesDays, sydneyPricesWindow } from '../src/sydney-prices';
import type { Station, StationMap } from '../src/trends';

const DAY = 24 * 60 * 60 * 1000;
const from = Date.parse('2026-08-01T00:00:00Z');
const to = Date.parse('2026-08-03T00:00:00Z');

const station = (code: string, latitude: number, longitude: number, brand = 'Shell'): Station => ({
    brand_id: '',
    station_id: '',
    brand,
    code,
    name: `${brand} ${code}`,
    address: '',
    latitude,
    longitude,
    state: 'NSW',
});
const stations: StationMap = {
    '1': station('1', -33.87, 151.21), // Sydney CBD
    '2': station('2', -33.95, 150.95, '7-Eleven'), // Liverpool
    '9': station('9', -30.29, 153.12), // Coffs Harbour: outside Sydney
};
const row = (code: string, fuel: string, price: string, timestamp: string) => [code, 'NSW', fuel, price, timestamp];

describe('buildSydneyPrices', () => {
    it('keeps Sydney stations and the published fuels only', () => {
        const prices = buildSydneyPrices(
            [
                row('1', 'U91', '199.9', '2026-08-01T20:00:00Z'),
                row('9', 'U91', '189.9', '2026-08-01T20:00:00Z'), // outside Sydney
                row('1', 'LPG', '99.9', '2026-08-01T20:00:00Z'), // not published
                row('404', 'U91', '179.9', '2026-08-01T20:00:00Z'), // unknown station
            ],
            stations,
            from,
            to,
        );
        expect(prices.stations).toEqual([{ code: '1', name: 'Shell 1', brand: 'Shell', lat: -33.87, lng: 151.21 }]);
        expect(prices.series.U91).toEqual([[0, [20 * 60, 1999]]]);
        expect(prices.series.E10).toEqual([]);
        expect(prices).toMatchObject({ from: '2026-08-01T00:00:00.000Z', to: '2026-08-03T00:00:00.000Z' });
    });

    it('encodes minutes since the window start and tenths of a cent, sorted and unique by time', () => {
        const prices = buildSydneyPrices(
            [
                row('2', 'E10', '187.4', '2026-08-02T06:30:00Z'),
                row('2', 'E10', '185', '2026-08-01T06:00:59Z'),
                row('2', 'E10', '187.4', '2026-08-02T06:30:00Z'), // duplicate
            ],
            stations,
            from,
            to,
        );
        expect(prices.series.E10).toEqual([[0, [6 * 60, 1850, 30 * 60 + 30, 1874]]]);
    });

    it('carries the last earlier price into the window as a point at negative minutes', () => {
        const prices = buildSydneyPrices(
            [
                row('1', 'U91', '170.9', '2026-07-30T06:00:00Z'),
                row('1', 'U91', '172.9', '2026-07-31T06:00:00Z'), // latest before the window
                row('1', 'U91', '180.9', '2026-08-01T06:00:00Z'),
                row('2', 'U91', '160.9', new Date(from - (CARRY_IN_DAYS + 1) * DAY).toISOString()), // too old
                row('2', 'U91', '205.9', '2026-08-03T00:00:01Z'), // after the window
            ],
            stations,
            from,
            to,
        );
        expect(prices.stations.map((s) => s.code)).toEqual(['1']);
        expect(prices.series.U91).toEqual([[0, [-18 * 60, 1729, 6 * 60, 1809]]]);
    });

    it('keeps a station that only has a carried-in price, since its price in the window is known', () => {
        const prices = buildSydneyPrices([row('2', 'DL', '230.9', '2026-07-31T23:00:00Z')], stations, from, to);
        expect(prices.series.DL).toEqual([[0, [-60, 2309]]]);
    });
});

describe('sydneyPricesDays', () => {
    it('lists every history day from the carry-in lookback to the end of the window', () => {
        const { from, to } = sydneyPricesWindow(Date.parse('2026-09-27T02:00:00Z'));
        const days = sydneyPricesDays(from, to);
        expect(days[0]).toBe('2026-07-15'); // 60 days back, then 14 more
        expect(days.at(-1)).toBe('2026-09-27');
        expect(days).toHaveLength(60 + CARRY_IN_DAYS + 1);
        expect(new Set(days).size).toBe(days.length);
    });
});
