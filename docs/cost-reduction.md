# Fuel Price Alerts: cutting the AWS bill by >99%

September 2026. Written up with the double diamond (discover, define, develop, deliver),
with back-of-napkin numbers at each step. Every figure below was measured on the live
account or from Cost Explorer; estimates are marked as such.

## 1. Discover: what's there and what it costs

**Account bill, August 2026: $107.12** (Cost Explorer, including 10% GST).

| Where the money goes | $/month | What it is |
| --- | ---: | --- |
| Aurora Serverless v2, compute | 44.85 | 224 ACU-hours at $0.20 |
| Aurora PostgreSQL 13 **Extended Support** | 22.87 | a surcharge for running an out-of-support engine, charged per ACU-hour |
| Aurora I/O | 4.84 | 22M I/Os, mostly the alert query re-scanning prices every run |
| Aurora storage + backups | 0.63 | |
| **Fuel Price Alerts subtotal** | **~73.2** | plus $1.20 for 3 Secrets Manager secrets (2 orphaned) |
| OpenVPN EC2 in us-east-1 (t2.micro, IPv4, EBS) | 13.15 | not part of this repo; see §5 |
| EBS volumes of 4 EC2 instances stopped since 2021 | 5.06 | not part of this repo |
| Idle Elastic IP on a stopped instance | 3.72 | not part of this repo |
| Route 53 hosted zones (2) | 1.00 | needed for peterwooden.com / polymerlaw.com |
| Tax | 9.74 | |

The RDS line grew from $38.51 in March to $73.19 in August. AWS force-migrated the
retired Aurora Serverless v1 cluster to v2 and upgraded the engine to PostgreSQL 13,
which then went into paid Extended Support.

**How the system is actually used** (measured):

- One scheduled job every 2 hours. It spends a few seconds of work per run, and for that
  Aurora is woken from auto-pause and kept up for at least 5 minutes each time. It
  occasionally failed outright with `DatabaseResumingException` while the cluster resumed.
- **One user** (the owner) with 5 subscribed stations. The API was last called in December 2025.
- Data: `prices` 4,716,057 rows (926 MB in Postgres with its three indexes), 14,352
  station×fuel series, ~4,600 new rows/day; `previous_alerts` 261,094 rows; 4,084 stations.

**Requirements** (the only things treated as fixed):

- Functional
  - F1. Every 2 hours, fetch all NSW stations and prices from the FuelCheck API.
  - F2. Keep full price history (dedupe on station, fuel, timestamp) and station details.
  - F3. Users sign up and sign in at fuelpricealerts.peterwooden.com (Cognito, email verification).
  - F4. Users pick one fuel type and up to 5 stations (authenticated GET/POST API).
  - F5. When a subscribed series is >5% above its time-weighted average over the past week
    and hasn't alerted in the past week, email the user a table and chart of all their
    stations. Record every alert.
  - F6. Email an operator when ingestion fails.
- Non-functional
  - Existing data (history, alerts, stations, users, subscriptions, the Cognito user) must be preserved.
  - Alerts within one ingestion cycle; API responds in about a second.
  - Durable, recoverable storage; secrets kept out of code and templates.
  - Maintainable: supported runtimes and tooling.
  - Cost: as close to zero as possible.

## 2. Define: the actual problem

> A database server billed by the hour is doing about a second of real work every two
> hours, on data that is append-only and whose working set is a few hundred kilobytes.

The alert computation (`get_price_trends_at_time`) only ever needs, per series, the prices
from the last 7 days plus the one price just before that window. Napkin maths:

- Working set: 14,352 series × ~2.5 points ≈ **35k points**. As gzipped JSON that's **215 KB**
  (measured). The SQL function scanned the whole `prices` table to find it on every run.
- History: 4.7M rows × ~40 bytes as CSV ≈ 190 MB raw, **30 MB gzipped** (measured),
  growing ~26 KB/day.
- Writers: exactly one (the scheduled job). Readers: one job and a handful of API calls a month.

None of this needs a database engine. It needs somewhere durable to keep a small hot file
and an append-only log.

## 3. Develop: options, with napkin costs

Monthly estimates for ap-southeast-2 at this workload, excluding shared costs (DNS, tax):

| Option | Est. $/month | Why not / why |
| --- | ---: | --- |
| Status quo: Aurora Serverless v2, PG 13 | 73 | measured; pays Extended Support + ACU-hours for a 5 s job |
| Upgrade Aurora to PG 16/17 | ~50 | removes Extended Support; still pays ACU-hours for every wake-up |
| RDS PostgreSQL db.t4g.micro + 20 GB | ~23 | runs 24/7 for a job that runs 12×/day |
| EC2 t4g.nano + self-managed Postgres | ~8 | includes public IPv4 ($3.65); you become the DBA |
| Aurora DSQL (serverless Postgres-compatible) | low single $ (rough) | no PL/pgSQL functions or views, so a rewrite anyway; still pays per query for a full-window scan |
| TigerBeetle | ~15+ | a financial-ledger database (accounts and transfers) that runs as a 3–6 node always-on cluster: wrong data model, and back to hourly billing |
| S3 Tables / Iceberg | ~1+ | managed compaction and per-table fees for 30 MB of data |
| DynamoDB on-demand | ~0.5 | 1 GB storage at $0.285/GB; time-window access needs a data model; still more than needed |
| **S3 + Lambda, "files as the database"** | **~0.02** | chosen |

Napkin cost of the chosen design (ap-southeast-2 list prices, before any free tier):

- Lambda: 360 runs × ~5 s × 0.5 GB = 900 GB-s → **$0.012** (well inside the permanent free tier of 400,000 GB-s).
- S3 requests: ~4 PUT + ~6 GET/LIST per run → ~3,600/month → **$0.01**.
- S3 storage: 30 MB of history + ~90 MB of 30-day object versions → **$0.003**.
- Function URL, EventBridge schedule, Cognito (1 user), SSM standard parameters: **free**.
- CloudFront + S3 for the static site: inside the free tier.

**About $0.02/month against $73.2: a reduction of more than 99.9%.**

## 4. Deliver: the new design

```
EventBridge (every 2h) ──> Ingest Lambda ──> NSW FuelCheck API
                                │  reads/writes
                                ▼
                     S3 data bucket (versioned)
                       state.json.gz          hot window, 215 KB
                       stations.json.gz
                       subscriptions/<user>.json
                       history/prices/date=YYYY-MM-DD/prices.csv.gz
                       history/alerts/date=YYYY-MM-DD/alerts.csv.gz
                       analytics/{prices,alerts}/month=YYYY-MM/*.parquet
                                ▲
Browser ──> CloudFront + S3 site ──(Cognito ID token)──> Subscriptions Lambda (Function URL)
```

- **Ingest** loads `state.json.gz`, fetches the API, merges new points, computes trends and
  alerts in memory, appends to the day's history files, commits state with an S3
  conditional write, then sends emails.
- **Analysis copy in Parquet.** After each run, ingest rebuilds the monthly Parquet file for
  any month it touched (details under "Historical analysis" below).
- **Subscriptions API** is a Lambda Function URL. It verifies the Cognito ID token with
  `aws-jwt-verify`, which checks audience and token use (the old code checked neither), and
  reads or writes one small JSON object per user.
- **No VPC, no database, no NAT, no Secrets Manager.** The NSW API credentials moved from
  plaintext Lambda environment variables (which were also visible in the CloudFormation
  template) to SSM SecureString parameters.
- Stacks: `FuelPriceAlertsStack` (ap-southeast-2) is updated in place and keeps the existing
  Cognito pool and client (same logical IDs, verified with `cdk diff`: zero changes to
  them). `FuelPriceAlertsWeb` (us-east-1) holds CloudFront, its certificate, and the site bucket.
- Upgraded along the way: CDK v1 (end of life in 2023) to v2, Node.js 14 to 24 on arm64,
  GitHub Actions only deploys from `main`, log retention set.

### Correctness: proven against the original SQL

`scripts/parity-check.ts` ran the original Postgres function and alert queries and the
new TypeScript engine on identical data at 11 timestamps between 2021 and 2026, including
five moments when a real alert email went out. **Every trend row (up to 14,352 per run),
every new-alert decision (up to 1,843 in one run) and every email matched.** A 279-series
golden fixture captured from Postgres keeps this covered in `npm test`.

Two quirks of the original were kept on purpose, so that migrating didn't also change
behaviour. They'd be easy follow-ups:
- For a brand-new series the weekly average isn't renormalised to the time it has existed,
  so new series can alert spuriously.
- Alerts are recorded for every series, subscribed or not (that's why `previous_alerts` has 261k rows).

### Data preservation

- `scripts/export-aurora.ts` exports every table. Every day of `prices` and `previous_alerts`
  is checked against a row count and md5-based checksum **computed inside Postgres**. All
  4,059 day files matched on the trial run. The small tables are also copied verbatim with
  the schema (`migration/aurora-export/`).
- A final Aurora snapshot is kept as a second, independent copy (about $0.02/month).
- The data bucket is versioned (30 days of old versions) and `RETAIN`ed.
- `scripts/build-state.ts` rebuilds the hot window from history alone, for disaster recovery.

### Historical analysis: Parquet

The daily CSVs stay the append log and source of truth; ingest dedupes against them just as
the old unique constraint did. Monthly Parquet files (`analytics/prices/month=YYYY-MM/prices.parquet`
and the alerts equivalent) are derived from them. This keeps the write path simple and makes the
Parquet always rebuildable (`scripts/build-parquet.ts`), so a Parquet bug can never lose data.

Measured on the full export:
- **Identical content:** 4,716,057 prices and 261,094 alerts. DuckDB found 0 missing and 0 extra rows versus the CSVs.
- **Typed columns:** `price` is a double and `timestamp` a UTC timestamp, sorted by station, fuel and time.
- **Size:** 21.5 MB against 28.4 MB of gzipped CSV. Only about 25% smaller with Snappy, because gzip
  already compresses this narrow data well. Delta-encoding the timestamps didn't help.
- **Speed:** a typical query (average price by fuel this month) took 0.04 s against 1.04 s over the CSVs.
- **Cost:** about 107 extra small objects and roughly one extra GET+PUT per run: fractions of a cent.

```sql
-- DuckDB (install httpfs; run `CREATE SECRET (TYPE s3, PROVIDER credential_chain)` first)
SELECT fuel_type, date_trunc('week', timestamp) AS week, avg(price)
FROM read_parquet('s3://<bucket>/analytics/prices/*/*.parquet', hive_partitioning = true)
WHERE station_code = '2362'
GROUP BY ALL ORDER BY week;
```

### Trade-offs accepted

- No live SQL database; analysis runs over the Parquet files instead (above).
- Single writer. This is enforced by reserved concurrency 1 plus conditional writes on state.
- Emails are at-most-once, the same as before: alerts are committed before sending.

## 5. The rest of the account

Found while analysing; not part of this repo. Each needs the owner's decision, see the runbook.

| Item | $/month | Evidence | Recommendation |
| --- | ---: | --- | --- |
| OpenVPN t2.micro, us-east-1 (Terraform, 2023) | 13.15 | ~0.6 MB/week outbound for 13 weeks, which is background noise and not VPN traffic | terminate if unused |
| 4 EC2 instances (polymer-api, polymer-nginx-2, personal-dev, unnamed t2.nano) | 5.06 | stopped since mid-2021; DNS for polymerlaw.com already points at IPs they released | snapshot to AMI, then terminate |
| Elastic IP 3.24.27.23 | 3.72 | attached to a stopped instance; not referenced in DNS | release |
| Legacy CDK v1 staging bucket (1 GB of 2021 build artefacts) | 0.03 | replaced by the CDK v2 bootstrap | empty and delete |
| 2 orphaned Secrets Manager secrets (`rds-db-credentials/*`) | 0.80 | created by the Query Editor in 2021 | delete |
| RDS snapshot `polymer-db-instance-final-snapshot` (20 GB, 2021) | ~0.4 | final snapshot of a deleted database | keep or delete: owner's call |
| 4 empty `fuelpricealertsstack-frontendwebsitebucket*` buckets, the old site bucket, an empty Cognito pool | 0 | leftovers from 2021 fuel deploy attempts | delete for tidiness |
| IAM keys unused since 2021: 2 with **AdministratorAccess** (`amplify-dell-laptop`, `fuel-price-alerts-cli`), 4 scoped CI keys | 0 | security risk rather than cost | deactivate |
| personal-dev Lambdas/APIs/DynamoDB, ai-challenge (2025), peterwooden.com site | ~0 | no meaningful cost | leave |

**Projected bill if all of this is done: ~$1.25/month** (Route 53 plus tax), down from $107.
Domain renewals (~$31/year) are separate.
