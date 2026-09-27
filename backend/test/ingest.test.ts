import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ingest } from '../src/ingest';
import { NswPrice, NswStation } from '../src/nsw-api';
import { keys, State, Store } from '../src/store';
import type { SydneyPrices } from '../src/sydney-prices';
import { AlertEmail } from '../src/trends';
import { FakeS3 } from './fake-s3';

const DAY = 24 * 60 * 60 * 1000;
const t = Date.parse('2026-09-27T02:00:00Z');

const nswStation = (code: string): NswStation => ({
    brandid: 'b',
    stationid: `s${code}`,
    brand: 'Shell',
    code,
    name: `Shell ${code}`,
    address: `${code} Pacific Hwy`,
    location: { latitude: '-33.9', longitude: '151.1' },
    state: 'NSW',
});
const nswPrice = (code: string, price: number, lastupdated: string): NswPrice => ({
    stationcode: code,
    state: 'NSW',
    fueltype: 'U91',
    price,
    lastupdated,
});

describe('ingest', () => {
    let s3: FakeS3;
    let store: Store;
    let sent: AlertEmail[][];

    beforeEach(async () => {
        s3 = new FakeS3();
        store = new Store('bucket', s3.asClient());
        sent = [];
        const state: State = {
            version: 1,
            updatedAt: '',
            series: { '100|U91': [[t - 20 * DAY, '180']], '200|U91': [[t - 20 * DAY, '150']] },
            lastAlert: {},
        };
        await store.putJson(keys.state, state);
        await store.putSubscription('user-1', {
            email: 'driver@example.com',
            fuelType: 'U91',
            stations: ['100'],
            updatedAt: '',
        });
    });

    const run = (prices: NswPrice[], at = t) =>
        ingest(
            {
                store,
                fetchPrices: async () => ({ stations: [nswStation('100'), nswStation('200')], prices }),
                sendAlertEmails: async (emails) => {
                    sent.push(emails);
                    return emails.length;
                },
            },
            at,
        );

    it('appends new prices to history, raises alerts and emails subscribers', async () => {
        const summary = await run([
            nswPrice('100', 199.9, '26/09/2026 23:06:45'), // +11% on 180: alert
            nswPrice('200', 150, '07/09/2026 02:00:00'), // unchanged, already known
        ]);

        expect(summary).toMatchObject({ newPrices: 1, newAlerts: 1, emailsSent: 1 });
        expect(s3.text(keys.priceHistory('2026-09-26'))).toBe(
            'station_code,state,fuel_type,price,timestamp\n100,NSW,U91,199.9,2026-09-26T23:06:45Z\n',
        );
        expect(s3.text(keys.alertHistory('2026-09-27'))).toBe(
            'station_code,fuel_type,time\n100,U91,2026-09-27T02:00:00.000Z\n',
        );
        expect(sent[0][0].email).toBe('driver@example.com');
        expect(sent[0][0].alerts[0]).toMatchObject({ stationName: 'Shell 100', price: 199.9 });

        const state = s3.json<State>(keys.state);
        expect(state.series['100|U91'].map((p) => p[1])).toEqual(['180', '199.9']);
        expect(state.lastAlert['100|U91']).toBe(t);
        expect(s3.json<Record<string, unknown>>(keys.stations)['100']).toMatchObject({ name: 'Shell 100', latitude: -33.9 });
        // Parquet copies of the touched months are refreshed.
        expect(s3.objects.has(keys.analytics('prices', '2026-09'))).toBe(true);
        expect(s3.objects.has(keys.analytics('alerts', '2026-09'))).toBe(true);
        // So is the public Sydney prices file. It's built from history, which only holds the new price.
        const sydney = s3.json<SydneyPrices>(keys.sydneyPrices);
        expect(sydney.stations.map((s) => s.code)).toEqual(['100']);
        expect(sydney.series.U91).toEqual([[0, [(Date.parse('2026-09-26T23:06:45Z') - Date.parse(sydney.from)) / 60000 | 0, 1999]]]);
        expect(summary.sydneyStations).toBe(1);
    });

    it('is idempotent: re-running with the same data writes no history and sends nothing new', async () => {
        const prices = [nswPrice('100', 199.9, '26/09/2026 23:06:45')];
        await run(prices);
        s3.puts = [];
        const summary = await run(prices, t + 2 * 60 * 60 * 1000);
        expect(summary).toMatchObject({ newPrices: 0, newAlerts: 0, emailsSent: 0 });
        expect(s3.puts).toEqual([keys.state]); // no history, stations or Parquet rewrites
    });

    it('does not duplicate history rows that were written by a run that failed before committing state', async () => {
        await store.appendHistory(
            keys.priceHistory('2026-09-26'),
            ['station_code', 'state', 'fuel_type', 'price', 'timestamp'],
            [['100', 'NSW', 'U91', '199.9', '2026-09-26T23:06:45Z']],
            (row) => row.join(),
        );
        await run([nswPrice('100', 199.9, '26/09/2026 23:06:45')]);
        expect(s3.text(keys.priceHistory('2026-09-26')).trim().split('\n')).toHaveLength(2);
        // ...but the hot window still learns the price.
        expect(s3.json<State>(keys.state).series['100|U91']).toHaveLength(2);
    });

    it('prunes the window so it only holds what future runs need', async () => {
        await run([nswPrice('100', 181, '26/09/2026 23:06:45')]);
        const series = s3.json<State>(keys.state).series['100|U91'];
        expect(series[0][0]).toBe(t - 20 * DAY); // still carries the price into the window
    });

    it('refuses to run without state rather than starting from an empty window', async () => {
        s3.objects.delete(keys.state);
        await expect(run([])).rejects.toThrow(/state\.json\.gz is missing/);
    });

    it('fails instead of overwriting state changed by a concurrent run', async () => {
        const realGetState = store.getState;
        vi.spyOn(store, 'getState').mockImplementation(async () => {
            const current = await realGetState();
            await store.putJson(keys.state, current!.value); // someone else wrote meanwhile
            return current;
        });
        await expect(run([])).rejects.toThrow();
    });
});
