// Monthly Parquet copies of the history, for analysis with DuckDB, Athena, pandas, etc.
// They are derived from the daily CSVs (the source of truth) and can always be rebuilt,
// so a bug here can never lose data.
//
//   analytics/prices/month=YYYY-MM/prices.parquet   station_code, state, fuel_type, price (double), timestamp
//   analytics/alerts/month=YYYY-MM/alerts.parquet   station_code, fuel_type, time
//
// Rows are sorted by station, fuel and time, which compresses well and lets readers skip
// row groups when filtering by station.

import { parquetWriteBuffer } from 'hyparquet-writer';

export type Dataset = 'prices' | 'alerts';

/** Micro/milli-second tolerant ISO parse (alerts migrated from Postgres carry microseconds). */
const toDate = (iso: string) => new Date(Date.parse(iso.replace(/(\.\d{3})\d+Z$/, '$1Z')));

/** Sort by (station_code, fuel_type, time); column positions differ per dataset. */
const sortRows = (rows: string[][], fuelColumn: number, timeColumn: number) =>
    [...rows].sort(
        (a, b) =>
            a[0].localeCompare(b[0]) ||
            a[fuelColumn].localeCompare(b[fuelColumn]) ||
            a[timeColumn].localeCompare(b[timeColumn]),
    );

export function historyToParquet(dataset: Dataset, rows: string[][]): Uint8Array {
    if (dataset === 'prices') {
        // station_code, state, fuel_type, price, timestamp
        const sorted = sortRows(rows, 2, 4);
        return new Uint8Array(
            parquetWriteBuffer({
                columnData: [
                    { name: 'station_code', data: sorted.map((r) => r[0]), type: 'STRING', nullable: false },
                    { name: 'state', data: sorted.map((r) => r[1]), type: 'STRING', nullable: false },
                    { name: 'fuel_type', data: sorted.map((r) => r[2]), type: 'STRING', nullable: false },
                    { name: 'price', data: sorted.map((r) => Number(r[3])), type: 'DOUBLE', nullable: false },
                    { name: 'timestamp', data: sorted.map((r) => toDate(r[4])), type: 'TIMESTAMP', nullable: false },
                ],
            }),
        );
    }
    // station_code, fuel_type, time
    const sorted = sortRows(rows, 1, 2);
    return new Uint8Array(
        parquetWriteBuffer({
            columnData: [
                { name: 'station_code', data: sorted.map((r) => r[0]), type: 'STRING', nullable: false },
                { name: 'fuel_type', data: sorted.map((r) => r[1]), type: 'STRING', nullable: false },
                { name: 'time', data: sorted.map((r) => toDate(r[2])), type: 'TIMESTAMP', nullable: false },
            ],
        }),
    );
}
