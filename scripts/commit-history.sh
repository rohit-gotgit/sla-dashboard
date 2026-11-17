#!/usr/bin/env bash
# Creates a readable, step-by-step git history using YOUR git identity.
# Usage:  bash scripts/commit-history.sh   (run once, in a fresh checkout with no .git)
set -euo pipefail
[ -d .git ] && { echo ".git already exists - skipping"; exit 0; }
git init -q -b main
c() { msg="$1"; shift; git add -- "$@"; git commit -q -m "$msg"; echo "committed: $msg"; }
c "chore: scaffold TypeScript project, tooling and sample data"  package.json package-lock.json tsconfig.json .gitignore .env.example vercel.json data
c "feat(core): CSV parser and shared types"                      lib/csv.ts lib/types.ts
c "feat(core): cleaning pipeline (timestamps, units, dedupe, validation)" lib/clean.ts
c "test(core): unit tests for parsing and cleaning"             test/clean.test.ts
c "feat(core): SLA stats (availability, error budget, incidents, monthly)" lib/stats.ts
c "test(core): unit tests for stats"                            test/stats.test.ts
c "feat(db): Postgres schema, transactional save and queries"   lib/db.ts lib/pglite-adapter.ts
c "feat(api): upload, uploads, stats and logs serverless functions" lib/http.ts api
c "test(api): end-to-end API tests on embedded Postgres"        test/integration.test.ts
c "feat(dev): local dev server and sample verification script"  scripts/dev-server.ts scripts/verify-samples.ts
c "feat(ui): upload screen"                                     public/upload.html public/upload.js
c "feat(ui): dashboard with collapsible stats and filterable logs" public/index.html public/app.js public/common.js public/styles.css
c "docs: README with architecture, data findings and assumptions" README.md scripts/commit-history.sh
git status --short
