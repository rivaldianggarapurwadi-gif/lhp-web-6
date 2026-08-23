#!/usr/bin/env bash
# One command: bring up Postgres, Redis and two API instances, then run the
# suite from the host against them.
set -euo pipefail

cleanup() { docker compose down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> building and starting the cluster"
docker compose up -d --build api-1 api-2

echo "==> waiting for both instances"
for port in 3001 3002; do
  for _ in $(seq 1 60); do
    curl -sf "http://localhost:$port/health" >/dev/null && break
    sleep 1
  done
  curl -sf "http://localhost:$port/health" >/dev/null \
    || { echo "api on $port never came up"; docker compose logs; exit 1; }
done

echo "==> running the end-to-end suite"
npm install --silent
npx tsc -p tsconfig.json
DATABASE_URL="postgres://ceko:ceko@localhost:5432/ceko" \
JWT_SECRET="e2e-secret" \
API_1="http://localhost:3001" \
API_2="http://localhost:3002" \
  node --test dist/test/e2e.test.js

echo "==> running the REST suite"
# REST doesn't exercise cross-instance fan-out, so one instance is enough --
# api-1, already up from the cluster above.
DATABASE_URL="postgres://ceko:ceko@localhost:5432/ceko" \
JWT_SECRET="e2e-secret" \
API_1="http://localhost:3001" \
  node --test dist/test/rest.test.js
