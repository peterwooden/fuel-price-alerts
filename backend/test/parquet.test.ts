import { parquetReadObjects } from 'hyparquet';
import { describe, expect, it } from 'vitest';
import { historyToParquet } from '../src/parquet';

const read = (bytes: Uint8Array) =>
    parquetReadObjects({ file: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });

describe('historyToParquet', () => {
    it('writes typed price rows sorted by station, fuel and time', async () => {
        const rows = await read(
            historyToParquet('prices', [
                ['2', 'NSW', 'U91', '189.9', '2026-09-02T00:00:00Z'],
                ['1', 'NSW', 'U91', '179.5', '2026-09-03T00:00:00Z'],
                ['1', 'NSW', 'E10', '175', '2026-09-01T00:00:00Z'],
                ['1', 'NSW', 'U91', '178.9', '2026-09-01T00:00:00Z'],
            ]),
        );
        expect(rows.map((r) => [r.station_code, r.fuel_type, r.price])).toEqual([
            ['1', 'E10', 175],
            ['1', 'U91', 178.9],
            ['1', 'U91', 179.5],
            ['2', 'U91', 189.9],
        ]);
        expect((rows[0].timestamp as Date).toISOString()).toBe('2026-09-01T00:00:00.000Z');
    });

    it('accepts the microsecond timestamps migrated from Postgres', async () => {
        const [row] = await read(historyToParquet('alerts', [['1', 'U91', '2026-09-26T21:10:27.642407Z']]));
        expect((row.time as Date).toISOString()).toBe('2026-09-26T21:10:27.642Z');
    });
});
