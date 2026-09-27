// Rebuild state.json.gz (the Lambda's hot window) from the history files. Used once at
// migration, and for disaster recovery if the state object is ever lost or corrupted:
//
//   aws s3 sync s3://<data bucket> ./data
//   npx tsx scripts/build-state.ts --dir ./data [--at 2026-09-27T00:00:00Z]
//   aws s3 cp ./data/state.json.gz s3://<data bucket>/state.json.gz --content-encoding gzip --content-type application/json

import { writeFileSync } from 'fs';
import { join } from 'path';
import { gzipSync } from 'zlib';
import { keys } from '../src/store';
import { buildState } from './history';

const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i < 0 ? undefined : process.argv[i + 1];
};

const dir = arg('dir');
if (!dir) throw new Error('--dir is required');
const t = arg('at') ? Date.parse(arg('at')!) : Date.now();

const state = buildState(dir, t);
writeFileSync(join(dir, keys.state), gzipSync(JSON.stringify(state)));
const points = Object.values(state.series).reduce((n, s) => n + s.length, 0);
console.log(
    `Wrote ${keys.state} as of ${new Date(t).toISOString()}: ${Object.keys(state.series).length} series, ${points} points, ${Object.keys(state.lastAlert).length} recent alerts`,
);
