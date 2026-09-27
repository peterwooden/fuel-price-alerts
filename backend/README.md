# Fuel Price Alerts: backend

The two Lambda functions (TypeScript, bundled with esbuild into `dist/`) plus their tests and
maintenance scripts. Infrastructure is in [`../terraform`](../terraform).

There's no database. S3 holds everything; see the layout at the top of `src/store.ts`. The
design and the cost reasoning are in [`../docs/cost-reduction.md`](../docs/cost-reduction.md).

## Code

| File | What it does |
| --- | --- |
| `src/trends.ts` | Pure alert logic: weekly time-weighted average, change, who to email. A port of the original SQL, verified identical |
| `src/ingest.ts` | Scheduled job: fetch → merge → alert → append history → commit state → email |
| `src/subscriptions.ts` | GET/POST a user's stations, authenticated with a Cognito ID token |
| `src/store.ts` | S3 persistence: state, stations, subscriptions, daily history files |
| `src/parquet.ts` | Monthly Parquet copies of history for analysis |
| `scripts/build-state.ts` | Rebuild `state.json.gz` from history (disaster recovery) |
| `scripts/build-parquet.ts` | Rebuild every monthly Parquet file from history |
| `scripts/export-aurora.ts`, `scripts/parity-check.ts` | One-off migration tools, kept for the record |

## Commands

```bash
npm ci
npm test            # unit tests, including parity with the original Postgres output
npm run typecheck
npm run build       # bundle dist/ingest and dist/subscriptions for Terraform
../build-and-deploy.sh
```

Configuration is read at runtime from SSM Parameter Store under `/fuel-price-alerts/`:
`nsw-api-key`, `nsw-api-basic-auth` (SecureString) and `error-email`.

## Operations

- Run ingest now: `aws lambda invoke --function-name fuel-price-alerts-ingest /dev/stdout`.
  Pass `{"atTime": "<ISO>"}` to evaluate alerts at another time.
- If state is lost or corrupted, restore an earlier version (the bucket is versioned for
  30 days) or rebuild it: `aws s3 sync s3://<bucket> ./data && npx tsx scripts/build-state.ts --dir ./data`,
  then upload `state.json.gz`.
- To analyse history, query `analytics/prices/*/*.parquet` (Hive-style `month=` partitions) with
  DuckDB, Athena or pandas. There's an example in `docs/cost-reduction.md`. The CSVs under `history/`
  are the source of truth; `scripts/build-parquet.ts` regenerates the Parquet files from them.
