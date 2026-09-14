---
name: schoolpath-data-optimizer
description: Iteratively improve Schoolpath's Shanghai nine-district school and community data using auditable source snapshots, candidate matching, conflict review, and explicit publishing.
---

# Schoolpath Data Optimizer

Use this skill for incremental data coverage work in `/Users/jyxc-dz-0101035/yard/schoolpath`.

## Scope

Only optimize these product districts:

`黄浦、静安、长宁、虹口、杨浦、徐汇、闵行、浦东、普陀`

Keep records from other districts in the database, but never include them in a product optimization batch or its coverage report.

When the user requests complete source collection, archive entire source documents, including out-of-scope geometry. Apply the nine-district restriction to product projections and coverage metrics, not to raw source preservation.

## Iteration protocol

1. Inspect the latest coverage report and choose the highest-value gap.
2. Fetch or read a source snapshot. Preserve the original HTML, URL, fetch time, content hash, parser version, and district scope.
3. Parse and normalize names, districts, school stages, years, addresses, and coordinates.
4. Create candidates in the ingest/audit layer. Do not publish third-party school-community relations automatically.
5. Review unmatched and conflicting candidates. A school name alone is never sufficient for a relation match.
6. Publish only accepted candidates with an effective year and source evidence.
7. Re-run the nine-district coverage report and record the delta.

## Xuequzhushou source

Canonical source: `https://xuequzhushou.cn/`

### Complete website collection

For "all information" requests, use the full-site collector. The homepage-only command below omits map communities, addresses, geometries and indexes.

```bash
pnpm data:collect:xuequzhushou --timeout-ms 180000
pnpm data:import:xuequzhushou-site --manifest=data/ingest/xuequzhushou-site/<run>/manifest.json
pnpm data:import:xuequzhushou-site --manifest=data/ingest/xuequzhushou-site/<run>/manifest.json --apply
pnpm data:import:xuequzhushou-homepage --snapshot=data/ingest/xuequzhushou-site/<run>/raw/<homepage-sha256>.bin --fetched-at=<manifest-startedAt>
pnpm data:import:xuequzhushou-homepage --snapshot=data/ingest/xuequzhushou-site/<run>/raw/<homepage-sha256>.bin --fetched-at=<manifest-startedAt> --apply
```

Inspect dry-run reports before apply. Existing authorization to collect into the system covers source-layer apply; do not ask again for the same operation. Canonical publishing remains a separate reviewed workflow. Repeat both imports and require zero added/changed records before reporting idempotence.

The collector follows same-origin static links and data references, archives raw bytes with hashes, and never executes website scripts. Inspect manifest failures and parse issues. Exit code 2 means unreachable or limited resources remain; retry transient timeouts using a new run directory. Do not label a truncated HTTP 200 body as complete. Do not guess data for a persistent 404.

Preserve every community occurrence by document path and array index, including duplicates under different schools. Keep full JSON for unknown fields. Map `g` may be a string or an object with `p` addresses and `r` roads. The site's homepage and map can disagree; preserve both source versions.

Report successful/failed resources, typed record counts, round-trip reconciliation, mapping conflicts, unchanged canonical digest and explicit unavailable URLs. Inspect records in `/db` under `ingest.extracted_records`; source schools and committee relations are in `catalog`. Source archive counts do not measure verified product coverage. In the September 2026 snapshot, school datasets cover eight districts and omit Putuo; recheck each new snapshot instead of assuming nine-district completeness.

### Homepage gap iteration

Run a new snapshot with:

```bash
pnpm data:optimize:xuequzhushou
```

For a local fixture or previously captured page:

```bash
pnpm data:optimize:xuequzhushou --input=tests/fixtures/xuequzhushou-20260711.html
```

The command is a dry-run with respect to the catalog. It writes `source.html`, `parsed.json`, and `manifest.json` under `data/ingest/xuequzhushou/<timestamp>/` and filters the parsed result to the nine districts.

To load a snapshot into the ingest and audit schemas, use the existing explicit command:

```bash
pnpm redesign:load-source -- --parsed=data/ingest/xuequzhushou/<timestamp>/parsed.json
pnpm redesign:prepare-review -- --parsed=data/ingest/xuequzhushou/<timestamp>/parsed.json
```

Review candidates before running any publish script. Treat this source as `third_party`; it can supplement official evidence but cannot establish an official catchment boundary by itself.

## Shanghai government search index

Canonical source: `https://search.sh.gov.cn/search`. This is an official Shanghai government search index, not a complete export of every government site. It is useful for education and school policy discovery; result target URLs may belong to the Shanghai government, education bureaus, or other government departments and must remain separately attributable.

The protocol is a session-bound form flow: POST `/search` first, then POST `/searchResult` with the same session cookie. The collector sends `text`, `pageNo`, `newsPageNo`, `pageSize`, `resourceType`, `channel`, `category1/2/3/4/6/7`, `sortMode`, `searchMode`, `timeRange`, `accurateMode`, `district`, `street`, `stealthy`, and `showItemAgency`. `/searchResult` returns an HTML fragment with hidden `totalSize`, `total`, and `fetchKey` fields.

Run the bounded, auditable collector with explicit keywords (defaults are `学校,义务教育,招生入学,学区,对口入学`):

```bash
pnpm data:collect:shgov-search --keywords=学校,义务教育,招生入学,学区,对口入学 --max-pages=50 --timeout-ms=30000 --delay-ms=500
pnpm data:import:shgov-search --manifest=data/ingest/shgov-search/<run>/manifest.json
pnpm data:import:shgov-search --manifest=data/ingest/shgov-search/<run>/manifest.json --apply
```

The collector archives every bootstrap and result HTML body, fetch time, URL, status, SHA256, parser version, keyword, page, totals and fetch key. It preserves failed requests and stops at the explicit page limit; a run that exceeds the limit is incomplete. It does not claim search-site completeness, crawl detail pages, bypass access controls, solve CAPTCHA, or ignore service/robots restrictions. Search results are kept as occurrences: each `keyword + page + result index` has its own stable source key even when token, title, or target URL repeats.

Import is dry-run by default and writes only `ingest.sources`, `ingest.crawl_runs`, and `ingest.extracted_records` when `--apply` is explicitly used. `source_kind` is `official_search_index`; no catalog, public school, relation, or publication table is touched. Inspect the per-keyword report (`fetchedPages`, `resultCount`, `failures`, `added`, `unchanged`, `conflicts`) before apply. Apply uses transactional JSON round-trip reconciliation and repeat apply should report zero additions and zero changes for the same manifest.

## Quality rules

- Never delete out-of-scope database records.
- Never overwrite manually confirmed coordinates with automatic results.
- Keep source text intact alongside normalized values.
- Separate `candidate`, `accepted`, `conflict`, `rejected`, and `expired` states.
- Keep `effective_year` distinct from `fetched_at`.
- Report added, changed, conflicted, unmatched, and skipped counts for every batch.
