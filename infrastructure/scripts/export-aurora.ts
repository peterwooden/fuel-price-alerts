// One-off migration: export every table from the retired Aurora cluster into the S3
// layout described in src/store.ts, verifying each day of history against a checksum
// computed inside Postgres.
//
//   npx tsx scripts/export-aurora.ts --cluster <arn> --secret <arn> --out <dir>
//   aws s3 sync <dir> s3://<data bucket>/

import { createHash } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { gzipSync } from 'zlib';
import { ExecuteStatementCommand, RDSDataClient } from '@aws-sdk/client-rds-data';
import { ALERT_COLUMNS, keys, PRICE_COLUMNS, toCsv } from '../src/store';
import type { StationMap, Subscription } from '../src/trends';

const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    if (i < 0) throw new Error(`--${name} is required`);
    return process.argv[i + 1];
};
const cluster = arg('cluster');
const secret = arg('secret');
const out = arg('out');

const rds = new RDSDataClient({ region: cluster.split(':')[3] });

async function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    for (let attempt = 0; ; attempt++) {
        try {
            const res = await rds.send(
                new ExecuteStatementCommand({
                    resourceArn: cluster,
                    secretArn: secret,
                    database: 'postgres',
                    sql,
                    formatRecordsAs: 'JSON',
                }),
            );
            return JSON.parse(res.formattedRecords ?? '[]');
        } catch (e) {
            const name = (e as Error).name;
            if (attempt < 20 && /Resuming|Throttling|ServiceUnavailable|Timeout/i.test(name + (e as Error).message)) {
                await new Promise((r) => setTimeout(r, 3000));
                continue;
            }
            throw e;
        }
    }
}

function write(key: string, body: string | Buffer) {
    const path = join(out, key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, key.endsWith('.gz') ? gzipSync(body) : body);
}

const lineChecksum = (lines: string[]) =>
    lines.reduce((sum, line) => sum + BigInt('0x' + createHash('md5').update(line).digest('hex').slice(0, 12)), 0n).toString();

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    await Promise.all(
        Array.from({ length: limit }, async () => {
            while (next < items.length) {
                const i = next++;
                results[i] = await fn(items[i]);
            }
        }),
    );
    return results;
}

/**
 * Export a table as one CSV per UTC day. `line` is a SQL expression producing the CSV
 * line for a row; the same expression feeds the checksum, so a match proves every byte
 * arrived intact.
 */
async function exportDaily(opts: {
    name: string;
    table: string;
    timeColumn: string;
    line: string;
    order: string;
    header: readonly string[];
    key: (day: string) => string;
}) {
    const day = `to_char(${opts.timeColumn} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
    const days = await query<{ day: string; rows: number; checksum: string }>(`
        SELECT ${day} AS day, count(*)::int AS rows,
               sum(('x' || substr(md5(${opts.line}), 1, 12))::bit(48)::bigint)::text AS checksum
        FROM ${opts.table} GROUP BY 1 ORDER BY 1`);

    // Batch consecutive days so each Data API response stays well under its 1 MB limit.
    const batches: (typeof days)[] = [];
    let current: typeof days = [];
    let rows = 0;
    for (const d of days) {
        if (current.length && rows + d.rows > 12_000) {
            batches.push(current);
            current = [];
            rows = 0;
        }
        current.push(d);
        rows += d.rows;
    }
    if (current.length) batches.push(current);

    let done = 0;
    await mapLimit(batches, 4, async (batch) => {
        const from = batch[0].day;
        const to = batch[batch.length - 1].day;
        const [{ csv }] = await query<{ csv: string | null }>(`
            SELECT string_agg(${opts.line}, E'\\n' ORDER BY ${opts.order}) AS csv
            FROM ${opts.table}
            WHERE ${opts.timeColumn} >= (DATE '${from}')::timestamp AT TIME ZONE 'UTC'
              AND ${opts.timeColumn} < (DATE '${to}' + 1)::timestamp AT TIME ZONE 'UTC'`);
        const byDay = new Map<string, string[]>();
        for (const line of (csv ?? '').split('\n')) {
            if (!line) continue;
            const d = line.split(',')[opts.header.length - 1].slice(0, 10);
            if (!byDay.has(d)) byDay.set(d, []);
            byDay.get(d)!.push(line);
        }
        for (const expected of batch) {
            const lines = byDay.get(expected.day) ?? [];
            if (lines.length !== expected.rows || lineChecksum(lines) !== expected.checksum) {
                throw new Error(
                    `${opts.name} ${expected.day}: got ${lines.length} rows / ${lineChecksum(lines)}, expected ${expected.rows} / ${expected.checksum}`,
                );
            }
            write(opts.key(expected.day), toCsv(opts.header, lines.map((l) => l.split(','))));
        }
        done += batch.length;
        process.stdout.write(`\r${opts.name}: ${done}/${days.length} days`);
    });
    process.stdout.write('\n');
    return { days: days.length, rows: days.reduce((n, d) => n + d.rows, 0) };
}

async function main() {
    const nulls = await query<Record<string, number>>(`
        SELECT count(*) FILTER (WHERE station_code IS NULL OR state IS NULL OR fuel_type IS NULL
                                 OR price IS NULL OR timestamp IS NULL)::int AS prices,
               (SELECT count(*)::int FROM previous_alerts) AS alerts_total
        FROM prices`);
    if (nulls[0].prices) throw new Error(`prices has ${nulls[0].prices} rows with NULLs; CSV export would lose them`);

    const iso = (col: string, fraction = '') => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS${fraction}"Z"')`;
    const prices = await exportDaily({
        name: 'prices',
        table: 'prices',
        timeColumn: 'timestamp',
        line: `station_code || ',' || state || ',' || fuel_type || ',' || price::text || ',' || ${iso('timestamp')}`,
        order: 'timestamp, station_code, fuel_type',
        header: PRICE_COLUMNS,
        key: keys.priceHistory,
    });
    const alerts = await exportDaily({
        name: 'alerts',
        table: 'previous_alerts',
        timeColumn: 'time',
        line: `station_code || ',' || fuel_type || ',' || ${iso('time', '.US')}`,
        order: 'time, station_code, fuel_type',
        header: ALERT_COLUMNS,
        key: keys.alertHistory,
    });

    // Stations: current snapshot, same shape the Lambda writes.
    const stationRows: Record<string, string | null>[] = [];
    for (let offset = 0; ; offset += 1000) {
        const page = await query<Record<string, string | null>>(`
            SELECT brand_id, station_id, brand, code, name, address, latitude::text AS latitude,
                   longitude::text AS longitude, state
            FROM stations ORDER BY code LIMIT 1000 OFFSET ${offset}`);
        stationRows.push(...page);
        if (page.length < 1000) break;
    }
    const stations: StationMap = {};
    for (const s of stationRows) {
        stations[s.code!] = {
            brand_id: s.brand_id!,
            station_id: s.station_id!,
            brand: s.brand!,
            code: s.code!,
            name: s.name!,
            address: s.address!,
            latitude: Number(s.latitude),
            longitude: Number(s.longitude),
            state: s.state!,
        };
    }
    write(keys.stations, JSON.stringify(stations));

    // Users and their subscriptions: one object per user.
    const users = await query<{ uuid: string; email: string }>(`SELECT uuid::text AS uuid, email FROM users`);
    const userStations = await query<{ user_uuid: string; station_code: string; fuel_type: string }>(
        `SELECT user_uuid::text AS user_uuid, station_code, fuel_type FROM users_stations_fuels`,
    );
    for (const user of users) {
        const rows = userStations.filter((r) => r.user_uuid === user.uuid);
        const fuelTypes = [...new Set(rows.map((r) => r.fuel_type))];
        if (fuelTypes.length > 1) throw new Error(`User ${user.uuid} has several fuel types; the API only supports one`);
        if (!rows.length) continue;
        const subscription: Subscription & { updatedAt: string } = {
            email: user.email,
            fuelType: fuelTypes[0],
            stations: rows.map((r) => r.station_code),
            updatedAt: new Date().toISOString(),
        };
        write(keys.subscription(user.uuid), JSON.stringify(subscription, null, 2));
    }

    // Verbatim copies of the small tables and the schema, for a faithful restore if ever needed.
    const raw = 'migration/aurora-export';
    const dump = async (table: string, sql: string) => {
        const rows = await query<Record<string, unknown>>(sql);
        const cols = rows.length ? Object.keys(rows[0]) : [];
        const cell = (v: unknown) => (v === null ? '' : `"${String(v).replace(/"/g, '""')}"`);
        write(`${raw}/${table}.csv`, [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n');
        return rows.length;
    };
    const tables = {
        stations: await dump('stations', `SELECT brand_id, station_id, brand, code, name, address, latitude::text AS latitude, longitude::text AS longitude, state FROM stations ORDER BY code`),
        users: await dump('users', `SELECT uuid::text AS uuid, email FROM users`),
        users_stations_fuels: await dump('users_stations_fuels', `SELECT user_uuid::text AS user_uuid, station_code, fuel_type FROM users_stations_fuels`),
        migrations: await dump('migrations', `SELECT name FROM migrations`),
    };
    const [fn] = await query<{ def: string }>(`SELECT pg_get_functiondef('get_price_trends_at_time'::regproc) AS def`);
    const [view] = await query<{ def: string }>(`SELECT pg_get_viewdef('current_alerts'::regclass) AS def`);
    const [ddl] = await query<{ def: string }>(`
        SELECT string_agg(format('-- %s: %s', table_name, cols), E'\\n') AS def FROM (
            SELECT table_name, string_agg(column_name || ' ' || data_type, ', ' ORDER BY ordinal_position) AS cols
            FROM information_schema.columns WHERE table_schema = 'public' GROUP BY table_name) t`);
    write(
        `${raw}/schema.sql`,
        `-- Column listing\n${ddl.def}\n\n-- get_price_trends_at_time\n${fn.def}\n\n-- current_alerts view\nCREATE VIEW current_alerts AS\n${view.def}\n`,
    );

    const [counts] = await query<Record<string, number>>(`
        SELECT (SELECT count(*)::int FROM prices) AS prices, (SELECT count(*)::int FROM previous_alerts) AS previous_alerts,
               (SELECT count(*)::int FROM stations) AS stations`);
    if (counts.prices !== prices.rows || counts.previous_alerts !== alerts.rows || counts.stations !== Object.keys(stations).length) {
        throw new Error(`Row counts changed during export: ${JSON.stringify({ counts, prices, alerts })}`);
    }

    const manifest = {
        exportedAt: new Date().toISOString(),
        source: cluster,
        prices: { ...prices, key: 'history/prices/date=YYYY-MM-DD/prices.csv.gz' },
        previous_alerts: { ...alerts, key: 'history/alerts/date=YYYY-MM-DD/alerts.csv.gz' },
        stations: Object.keys(stations).length,
        subscriptions: users.length,
        tables,
        verification: 'Per-day row count and md5-based checksum computed in Postgres matched the exported lines.',
    };
    write(`${raw}/manifest.json`, JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
