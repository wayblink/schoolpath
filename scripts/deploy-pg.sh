#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Starting PostgreSQL..."
docker compose up -d postgres

echo "Initializing PostgreSQL schema if needed..."
if docker compose exec -T postgres psql -U house -d house -Atqc "SELECT to_regclass('public.schools')" | grep -q '^schools$'; then
  echo "Schema already exists; skipping pnpm db:pg:init."
else
  pnpm db:pg:init
fi

school_count="$(docker compose exec -T postgres psql -U house -d house -Atqc "SELECT count(*) FROM schools")"
if [ "$school_count" = "0" ]; then
  echo "Target is empty; importing historical SQLite data in readonly mode..."
  pnpm db:pg:import-sqlite
else
  echo "Target already has schools=${school_count}; skipping historical import."
fi

echo "Core table counts:"
docker compose exec -T postgres psql -U house -d house -c "
SELECT 'counts' AS label,
  (SELECT count(*) FROM schools) AS schools,
  (SELECT count(*) FROM communities) AS communities,
  (SELECT count(*) FROM school_communities) AS school_communities,
  (SELECT count(*) FROM district_boundaries) AS district_boundaries,
  (SELECT count(*) FROM policies) AS policies;
"

echo "Checking foreign keys for cascade delete..."
cascade_count="$(docker compose exec -T postgres psql -U house -d house -Atqc "
SELECT count(*)
FROM pg_constraint
WHERE contype = 'f' AND confdeltype = 'c';
")"
if [ "$cascade_count" != "0" ]; then
  echo "Refusing to continue: found ${cascade_count} cascade-delete foreign key(s)." >&2
  exit 1
fi

echo "Starting app..."
docker compose up -d app

echo "Done."
docker compose ps
