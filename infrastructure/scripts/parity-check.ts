// Differential test used during migration: compare src/trends.ts against the original
// Postgres implementation (get_price_trends_at_time + the alert queries from the old
// fetch-prices Lambda) on the same data at several points in time. Also writes the
// golden fixture that keeps test/trends.test.ts honest now that Postgres is gone.
//
//   npx tsx scripts/parity-check.ts --cluster <arn> --secret <arn> --dir <export dir> \
//       --at 2026-09-27T00:00:00Z --at ... [--fixture test/fixtures/sql-parity.json]

import { writeFileSync } from 'fs';
import { ExecuteStatementCommand, RDSDataClient } from '@aws-sdk/client-rds-data';
import { computeTrends, selectAlerts, seriesKey, Subscription, WEEK_MS } from '../src/trends';
import { buildState, historyRows, parseTime, readStations } from './history';

const args = (name: string) => process.argv.flatMap((a, i, all) => (a === `--${name}` ? [all[i + 1]] : []));
const [cluster] = args('cluster');
const [secret] = args('secret');
const [dir] = args('dir');
const [fixturePath] = args('fixture');
const times = args('at').map((iso) => Date.parse(iso));

const rds = new RDSDataClient({ region: cluster.split(':')[3] });
async function query<T>(sql: string): Promise<T[]> {
    for (let attempt = 0; ; attempt++) {
        try {
            const res = await rds.send(
                new ExecuteStatementCommand({ resourceArn: cluster, secretArn: secret, database: 'postgres', sql, formatRecordsAs: 'JSON' }),
            );
            return JSON.parse(res.formattedRecords ?? '[]');
        } catch (e) {
            if (attempt < 20 && /Resuming/i.test(String(e))) {
                await new Promise((r) => setTimeout(r, 3000));
                continue;
            }
            throw e;
        }
    }
}

interface SqlTrend {
    key: string;
    price: number;
    twa: number;
    change: number;
    n: number;
}

async function sqlTrends(at: string): Promise<SqlTrend[]> {
    const rows: SqlTrend[] = [];
    for (let offset = 0; ; offset += 4000) {
        const [{ csv }] = await query<{ csv: string | null }>(`
            SELECT string_agg(code || ',' || fuel_type || ',' || price::text || ',' || time_weighted_average::text
                              || ',' || change::text || ',' || jsonb_array_length(prices), E'\\n' ORDER BY code, fuel_type) AS csv
            FROM (SELECT * FROM get_price_trends_at_time('${at}'::timestamptz) ORDER BY code, fuel_type
                  LIMIT 4000 OFFSET ${offset}) t`);
        const page = (csv ?? '').split('\n').filter(Boolean);
        for (const line of page) {
            const [code, fuelType, price, twa, change, n] = line.split(',');
            rows.push({ key: seriesKey(code, fuelType), price: Number(price), twa: Number(twa), change: Number(change), n: Number(n) });
        }
        if (page.length < 4000) return rows;
    }
}

// The alert queries from the old fetch-prices Lambda, verbatim apart from the time literal.
const sqlEmails = (atTime: string) =>
    query<{ email: string; alerts: string }>(`
        SELECT u.email AS "email",
            json_agg(json_build_object('stationName', s.name, 'fuelType', trends.fuel_type, 'price', trends.price,
                'timeWeightedPrice', trends.time_weighted_average, 'changePercent', trends.change * 100,
                'recentPrices', trends.prices) ORDER BY trends.change DESC)::text AS "alerts"
        FROM get_price_trends_at_time(${atTime}) as trends
        JOIN users_stations_fuels usf ON usf.station_code = trends.code AND usf.fuel_type = trends.fuel_type
        JOIN users u ON u.uuid = usf.user_uuid
        JOIN stations s ON s.code = trends.code
        LEFT JOIN previous_alerts pa ON pa.station_code = trends.code AND pa.fuel_type = trends.fuel_type
            AND ${atTime} - INTERVAL '1 week' < pa.time AND pa.time <= ${atTime}
        GROUP BY u.uuid
        HAVING MAX(trends.change) > 0.05 AND SUM(CASE WHEN pa.station_code IS NULL AND trends.change > 0.05 THEN 1 ELSE 0 END) > 0`);

const sqlNewAlerts = async (atTime: string) =>
    (
        await query<{ csv: string | null }>(`
        SELECT string_agg(trends.code || '|' || trends.fuel_type, E'\\n') AS csv
        FROM get_price_trends_at_time(${atTime}) as trends
        LEFT JOIN previous_alerts pa ON pa.station_code = trends.code AND pa.fuel_type = trends.fuel_type
            AND ${atTime} - INTERVAL '1 week' < pa.time AND pa.time <= ${atTime}
        WHERE pa.station_code IS NULL AND trends.change > 0.05`)
    )[0].csv
        ?.split('\n')
        .filter(Boolean) ?? [];

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

async function main() {
    const stations = readStations(dir);
    const users = await query<{ uuid: string; email: string }>(`SELECT uuid::text AS uuid, email FROM users`);
    const usf = await query<{ user_uuid: string; station_code: string; fuel_type: string }>(
        `SELECT user_uuid::text AS user_uuid, station_code, fuel_type FROM users_stations_fuels`,
    );
    const subscriptions: Subscription[] = users.map((u) => {
        const rows = usf.filter((r) => r.user_uuid === u.uuid);
        return { email: u.email, fuelType: rows[0]?.fuel_type, stations: rows.map((r) => r.station_code) };
    });

    let failures = 0;
    const fixture: Record<string, unknown>[] = [];
    for (const t of times) {
        const at = new Date(t).toISOString();
        const literal = `'${at}'::timestamptz`;
        const state = buildState(dir, t);
        const js = computeTrends(state.series, stations, t);
        const sql = await sqlTrends(at);

        const jsByKey = new Map(js.map((tr) => [seriesKey(tr.code, tr.fuelType), tr]));
        const mismatches: string[] = [];
        if (js.length !== sql.length) mismatches.push(`row count js=${js.length} sql=${sql.length}`);
        for (const s of sql) {
            const j = jsByKey.get(s.key);
            if (!j) mismatches.push(`${s.key} missing in js`);
            else if (j.price !== s.price || !close(j.timeWeightedAverage, s.twa) || !close(j.change, s.change) || j.prices.length !== s.n) {
                mismatches.push(`${s.key} js=${JSON.stringify([j.price, j.timeWeightedAverage, j.change, j.prices.length])} sql=${JSON.stringify([s.price, s.twa, s.change, s.n])}`);
            }
        }

        const selection = selectAlerts({ trends: js, subscriptions, stations, lastAlert: state.lastAlert, t });
        const sqlNew = new Set(await sqlNewAlerts(literal));
        const jsNew = new Set(selection.newAlerts);
        const newDiff = [...sqlNew].filter((k) => !jsNew.has(k)).concat([...jsNew].filter((k) => !sqlNew.has(k)));
        if (newDiff.length) mismatches.push(`new alerts differ: ${newDiff.slice(0, 10).join(' ')}`);

        const emails = await sqlEmails(literal);
        if (emails.length !== selection.emails.length) mismatches.push(`emails js=${selection.emails.length} sql=${emails.length}`);
        for (const e of emails) {
            const mine = selection.emails.find((m) => m.email === e.email);
            const theirs = JSON.parse(e.alerts) as { stationName: string; price: number; timeWeightedPrice: number; recentPrices: unknown[] }[];
            const same =
                mine &&
                mine.alerts.length === theirs.length &&
                mine.alerts.every(
                    (a, i) =>
                        a.stationName === theirs[i].stationName &&
                        a.price === theirs[i].price &&
                        close(a.timeWeightedPrice, theirs[i].timeWeightedPrice) &&
                        a.recentPrices.length === theirs[i].recentPrices.length,
                );
            if (!same) mismatches.push(`email to ${e.email} differs`);
        }

        const rising = js.filter((tr) => tr.change > 0.05).length;
        console.log(
            `${at}: ${sql.length} trends, ${rising} rising >5%, ${sqlNew.size} new alerts, ${emails.length} emails -> ${mismatches.length ? 'MISMATCH' : 'identical'}`,
        );
        for (const m of mismatches.slice(0, 20)) console.log('   ', m);
        failures += mismatches.length;

        if (fixturePath) fixture.push({ at, sql, sqlNewAlerts: [...sqlNew].sort() });
    }

    if (fixturePath) writeFixture(fixture, stations, subscriptions);
    if (failures) process.exit(1);
}

/**
 * Golden fixture: the SQL output for a sample of series (every subscribed series, every
 * newly alerting series and a random spread), plus exactly the input those rows need.
 */
function writeFixture(runs: Record<string, unknown>[], stations: ReturnType<typeof readStations>, subscriptions: Subscription[]) {
    const all = runs.flatMap((r) => r.sql as SqlTrend[]);
    const keys = new Set<string>();
    for (const s of subscriptions) for (const code of s.stations) keys.add(seriesKey(code, s.fuelType));
    for (const r of runs) for (const k of (r.sqlNewAlerts as string[]).slice(0, 60)) keys.add(k);
    const sorted = [...new Set(all.map((s) => s.key))].sort();
    for (let i = 0; i < sorted.length; i += Math.ceil(sorted.length / 150)) keys.add(sorted[i]);

    const earliest = Math.min(...runs.map((r) => Date.parse(r.at as string)));
    const latest = Math.max(...runs.map((r) => Date.parse(r.at as string)));
    const state = buildState(dir, earliest);
    const series: Record<string, [number, string][]> = {};
    for (const [code, , fuelType, price, timestamp] of historyRows(dir, 'prices')) {
        const key = seriesKey(code, fuelType);
        const ts = parseTime(timestamp);
        if (keys.has(key) && ts >= earliest - WEEK_MS && ts < latest) (series[key] ??= []).push([ts, price]);
    }
    for (const key of keys) {
        const prior = state.series[key]?.find((p) => p[0] < earliest - WEEK_MS);
        series[key] = [...(prior ? [prior] : []), ...(series[key] ?? [])];
    }
    const alerts: Record<string, number[]> = {};
    for (const [code, fuelType, time] of historyRows(dir, 'alerts')) {
        const key = seriesKey(code, fuelType);
        const at = parseTime(time);
        if (keys.has(key) && at > earliest - WEEK_MS && at <= latest) (alerts[key] ??= []).push(at);
    }

    writeFileSync(
        fixturePath,
        JSON.stringify(
            {
                description: 'Output of the original Postgres get_price_trends_at_time for a sample of real series; see scripts/parity-check.ts',
                stations: Object.fromEntries([...keys].map((k) => k.split('|')[0]).filter((c) => stations[c]).map((c) => [c, stations[c]])),
                series,
                alerts,
                runs: runs.map((r) => ({
                    at: r.at,
                    trends: (r.sql as SqlTrend[]).filter((s) => keys.has(s.key)),
                    newAlerts: (r.sqlNewAlerts as string[]).filter((k) => keys.has(k)),
                })),
            },
            null,
            1,
        ),
    );
    console.log(`Wrote ${fixturePath} with ${keys.size} series`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

