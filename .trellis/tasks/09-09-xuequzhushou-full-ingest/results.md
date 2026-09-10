# Full Source Import Results

## Acquisition

Captured `https://xuequzhushou.cn/` on 2026-09-09, from 12:04:10 to 12:05:26 UTC (20:04:10 to 20:05:26 Shanghai time).

Snapshot: `data/ingest/xuequzhushou-site/2026-09-09T12-04-10-070Z-a6cc3148/manifest.json`.

- Traversed 10 same-origin static page/data references: 8 complete successes, 2 HTTP 404s.
- Success bodies total 11,968,363 bytes; 11,968,521 bytes including archived error bodies.
- Successful resources: homepage, map HTML, committee GeoJSON, school/community map JSON, ring GeoJSON, school/committee index, committee/GeoJSON index and school/street mapping.
- Parsed 31 complete JSON/static literal documents, including homepage globals and map `MS_TIER`. No parse issues on the successful resources.
- Initial short-timeout runs contain partial files and are diagnostic only. The selected final snapshot has no partial responses.
- `/addr` was a discovery false positive from `buildLianjiaAddrUrl(addr)`, fixed with a regression test. It is not an unavailable source dataset.
- Additional conventional discovery probes `/robots.txt` and `/sitemap.xml` both returned 404; they exposed no additional links and are not part of the 10 referenced resources.

Unavailable referenced files:

1. `https://xuequzhushou.cn/学区数据/district_config.json` (404).
2. `https://xuequzhushou.cn/学区数据/初中梯队_cleaned.json?v=20260624m` (404).

The complete claim is bounded to discovered same-origin static resources. External property and map-service URLs are preserved as source fields; their external sites were not crawled. Unlinked/private data cannot be proved absent.

## Database Reconciliation

New records this task: **34,411**, comprising 3,610 homepage records and 30,801 full-site records. Total `ingest.extracted_records` after import: **37,638**, including 3,227 older records. These totals include documents, indexes and error records, not unique schools or communities.

| Full-site record type | Count |
| --- | ---: |
| site_resource | 10 |
| site_json | 31 |
| map_index_entry | 1,471 |
| map_index_member | 2,691 |
| committee_geometry | 7,255 |
| map_district | 8 |
| map_school | 320 |
| map_community | 14,536 |
| map_enrollment_area | 3,450 |
| map_feeder | 320 |
| map_address_group | 80 |
| map_address | 400 |
| map_road | 48 |
| map_middle | 178 |
| ring_geometry | 3 |

Full-site database record types have prefix `xuequzhushou_site_v1:`. Each community occurrence retains its school/document path and all source fields, including available address, coordinates, property URL, year and type.

Homepage records include 455 schools (264 primary, 191 middle), 2,764 committee links, 264 feeder links, 61 streets, 8 district records, 53 committee overlaps and complete document/config payloads. Homepage and map schools overlap and must not be summed as unique schools.

Existing 455 catalog source schools received missing original `rawSchool` attrs. Existing 2,764 source committee relations were reused. Eleven mapping conflicts were reported and the prior mappings preserved. Source statements remain third-party; no new canonical school/community facts were published.

Canonical `public.schools` SHA256 before homepage apply and after both full imports:

`dd7e3bf190757c89c352af9b1136c145414e1fa82d3db36ff0e7b91d8e31be78`

Both importers reconciled every expected record before committing. Second homepage apply: 0 additions, 0 attr updates; second site apply: 0 additions, 30,801 unchanged, 30,801 reconciled, 0 conflicts.

Evidence within the snapshot directory:

- `homepage-apply.json`, `homepage-repeat.json`, `homepage-final-audit.json`.
- `import-19da3610-9998-4cf9-b724-1a2641b7455e/report.json`: final site dry-run.
- `import-987e7fab-6a1b-45ec-9d83-ba3554999a2d/report.json`: site apply.
- `import-2dc79819-4728-45f0-86f7-06beef953eb1/report.json`: repeated apply.

## District Scope

| District | Map school occurrences | Community occurrences |
| --- | ---: | ---: |
| 黄浦 | 26 | 1,553 |
| 徐汇 | 39 | 3,048 |
| 虹口 | 27 | 1,664 |
| 静安 | 44 | 817 |
| 长宁 | 26 | 807 |
| 杨浦 | 47 | 582 |
| 浦东 | 67 | 4,352 |
| 闵行 | 44 | 1,713 |
| 普陀 | 0 | 0 |

The source school/community datasets omit Putuo. GeoJSON has 7,255 features across all 16 Shanghai districts, including 4,529 in the nine product districts and 319 in Putuo. All source geometry is retained. This is source availability, not a verified catchment coverage percentage.

## Verification

- Full suite: 260 tests passed, 0 failed. Site importer tests include a demonstrated failing error-report regression before the fix; transaction rollback tests use an injected client. Actual PostgreSQL first/second apply and full JSON comparison provide live integration evidence.
- TypeScript passed. Full ESLint: 0 errors, 21 existing warnings; final changed-file lint passed.
- Production build passed; House was restarted and `/api/db/tables` returned the ingest/catalog tables.
- Live `/api/db/rows` filtered by `map_community` returned exactly 14,536 rows, with complete sample source fields.
- Final production build passed; the running standalone House process is PID 35506 at `http://localhost:3000`. Only verified House PIDs were stopped.
- Browser `/db` opened `ingest.extracted_records`, rendered data without page errors, showed the source read-only caption and hid source editing commands. Filtering `record_type` by `map_community` displayed exactly 14,536 rows.
- Desktop evidence: `browser-desktop.png` inside the snapshot. At a 390px mobile viewport the existing database console overflows to 841px (`browser-mobile.png`); this task does not claim responsive mobile console acceptance. Desktop inspection is the supported verified path for this batch.

## Repeat Workflow

Use the repository `house-data-optimizer` Skill. Run full-site collection, inspect failures, dry-run both importers, apply with existing authorization, then repeat and reconcile. The Skill does not run as a background scheduler; each invocation is an explicit optimization iteration.

## Reviewer Recheck (2026-09-10)

- The repository-wide suite currently contains 262 passing tests (the earlier 260-test count above predates two later regression tests); `pnpm test` passed 262/262 against the verified House service at `http://127.0.0.1:3001`.
- `pnpm exec tsc --noEmit --incremental false`, `pnpm lint` (0 errors, 21 pre-existing warnings), and `pnpm build` passed.
- The selected site manifest has 10 resources: 8 successful responses and the same two explicit HTTP 404s listed above. Every archived resource with a body matched its manifest SHA256 and byte count.
- Live `GET /api/db/rows` with `record_type=xuequzhushou_site_v1:map_community` returned `totalRows=14,536`; `/db` returned HTTP 200 and rendered the database console.

## Shanghai Government Search Addendum (2026-09-10)

Implemented and verified the bounded `search.sh.gov.cn` source-layer collector/importer. The real session protocol is POST `/search`, followed by POST `/searchResult` with the session cookie and the documented form fields. A live smoke used keyword `学校`, `pageSize=5`, `maxPages=1`, and `delayMs=0` only: the snapshot is `data/ingest/shgov-search/2026-09-10T08-36-32-726Z-381ca882/manifest.json`, with 2 successful HTML resources (bootstrap plus one result page), 10 result occurrences, no failures, and `complete=false` because the reported total exceeded the explicit page limit. This is intentionally not a full-search claim.

The dry-run planned 12 ingest records (2 resource records and 10 result occurrences). An authorized source-layer apply reconciled all 12 rows; the repeat apply added 0 and reported 12 unchanged. The per-keyword reports are under the snapshot's `import-*` directories. No catalog, `public.schools`, or relation table was written. The collector archives raw HTML, hashes, fetch metadata, totals, fetch key, and failure metadata; occurrence keys retain keyword, page, and result index.

Focused tests: 3 passed (`tests/shgov-search.test.ts`). TypeScript passed and lint reported 0 errors with 21 pre-existing warnings. The repository-wide `pnpm test` command was run but remains red on pre-existing live/browser route failures (404 responses and browser timeouts); no failure was in the new focused test file. No serving code changed, so House was not restarted.

## Reviewer Recheck (2026-09-10, importer hardening)

- Fixed `parseShgovSearchHtml` so relative or malformed target/detail URLs are retained as raw fields without aborting an otherwise valid HTML page. Unknown-total pagination now reports `complete=false` when the explicit result-page limit is reached.
- Fixed `import-shgov-search` so each resource row and all result occurrences parsed from that response use the response SHA256 as the same crawl content identity. Successful resources now require a raw file and SHA256 metadata before import. The CLI entrypoint is import-safe for tests and library callers.
- Added regression coverage for relative/malformed URLs, unknown-total page limits, content-hash grouping, successful-snapshot validation, and rollback after round-trip reconciliation failure. Focused suite: 7 passed. TypeScript passed. Lint passed with 0 errors and 21 existing warnings.
- Re-ran the default manifest dry-run: 788 planned rows, 26 existing resource rows, and 762 result rows proposed for the corrected response-level runs. This confirms the earlier apply was performed with the buggy per-result hash grouping. No corrective apply or deletion was run: moving those historical rows between immutable crawl runs requires an explicit database migration decision, and applying blindly would duplicate source records.
- `pnpm test` remains red on pre-existing live/browser route checks (269 total tests; 26 failures, including unavailable/404 routes and browser connection/timeouts). The failures do not involve `tests/shgov-search.test.ts`.
