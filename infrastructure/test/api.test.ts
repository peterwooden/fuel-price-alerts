import { describe, expect, it } from 'vitest';
import { parseNswTimestamp } from '../src/nsw-api';

process.env.USER_POOL_ID = 'ap-southeast-2_test';
process.env.USER_POOL_CLIENT_ID = 'client';
process.env.DATA_BUCKET = 'bucket';

describe('parseSubscriptionBody', async () => {
    const { parseSubscriptionBody } = await import('../src/subscriptions');

    it('accepts numeric station codes as the frontend sends them and dedupes', () => {
        expect(parseSubscriptionBody(JSON.stringify({ fuelType: 'U91', stations: [2362, 1067, 2362] }))).toEqual({
            fuelType: 'U91',
            stations: ['2362', '1067'],
        });
    });

    it('rejects more than five stations, bad fuel types and junk', () => {
        expect(parseSubscriptionBody(JSON.stringify({ fuelType: 'U91', stations: [1, 2, 3, 4, 5, 6] }))).toBeUndefined();
        expect(parseSubscriptionBody(JSON.stringify({ fuelType: 'u91; drop', stations: [] }))).toBeUndefined();
        expect(parseSubscriptionBody(JSON.stringify({ fuelType: 'U91', stations: ['../x'] }))).toBeUndefined();
        expect(parseSubscriptionBody('not json')).toBeUndefined();
        expect(parseSubscriptionBody(undefined)).toBeUndefined();
    });

    it('allows clearing all stations', () => {
        expect(parseSubscriptionBody(JSON.stringify({ fuelType: 'E10', stations: [] }))).toEqual({ fuelType: 'E10', stations: [] });
    });
});

describe('parseNswTimestamp', () => {
    it('converts the API format to ISO UTC', () => {
        expect(parseNswTimestamp('26/09/2026 23:06:45')).toBe('2026-09-26T23:06:45Z');
        expect(parseNswTimestamp('01/10/2026 7:05')).toBe('2026-10-01T07:05:00Z');
    });

    it('throws on anything unexpected rather than storing a wrong time', () => {
        expect(() => parseNswTimestamp('2026-09-26 23:06')).toThrow();
    });
});
