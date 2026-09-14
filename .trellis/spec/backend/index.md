# Backend Guidelines

## Pre-Development Checklist

For source collection, raw archives, catalog imports or database explorer changes, read [Source Archive Contract](./source-archive.md) and the current task artifacts. Preserve unrelated local data and changes.

## Quality Check

Run focused importer/crawler tests, `pnpm test`, `pnpm exec tsc --noEmit` and `pnpm lint`. Source apply requires a dry-run and JSON reconciliation inside the transaction. Verify idempotence against PostgreSQL. When serving code changes, build, restart only the Schoolpath process and smoke the source tables through the running API.
