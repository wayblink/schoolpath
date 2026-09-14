# Source Archive Contract

## 1. Scope / Trigger

Applies to full collection from `https://xuequzhushou.cn/`, ingest/catalog import commands, and `/db` source visibility. Source archives preserve whole documents outside the nine product districts; product queries and coverage retain the existing nine-district filter. Never delete other districts or present third-party statements as official evidence.

The same source-layer contract applies to the bounded official search-index collector at `https://search.sh.gov.cn/search`. Its `official_search_index` source rows may target multiple government sites; the index being official does not make every target page a verified school or catchment fact.

## 2. Signatures

```bash
pnpm data:collect:xuequzhushou --timeout-ms 180000
pnpm data:import:xuequzhushou-site --manifest=<manifest.json> [--apply]
pnpm data:import:xuequzhushou-homepage --snapshot=<homepage-file> [--fetched-at=<ISO>] [--apply]
```

`collectXuequzhushouSite(options)` owns discovery and `SiteManifest` in `lib/ingest/xuequzhushou-site.ts`. `siteRecords(url, data)` owns typed JSON projections. `importXuequzhushouSite(manifestPath, {client, apply})` writes full-site records; `buildXuequzhushouImport` and `importXuequzhushou` own homepage catalogs.

Database ownership: `ingest.sources` registers `source_key=xuequzhushou`, `ingest.crawl_runs` identifies content, and `ingest.extracted_records` stores `(crawl_run_id, record_type, source_key, district, raw)`. `catalog.source_schools` preserves source facts and `catalog.school_district_relations` holds provisional committee relations. `public.schools` is not an import target.

Read endpoints: `GET /api/db/tables`, `GET /api/db/table?schema=ingest&name=extracted_records`, `GET /api/db/rows?schema=ingest&name=extracted_records&page=1&pageSize=5`. Use `filters={"record_type":"map_community"}` as a URL-encoded JSON parameter to inspect community records. `/db` is the UI entry.

The Shanghai government search importer uses `source_key=shgov-search`, `source_kind=official_search_index`, and parser namespace `shgov_search_v1`. It writes only `ingest.sources`, `ingest.crawl_runs`, and `ingest.extracted_records`; it never publishes catalog or public school facts. Stable occurrence identity is `keyword + page + result index`, and repeated result names/tokens remain separate records.

## 3. Contracts

- Local commands load `DATABASE_URL` through `scripts/load-env.ts`; never print it. Default import transactions are read-only. `--apply` requires existing user authorization and an inspected dry-run, then writes under a transaction and advisory lock.
- Version 1 manifests contain source, run ID, timestamps, limits, complete flag, and resource URLs, status, content type, raw relative file, byte length, SHA256, discovery parents and errors. Files cannot escape the snapshot directory. Successful runs use the exact response SHA256 as content identity; failures use metadata identity.
- Discovery follows same-origin static HTML/JS/CSS references and JSON filenames. It does not execute remote scripts or crawl external property listings/maps. Website-provided external URLs remain in source JSON.
- Discovery must classify generated external-link templates by URL origin before enqueueing them. For example, `buildLianjiaAddrUrl(addr)` may produce a path-shaped string such as `/addr`; that value is not a Schoolpath same-origin resource and must not become a fetched or unavailable source row.
- Homepage source keys use `full:v1:`. Full-site record types use `xuequzhushou_site_v1:`. Namespaces can coexist in one content run. Preserve resource URL and JSON pointer/index identities: the same community under two schools is two source occurrences.
- Whole resource bodies and whole JSON documents are retained even when typed projections do not recognize future fields. Map `g` can be a string or an object containing `p` addresses and `r` roads. Static JS literal objects include `MS_TIER`; executable/computed values stay in the raw resource and appear as parse issues.
- Homepage imports only supplement missing source attrs and add absent source schools/relations. Existing source facts, attrs, mappings, accepted review states and canonical schools remain unchanged. New relations are `provisional`, `verified=false`, and have no inferred canonical community. Match schools only by unique exact name/alias within district and stage.
- Reconcile every expected raw record's key, district and JSON before commit. Homepage imports additionally verify existing source rows and a before/after SHA256 over canonical schools. Repeat apply must add zero rows and change zero attrs.

## 4. Validation & Error Matrix

| Condition | Behavior |
| --- | --- |
| HTTP 404 | Archive response and error; collector exit 2; report unavailable URL |
| Discovered link is a generated external URL or false-positive path-shaped URL | Exclude from same-origin traversal; do not report it as an unavailable site resource |
| Body timeout/byte limit | Mark partial; preserve downloaded bytes; exclude from data parsing; retry a new run |
| Resource/request limit | Record discovered-but-unfetched resources; never claim complete |
| Hash or byte count mismatch | Reject before database mutation |
| Missing raw file for success | Reject rather than import an empty success |
| Changed immutable record | Roll back the batch |
| Missing/altered stored JSON | Roll back before commit |
| Existing catalog mapping conflict | Preserve existing mapping and report conflict; retain all raw source data |
| Generic source-table edit in `/db` | Reject via `assertWritable`; source tables are browsable |

## 5. Good/Base/Bad Cases

- Good: download both HTML pages and their six reachable JSON files; list two persistent 404s; apply all complete source rows; verify a second apply adds zero. Report eight-district school data separately from all-Shanghai geometry.
- Base: run the collector and a read-only import plan; source files exist but the database has not yet changed.
- Bad: import only `ALL_DATA` and describe it as the entire site; deduplicate communities by name; treat archived geometry as confirmed catchment boundaries; claim nine-district coverage merely because nine districts are configured.

## 6. Tests Required

- `tests/xuequzhushou-site.test.ts`: static discovery, external URL exclusion, Chinese redirects, JS literal parsing without execution, timeout/byte/request limits and explicit failures.
- `tests/xuequzhushou-site-records.test.ts`: duplicate occurrences, future fields, mixed `g`, out-of-scope geometry and empty/index documents.
- Homepage importer tests: default read-only, exact district/stage match, duplicate names, accepted-state preservation, rollback after reconciliation failure and canonical digest change.
- Site importer tests: content tampering rejected, same-content URL provenance retained, parser namespaces coexist, repeat apply idempotent, late failure rolls back writes.
- `tests/source-archive-explorer.test.ts`: browse source schemas and reject generic writes. After deployment, read actual map records using `/api/db/rows` and verify `/db` renders the source table.

## 7. Wrong vs Correct

Wrong: use `schoolName + communityName` as raw identity, merge repeated entries and report the resulting count as total source coverage.

Correct: retain the whole JSON and a URL/document/pointer key such as `/districts/黄浦区/0/c/0`, reconcile all occurrences, and only merge identities in a separately reviewed canonical projection.
