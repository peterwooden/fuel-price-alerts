// S3 is the database. Layout of the data bucket:
//
//   state.json.gz                               hot window: last week of prices per series + recent alerts
//   stations.json.gz                            every station ever seen, keyed by code
//   subscriptions/<cognito sub>.json            one object per user
//   history/prices/date=YYYY-MM-DD/prices.csv.gz  full price history, one file per UTC day
//   history/alerts/date=YYYY-MM-DD/alerts.csv.gz  every alert ever raised, one file per UTC day
//   analytics/{prices,alerts}/month=YYYY-MM/*.parquet  monthly Parquet copies for analysis (see parquet.ts)
//
// History files are append-only (read, merge, rewrite) and are the source of truth; the
// Parquet files are derived from them. The Lambda only reads state.json.gz on the hot path.

import { gunzipSync, gzipSync } from 'zlib';
import {
    GetObjectCommand,
    ListObjectsV2Command,
    NoSuchKey,
    PutObjectCommand,
    S3Client,
} from '@aws-sdk/client-s3';
import { Dataset, historyToParquet } from './parquet';
import type { SeriesMap, StationMap, Subscription } from './trends';

export interface State {
    version: 1;
    updatedAt: string;
    series: SeriesMap;
    lastAlert: Record<string, number>;
}

export interface Stored<T> {
    value: T;
    etag?: string;
}

export const PRICE_COLUMNS = ['station_code', 'state', 'fuel_type', 'price', 'timestamp'] as const;
export const ALERT_COLUMNS = ['station_code', 'fuel_type', 'time'] as const;

export const keys = {
    state: 'state.json.gz',
    stations: 'stations.json.gz',
    subscription: (userId: string) => `subscriptions/${userId}.json`,
    subscriptionsPrefix: 'subscriptions/',
    priceHistory: (day: string) => `history/prices/date=${day}/prices.csv.gz`,
    alertHistory: (day: string) => `history/alerts/date=${day}/alerts.csv.gz`,
    historyMonthPrefix: (dataset: Dataset, month: string) => `history/${dataset}/date=${month}-`,
    analytics: (dataset: Dataset, month: string) => `analytics/${dataset}/month=${month}/${dataset}.parquet`,
};

/** UTC calendar day of an ISO timestamp, used to partition history. */
export const utcDay = (iso: string) => iso.slice(0, 10);
/** "YYYY-MM" of a day or timestamp. */
export const utcMonth = (isoOrDay: string) => isoOrDay.slice(0, 7);

const decode = (bytes: Uint8Array) =>
    (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : Buffer.from(bytes)).toString('utf8');

export class Store {
    constructor(
        private readonly bucket: string,
        private readonly s3: S3Client = new S3Client({}),
    ) {}

    async getText(key: string): Promise<Stored<string> | undefined> {
        try {
            const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
            return { value: decode(await res.Body!.transformToByteArray()), etag: res.ETag };
        } catch (e) {
            if (e instanceof NoSuchKey) return undefined;
            throw e;
        }
    }

    /**
     * Write an object, gzipped when the key ends in .gz. Pass `ifMatch` (or `ifNoneMatch: '*'`
     * for a new object) to fail instead of overwriting a concurrent change.
     */
    async putText(key: string, text: string, contentType: string, opts: { ifMatch?: string; ifNoneMatch?: '*' } = {}) {
        const gzip = key.endsWith('.gz');
        await this.s3.send(
            new PutObjectCommand({
                Bucket: this.bucket,
                Key: key,
                Body: gzip ? gzipSync(text) : text,
                ContentType: contentType,
                ...(gzip && { ContentEncoding: 'gzip' }),
                ...(opts.ifMatch && { IfMatch: opts.ifMatch }),
                ...(opts.ifNoneMatch && { IfNoneMatch: opts.ifNoneMatch }),
            }),
        );
    }

    async getJson<T>(key: string): Promise<Stored<T> | undefined> {
        const text = await this.getText(key);
        return text && { value: JSON.parse(text.value) as T, etag: text.etag };
    }

    putJson(key: string, value: unknown, opts: { ifMatch?: string } = {}) {
        return this.putText(key, JSON.stringify(value), 'application/json', opts);
    }

    getState = () => this.getJson<State>(keys.state);
    getStations = () => this.getJson<StationMap>(keys.stations);

    getSubscription = (userId: string) => this.getJson<Subscription>(keys.subscription(userId));
    putSubscription = (userId: string, subscription: Subscription & { updatedAt: string }) =>
        this.putJson(keys.subscription(userId), subscription);

    async listKeys(prefix: string): Promise<string[]> {
        const found: string[] = [];
        let ContinuationToken: string | undefined;
        do {
            const page = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken }));
            for (const { Key } of page.Contents ?? []) found.push(Key!);
            ContinuationToken = page.NextContinuationToken;
        } while (ContinuationToken);
        return found.sort();
    }

    async listSubscriptions(): Promise<Subscription[]> {
        const subscriptions: Subscription[] = [];
        for (const key of await this.listKeys(keys.subscriptionsPrefix)) {
            const sub = await this.getJson<Subscription>(key);
            if (sub) subscriptions.push(sub.value);
        }
        return subscriptions;
    }

    /** Regenerate a month's Parquet file from its daily CSVs. */
    async rebuildMonthlyParquet(dataset: Dataset, month: string) {
        const rows: string[][] = [];
        for (const key of await this.listKeys(keys.historyMonthPrefix(dataset, month))) {
            const day = await this.getText(key);
            if (day) rows.push(...parseCsv(day.value));
        }
        if (!rows.length) return 0;
        await this.s3.send(
            new PutObjectCommand({
                Bucket: this.bucket,
                Key: keys.analytics(dataset, month),
                Body: historyToParquet(dataset, rows),
                ContentType: 'application/vnd.apache.parquet',
            }),
        );
        return rows.length;
    }

    /**
     * Append rows to a day's history file, skipping rows whose identity is already present
     * (the equivalent of the old unique constraints). Returns the rows actually added.
     */
    async appendHistory(
        key: string,
        header: readonly string[],
        rows: string[][],
        identity: (row: string[]) => string,
    ): Promise<string[][]> {
        const existing = await this.getText(key);
        const lines = existing ? parseCsv(existing.value) : [];
        const seen = new Set(lines.map(identity));
        const added: string[][] = [];
        for (const row of rows) {
            const id = identity(row);
            if (seen.has(id)) continue;
            seen.add(id);
            added.push(row);
        }
        if (added.length) {
            await this.putText(
                key,
                toCsv(header, [...lines, ...added]),
                'text/csv',
                existing ? { ifMatch: existing.etag } : { ifNoneMatch: '*' },
            );
        }
        return added;
    }
}

/** Unique key of a price row: (station_code, fuel_type, timestamp). */
export const priceIdentity = (row: string[]) => `${row[0]}|${row[2]}|${row[4]}`;
/** Alerts had no unique constraint; a whole row identifies one. */
export const alertIdentity = (row: string[]) => row.join('|');

export function toCsv(header: readonly string[], rows: string[][]): string {
    for (const row of rows) {
        for (const value of row) {
            if (/[",\n\r]/.test(value)) throw new Error(`Refusing to write unquoted CSV value: ${value}`);
        }
    }
    return [header.join(','), ...rows.map((row) => row.join(','))].join('\n') + '\n';
}

/** Parse the simple (unquoted) CSV this module writes; drops the header row. */
export function parseCsv(text: string): string[][] {
    return text
        .split('\n')
        .slice(1)
        .filter((line) => line.length > 0)
        .map((line) => line.split(','));
}
