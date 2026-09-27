// (Re)build every monthly Parquet file from the daily CSV history in a local copy of the
// data bucket. Used once at migration; ingest keeps them current after that.
//
//   npx tsx scripts/build-parquet.ts --dir ./data
//   aws s3 sync ./data/analytics s3://<data bucket>/analytics

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { gunzipSync } from 'zlib';
import { Dataset, historyToParquet } from '../src/parquet';
import { keys, parseCsv } from '../src/store';

const i = process.argv.indexOf('--dir');
if (i < 0) throw new Error('--dir is required');
const dir = process.argv[i + 1];

for (const dataset of ['prices', 'alerts'] as Dataset[]) {
    const root = join(dir, 'history', dataset);
    if (!existsSync(root)) continue;
    const byMonth = new Map<string, string[]>();
    for (const day of readdirSync(root).sort()) {
        const month = day.replace('date=', '').slice(0, 7);
        if (!byMonth.has(month)) byMonth.set(month, []);
        byMonth.get(month)!.push(join(root, day, `${dataset}.csv.gz`));
    }
    let total = 0;
    for (const [month, files] of byMonth) {
        const rows = files.flatMap((f) => parseCsv(gunzipSync(readFileSync(f)).toString('utf8')));
        const out = join(dir, keys.analytics(dataset, month));
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, historyToParquet(dataset, rows));
        total += rows.length;
    }
    console.log(`${dataset}: ${byMonth.size} monthly files, ${total} rows`);
}
