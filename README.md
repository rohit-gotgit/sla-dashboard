# SLA Monitoring Dashboard

Upload a CSV of health-check logs → a serverless function cleans and validates it → cleaned checks are stored in Postgres → a single-screen dashboard shows SLA stats and the underlying logs.

- **Live app:** `TODO – paste your Vercel URL`
- **Last verified live:** `TODO – date`
- **Upload screen:** `<live url>/upload.html` · **Dashboard:** `<live url>/`

## 1. Architecture

```
 Browser                       Vercel (free)                          Neon (free)
┌──────────────┐  POST CSV   ┌────────────────────────┐   SQL      ┌───────────────┐
│ upload.html  │ ──────────▶ │ api/upload  (function) │ ─────────▶ │ Postgres      │
└──────────────┘             │  parse → validate →    │ (1 txn)    │  uploads      │
┌──────────────┐  GET JSON   │  clean → dedupe → save │            │  checks       │
│ index.html   │ ◀────────── │ api/stats, api/logs,   │ ◀───────── │  rejected_rows│
│ (dashboard)  │             │ api/uploads (functions)│  queries   └───────────────┘
└──────────────┘             └────────────────────────┘
```

| Piece | Choice | Why |
|---|---|---|
| UI | Static HTML + vanilla JS (`public/`) | No build step, nothing to break; two pages: upload and dashboard. |
| Stateless function | **Vercel Functions** (Node/TypeScript; run on AWS Lambda) | Real cloud serverless, free Hobby tier, no credit card, deploy by importing the GitHub repo. |
| Database | **Neon Postgres** (free tier) | No card, real SQL, re-queryable after the request ends, matches the relational shape of the data. |
| Processing | One pure module (`lib/clean.ts`) | Pure functions → unit-testable without a server or DB. |

**Why not Cloudflare Workers?** Their free plan caps CPU at 10 ms per request. Cleaning the 30-day file takes ~150 ms of CPU, so it would be killed. Vercel's free functions allow far more.

**Request flow.** `POST /api/upload` receives the raw CSV, cleans it, and writes the upload row + all checks in **one transaction** (all or nothing). Re-uploading byte-identical content returns the existing dataset (content hash), so double-clicks don't duplicate data. `GET /api/stats` and `GET /api/logs` read from Postgres, so the dashboard works any time after the upload.

**Schema** (`lib/db.ts`, created automatically on first request): `uploads` (summary JSON of what was cleaned), `checks` (one row per service per 15-min slot, PK `(upload_id, service_id, ts)`), `rejected_rows` (unusable raw rows + reason).

**API**
- `POST /api/upload` — body = CSV text, optional `x-filename` header
- `GET /api/uploads` — list datasets
- `GET /api/stats?upload=<id>[&date=YYYY-MM-DD | &from=…&to=…]`
- `GET /api/logs?upload=<id>[&date | &from&to][&service][&outcome][&page][&pageSize]`

## 2. Data findings

All five sample files (9, 12, 14, 21, 30 days) have the same classes of problems. Counts are per file and come from the pipeline's own summary (shown on the upload result and in the dashboard's "Data quality" panel).

| File | Rows | Checks stored | Duplicate rows merged | Timestamps not in `…Z` form | Latency s→ms | Latency blank | Invalid status |
|---|---:|---:|---:|---:|---:|---:|---:|
| 9d  | 4,672  | 4,320  | 352   | 102 | 924   | 56  | 1 |
| 12d | 6,230  | 5,760  | 470   | 136 | 1,229 | 74  | 1 |
| 14d | 7,269  | 6,720  | 549   | 159 | 1,435 | 87  | 1 |
| 21d | 10,904 | 10,080 | 824   | 239 | 2,151 | 130 | 1 |
| 30d | 15,577 | 14,400 | 1,177 | 342 | 3,095 | 186 | 1 |

"Checks stored" = 5 services × days × 96, i.e. exactly one check per service per 15-minute slot, no gaps.

1. **Three timestamp formats** – ISO UTC (`…Z`), epoch seconds, and ISO with a `+05:30` offset. Everything is converted to UTC. This must happen *before* de-duplication: the same instant shows up in different formats. Sanity check: after normalising, every service has exactly the expected number of slots; reading `+05:30` as UTC would have broken that.
2. **Duplicate rows** – (a) a second agent (`agent-2`) reports the same slot with slightly different latency (it never reports a slot `agent-1` didn't), and (b) exact repeated `agent-1` rows. One row per (service, timestamp) is kept: valid status first → if two valid rows disagree, the **failure wins** → row with a latency → lowest agent id. This matters: counting duplicates would inflate the check count and distort availability.
3. **Mixed latency units** – `search-api` reports in **seconds**, everything else in ms. Normalised to ms (float noise removed). After conversion its range (~345–765 ms) is in line with its peers.
4. **Blank latency** (~1.2% of rows) – the check itself is valid (it has a status), so the row is kept with `latency = NULL`. Not imputed; excluded from percentiles.
5. **Negative latency** (one row per file, e.g. −286) – physically impossible → `NULL`, check kept.
6. **Impossible status code `999`** (one row per file) – not a valid HTTP code, so we don't know whether the service was up. It is stored as outcome `unknown` and **excluded from availability** (neither credited nor penalised). In the 14-day file the 999 row has an `agent-2` twin reporting 200 for the same slot; the valid twin wins.
7. **Latency spikes** (e.g. 2,865 ms on `reports-api` vs a ~650 ms norm) – kept. They may be real slowness, availability isn't latency-based, and they show up in p95/max.
8. **Checked and clean:** no whitespace/casing variants, one region (`ap-south-1`), consistent `service_id` ↔ `service_name`, all timestamps on the 15-min grid, no missing slots after de-duplication. The pipeline still detects and reports all of these cases (gaps, off-grid timestamps, bad rows → `rejected_rows`) so a different file isn't silently mis-processed.
9. **Date ranges differ** (9–30 days, not aligned to months) – nothing is hard-coded; the range is derived from the data.

## 3. Assumptions & stat choices

- **Availability = up ÷ (up + down)**, where *down* = HTTP 5xx and *up* = anything else valid (4xx is a client error, not an outage). `unknown` checks and missing slots are excluded from the denominator.
- **Each check represents its 15-minute window**, so downtime = failed checks × 15 min.
- **SLA target 99.9% per calendar month (UTC).** The threshold is compared with integer arithmetic (`up×1000 ≥ counted×999`) to avoid float edge cases. Partial months are labelled with their data coverage – the credit decision needs a full month.
- **UTC everywhere** (dates in filters, timestamps in logs) so results don't depend on the viewer's timezone.
- **Stats follow the period filter** (whole dataset / single date / range) so stats and logs always describe the same data.
- **Stats chosen for someone on-call or in billing:** fleet availability + services breaching SLA (billing: who owes credits?); per-service availability, downtime, **error-budget remaining** (how close to a breach), incident count and longest outage, p50/p95/max latency; a daily availability strip (when did it go wrong?); longest incidents = runs of consecutive failed checks (what to investigate); monthly SLA table; status-code mix; and the data-quality panel (can I trust these numbers?).
- Each upload is its own dataset (a dropdown selects it); uploads are not merged with each other.
- Out of scope per the brief: auth, multi-tenancy, CI.

## 4. Run, test, deploy

**Local** (Node ≥ 20) – no database setup needed; it uses an embedded Postgres (PGlite) stored in `.data/`:
```bash
npm install
npm run dev          # http://localhost:3000  (sample CSVs are in ./data)
npm test             # unit + API integration tests
npm run typecheck
```
To use a real Postgres locally: `DATABASE_URL=postgres://… npm run dev`.

**Deploy (free, no card)**
1. **Neon** → create a project → copy the connection string (`postgresql://…?sslmode=require`).
2. Push this repo to GitHub.
3. **Vercel** → *Add New → Project* → import the repo → *Environment Variables*: `DATABASE_URL` = the Neon string → *Deploy*. (Framework: Other; no build command. `vercel.json` already sets the output directory.)
4. Open the URL → *Upload CSV* → pick a file from `data/`.

Redeploy on demand: push to `main` (Vercel auto-deploys) or click *Redeploy*. If the Neon project is suspended, the first request wakes it (a few seconds).

## 5. What I'd do with more time

- **Large files:** Vercel caps request bodies at ~4.5 MB. For real volumes: upload straight to object storage, then process in chunks / via a queue.
- **Configurable SLA** (target, credit tiers, per-service targets) and a proper billing-credit calculation per month.
- **Merge uploads** into one continuous timeline per service (with overlap handling) instead of one dataset per upload.
- **Browser tests** (Playwright) for the UI; currently the API is integration-tested and the UI was smoke-tested in jsdom.
- **Rollup tables** for stats instead of computing on read; fine at 15k rows, not at 15M.
- A timezone toggle for display, deletion of uploads, alerting on breach risk, and authentication.
