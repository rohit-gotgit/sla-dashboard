<div align="center">

# SLA Monitoring Dashboard

**Turn raw, messy health-check logs into trustworthy SLA numbers.**

Upload a CSV → a serverless function cleans and validates it → cleaned checks are stored in Postgres → a single-screen dashboard shows SLA stats and the underlying logs.

[**Live demo**](https://sla-dashboard-nu.vercel.app) · [Upload screen](https://sla-dashboard-nu.vercel.app/upload.html) · [Data findings](#data-findings) · [Run locally](#getting-started)

![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node-%E2%89%A5%2020-339933?logo=node.js&logoColor=white)
![Postgres](https://img.shields.io/badge/Postgres-Neon-4169E1?logo=postgresql&logoColor=white)
![Vercel](https://img.shields.io/badge/Deployed%20on-Vercel-000000?logo=vercel&logoColor=white)
![Tests](https://img.shields.io/badge/tests-26%20passing-2EA44F)

</div>

---

## Table of contents

- [Overview](#overview)
- [Live deployment](#live-deployment)
- [Features](#features)
- [Architecture](#architecture)
- [Data findings](#data-findings)
- [Assumptions and stat choices](#assumptions-and-stat-choices)
- [API reference](#api-reference)
- [Project structure](#project-structure)
- [Getting started](#getting-started)
- [Testing and verification](#testing-and-verification)
- [Deployment](#deployment)
- [Limitations and future work](#limitations-and-future-work)

## Overview

Cloud providers offer SLAs such as *"if a service's monthly availability drops below 99.9%, the customer gets a billing credit."* That credit is computed automatically from monitoring data, so the pipeline that turns raw logs into numbers has to be trustworthy, and someone (an engineer, a support team) needs a place to look at what happened.

This project provides that pipeline and that place. It ingests multi-agent, multi-day health-check logs for five services (one check every 15 minutes per service), finds and fixes the data-quality problems in them, persists the cleaned result, and presents it on one screen: collapsible SLA stats on top, a filterable log view below.

## Live deployment

| | |
|---|---|
| **Live app** | https://sla-dashboard-nu.vercel.app |
| **Upload screen** | https://sla-dashboard-nu.vercel.app/upload.html |
| **Dashboard** | https://sla-dashboard-nu.vercel.app/ |
| **Last verified live** | 2026-11-17 |

Hosted entirely on free tiers: Vercel (UI and serverless functions) and Neon (Postgres). Sample CSVs to try are in [`data/`](data).

## Features

- **Upload UI:** drag-and-drop or file picker; shows a data-quality summary of what the pipeline fixed.
- **Stateless serverless processing:** parse, validate, clean and de-duplicate in a cloud function that holds no state between invocations.
- **Durable storage:** cleaned data is saved to Postgres in a single transaction and can be re-queried at any time after the upload.
- **Idempotent uploads:** re-uploading byte-identical content returns the existing dataset instead of creating duplicates.
- **Single-screen dashboard:**
  - Collapsible stats section: fleet availability, services breaching SLA, per-service availability, downtime, error budget, incidents, latency percentiles, daily availability strip, monthly SLA table, status-code mix and a data-quality panel.
  - Filterable logs: single date or date range, plus service and outcome filters, with pagination.
- **Period filter drives both halves:** stats and logs always describe the same data.
- **Multiple datasets:** each upload is its own dataset, selectable from a dropdown.

## Architecture

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

### Components

| Piece | Choice | Why |
|---|---|---|
| UI | Static HTML + vanilla JS (`public/`) | No build step, nothing to break; two pages: upload and dashboard. |
| Stateless function | **Vercel Functions** (Node/TypeScript; run on AWS Lambda) | Real cloud serverless, free Hobby tier, no credit card, deploy by importing the GitHub repo. |
| Database | **Neon Postgres** (free tier) | No card, real SQL, re-queryable after the request ends, matches the relational shape of the data. |
| Processing | One pure module (`lib/clean.ts`) | Pure functions → unit-testable without a server or DB. |

**Why not Cloudflare Workers?** Their free plan caps CPU at 10 ms per request. Cleaning the 30-day file takes ~150 ms of CPU, so it would be killed. Vercel's free functions allow far more.

### Request flow

`POST /api/upload` receives the raw CSV, cleans it, and writes the upload row and all checks in **one transaction** (all or nothing). Re-uploading byte-identical content returns the existing dataset (content hash), so double-clicks don't duplicate data. `GET /api/stats` and `GET /api/logs` read from Postgres, so the dashboard works any time after the upload.

### Schema

Defined in `lib/db.ts` and created automatically on first request.

| Table | Purpose |
|---|---|
| `uploads` | One row per upload, with a summary JSON of what was cleaned. |
| `checks` | One row per service per 15-minute slot; primary key `(upload_id, service_id, ts)`. |
| `rejected_rows` | Unusable raw rows and the reason each was rejected. |

## Data findings

All five sample files (9, 12, 14, 21 and 30 days) have the same classes of problems. Counts are per file and come from the pipeline's own summary, shown on the upload result and in the dashboard's "Data quality" panel.

| File | Rows | Checks stored | Duplicate rows merged | Timestamps not in `…Z` form | Latency s→ms | Latency blank | Invalid status |
|---|---:|---:|---:|---:|---:|---:|---:|
| 9d  | 4,672  | 4,320  | 352   | 102 | 924   | 56  | 1 |
| 12d | 6,230  | 5,760  | 470   | 136 | 1,229 | 74  | 1 |
| 14d | 7,269  | 6,720  | 549   | 159 | 1,435 | 87  | 1 |
| 21d | 10,904 | 10,080 | 824   | 239 | 2,151 | 130 | 1 |
| 30d | 15,577 | 14,400 | 1,177 | 342 | 3,095 | 186 | 1 |

"Checks stored" = 5 services × days × 96, i.e. exactly one check per service per 15-minute slot, with no gaps.

### Issues found and how each is handled

1. **Three timestamp formats.** ISO UTC (`…Z`), epoch seconds, and ISO with a `+05:30` offset. Everything is converted to UTC. This must happen *before* de-duplication, because the same instant appears in different formats. Sanity check: after normalising, every service has exactly the expected number of slots; reading `+05:30` as UTC would have broken that.
2. **Duplicate rows.**
   - A second agent (`agent-2`) reports the same slot with slightly different latency (it never reports a slot `agent-1` didn't).
   - Exact repeated `agent-1` rows.

   One row per (service, timestamp) is kept: valid status first → if two valid rows disagree, the **failure wins** → row with a latency → lowest agent id. This matters because counting duplicates would inflate the check count and distort availability.
3. **Mixed latency units.** `search-api` reports in **seconds**; everything else is in ms. Normalised to ms (float noise removed). After conversion its range (~345–765 ms) is in line with its peers.
4. **Blank latency** (~1.2% of rows). The check itself is valid (it has a status), so the row is kept with `latency = NULL`. Not imputed; excluded from percentiles.
5. **Negative latency** (one row per file, e.g. −286). Physically impossible, so it is stored as `NULL` and the check is kept.
6. **Impossible status code `999`** (one row per file). Not a valid HTTP code, so we don't know whether the service was up. It is stored as outcome `unknown` and **excluded from availability** (neither credited nor penalised). In the 14-day file the 999 row has an `agent-2` twin reporting 200 for the same slot; the valid twin wins.
7. **Latency spikes** (e.g. 2,865 ms on `reports-api` vs a ~650 ms norm). Kept. They may be real slowness, availability isn't latency-based, and they show up in p95/max.
8. **Checked and clean.** No whitespace or casing variants, one region (`ap-south-1`), consistent `service_id` ↔ `service_name`, all timestamps on the 15-minute grid, and no missing slots after de-duplication. The pipeline still detects and reports all of these cases (gaps, off-grid timestamps, bad rows → `rejected_rows`), so a different file isn't silently mis-processed.
9. **Date ranges differ** (9–30 days, not aligned to months). Nothing is hard-coded; the range is derived from the data.

## Assumptions and stat choices

### Assumptions

- **Availability = up ÷ (up + down)**, where *down* = HTTP 5xx and *up* = anything else valid (4xx is a client error, not an outage). `unknown` checks and missing slots are excluded from the denominator.
- **Each check represents its 15-minute window**, so downtime = failed checks × 15 min.
- **SLA target is 99.9% per calendar month (UTC).** The threshold is compared with integer arithmetic (`up×1000 ≥ counted×999`) to avoid float edge cases. Partial months are labelled with their data coverage, since the credit decision needs a full month.
- **UTC everywhere** (dates in filters, timestamps in logs), so results don't depend on the viewer's timezone.
- **Stats follow the period filter** (whole dataset / single date / range), so stats and logs always describe the same data.
- **Each upload is its own dataset**, selected via a dropdown; uploads are not merged with each other.
- **Out of scope:** authentication, multi-tenancy, CI.

### Why these stats

Chosen for someone on-call or in billing:

| Stat | Question it answers |
|---|---|
| Fleet availability and services breaching SLA | Billing: who owes credits? |
| Per-service availability, downtime, incident count, longest outage, p50/p95/max latency | How is each service performing? |
| **Error-budget remaining** | How close is each service to a breach? |
| Daily availability strip | When did it go wrong? |
| Longest incidents (runs of consecutive failed checks) | What should I investigate? |
| Monthly SLA table | Which services meet the SLA each calendar month? |
| Status-code mix | What kinds of failures are occurring? |
| Data-quality panel | Can I trust these numbers? |

## API reference

| Endpoint | Description |
|---|---|
| `POST /api/upload` | Body = CSV text; optional `x-filename` header. Returns `201` for a new dataset, `200` if identical content was already uploaded. |
| `GET /api/uploads` | List datasets. |
| `GET /api/stats?upload=<id>[&date=YYYY-MM-DD \| &from=…&to=…]` | SLA stats, optionally scoped to a date or range. |
| `GET /api/logs?upload=<id>[&date \| &from&to][&service][&outcome][&page][&pageSize]` | Paginated check records with filters. |

Dates are UTC days (`YYYY-MM-DD`). Use `date` **or** `from`/`to`, not both. `outcome` is one of `up`, `down`, `unknown`. Errors return JSON `{ "error": "…" }` with an appropriate status (400 invalid input, 404 unknown upload, 405 wrong method, 413 file over 4 MB, 422 unusable CSV).

Example:

```bash
curl -X POST -H "Content-Type: text/plain" -H "x-filename: sample.csv" \
  --data-binary @data/monitoring_checks_9d_seed101.csv \
  https://sla-dashboard-nu.vercel.app/api/upload
```

## Project structure

```
.
├── api/                  Serverless functions (one file per endpoint)
│   ├── upload.ts         POST: validate, clean, persist
│   ├── uploads.ts        GET: list datasets
│   ├── stats.ts          GET: SLA stats for a dataset / period
│   └── logs.ts           GET: filtered, paginated check records
├── lib/
│   ├── clean.ts          Pure cleaning pipeline (timestamps, units, dedupe, validation)
│   ├── csv.ts            RFC-4180 CSV parser
│   ├── stats.ts          Availability, error budget, incidents, percentiles, monthly SLA
│   ├── db.ts             Postgres schema, transactional save, queries
│   ├── http.ts           Request helpers, validation, error handling
│   ├── pglite-adapter.ts Embedded Postgres adapter for local dev and tests
│   └── types.ts          Shared types
├── public/               Static UI (upload page + dashboard)
├── scripts/              Local dev server, sample verification, commit-history helper
├── test/                 Unit and API integration tests
├── data/                 Sample CSVs (9, 12, 14, 21 and 30 days)
└── vercel.json           Output directory and function settings
```

## Getting started

Requires **Node ≥ 20**. No database setup is needed locally; it uses an embedded Postgres (PGlite) stored in `.data/`.

```bash
npm install
npm run dev          # http://localhost:3000  (sample CSVs are in ./data)
npm test             # unit + API integration tests
npm run typecheck
```

To use a real Postgres locally:

```bash
DATABASE_URL=postgres://… npm run dev
```

Copy `.env.example` to `.env` to see the expected variable.

## Testing and verification

- **26 automated tests** (Vitest): unit tests for timestamp, latency and status parsing, de-duplication and stats maths (including the exact 99.9% threshold), plus API integration tests covering upload, idempotency, filtering, validation and error responses.
- **Both database drivers exercised:** the integration suite passes on the embedded Postgres (PGlite) and on a real Postgres through the production `pg` driver.
- **Independent cross-check:** cleaned counts and per-service availability for all five sample CSVs were compared against a separate pandas implementation and match exactly.
- **UI:** smoke-tested in jsdom (load, collapse/expand, single date, range, invalid range, filters, pagination); no JS errors.

## Deployment

Free, no card required.

1. **Neon:** create a project and copy the connection string (`postgresql://…?sslmode=require`).
2. Push this repo to GitHub.
3. **Vercel:** *Add New → Project* → import the repo → *Environment Variables*: `DATABASE_URL` = the Neon string → *Deploy*. (Framework: Other; no build command. `vercel.json` already sets the output directory.)
4. Open the URL → *Upload CSV* → pick a file from `data/`.

**Redeploy:** push to `main` (Vercel auto-deploys) or click *Redeploy*. If the Neon project is suspended, the first request wakes it (a few seconds).

## Limitations and future work

- **Large files:** Vercel caps request bodies at ~4.5 MB. For real volumes: upload straight to object storage, then process in chunks or via a queue.
- **Configurable SLA:** target, credit tiers and per-service targets, plus a proper billing-credit calculation per month.
- **Merge uploads** into one continuous timeline per service (with overlap handling) instead of one dataset per upload.
- **Browser tests** (Playwright) for the UI; currently the API is integration-tested and the UI was smoke-tested in jsdom.
- **Rollup tables** for stats instead of computing on read; fine at 15k rows, not at 15M.
- **Further extras:** a timezone toggle for display, deletion of uploads, alerting on breach risk, and authentication.
