// Rebuild public/sydney-prices.json.gz (the site's price-waves data) from a local copy of the
// history. Ingest rewrites it on every run that adds prices; this is for recovery, or to
// look at the file for another time:
//
//   aws s3 sync s3://<data bucket>/history/prices ./data/history/prices
//   aws s3 cp s3://<data bucket>/stations.json.gz ./data/
//   npx tsx scripts/build-sydney-prices.ts --dir ./data [--at 2026-09-27T00:00:00Z]
//   aws s3 cp ./data/public/sydney-prices.json.gz s3://<data bucket>/public/sydney-prices.json.gz \
//       --content-encoding gzip --content-type application/json

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { gunzipSync, gzipSync } from 'zlib';
import { keys, parseCsv } from '../src/store';
import { buildSydneyPrices, sydneyPricesDays, sydneyPricesWindow } from '../src/sydney-prices';
import { readStations } from './history';

const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i < 0 ? undefined : process.argv[i + 1];
};

const dir = arg('dir');
if (!dir) throw new Error('--dir is required');
const t = arg('at') ? Date.parse(arg('at')!) : Date.now();

const { from, to } = sydneyPricesWindow(t);
const rows: string[][] = [];
for (const day of sydneyPricesDays(from, to)) {
    const file = join(dir, keys.priceHistory(day));
    if (existsSync(file)) rows.push(...parseCsv(gunzipSync(readFileSync(file)).toString('utf8')));
}

const prices = buildSydneyPrices(rows, readStations(dir), from, to);
const out = join(dir, keys.sydneyPrices);
mkdirSync(dirname(out), { recursive: true });
const gz = gzipSync(JSON.stringify(prices));
writeFileSync(out, gz);

const points = Object.entries(prices.series).map(([fuel, s]) => `${fuel} ${s.reduce((n, [, flat]) => n + flat.length / 2, 0)}`);
console.log(
    `Wrote ${keys.sydneyPrices} for ${prices.from} to ${prices.to}: ${prices.stations.length} stations, ` +
        `points ${points.join(', ')}; ${(gz.length / 1024).toFixed(0)} KB gzipped`,
);
