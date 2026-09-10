/**
 * Fetch community price snapshots and optionally upsert them into PostgreSQL.
 *
 * Initial source support:
 *   - CREPrice community detail page, e.g.
 *     https://m.creprice.cn/community/PN0012045XH705.html?city=sh
 *
 * Usage:
 *   pnpm exec tsx scripts/fetch-community-prices.ts --community-id=349 --source-url="https://m.creprice.cn/community/PN0012045XH705.html?city=sh"
 *   pnpm exec tsx scripts/fetch-community-prices.ts --community-id=349 --source-url="https://m.creprice.cn/community/PN0012045XH705.html?city=sh" --apply
 *   pnpm exec tsx scripts/fetch-community-prices.ts --import-source --community-id=349 --source-url="https://m.creprice.cn/community/PN0012045XH705.html?city=sh" --apply
 *   pnpm exec tsx scripts/fetch-community-prices.ts --discover-sources --district=徐汇 --limit=50 --delay-ms=1200 --timeout-ms=10000 --apply
 *   pnpm exec tsx scripts/fetch-community-prices.ts --batch --missing-only --limit=100 --delay-ms=1200 --timeout-ms=10000 --apply
 */
import { and, desc, eq, exists, ilike, not, sql } from "drizzle-orm";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();

const SOURCE_NAME = "creprice_community_mobile";

type ParsedPrice = {
  communityName: string;
  address: string | null;
  district: string | null;
  sourcePeriod: string;
  unitPriceYuanPerSqm: number;
};

type CommunityCandidate = {
  id: number;
  name: string;
  district: string;
  amapAddress: string | null;
};

function argValue(name: string): string | undefined {
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);

  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function textFromHtml(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCrepriceUrl(url: string): string {
  const absolute = new URL(url, "https://m.creprice.cn");
  if (absolute.hostname === "www.creprice.cn") absolute.hostname = "m.creprice.cn";
  absolute.protocol = "https:";
  absolute.searchParams.set("city", "sh");
  absolute.searchParams.delete("flag");
  absolute.searchParams.delete("proptype");
  return absolute.toString();
}

function districtFromShanghaiLabel(value: string): string | null {
  const match = /上海([^区县市]+[区县市])/.exec(value);
  return match ? normalizeDistrict(match[1]) : null;
}

function normalizeDistrict(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.replace(/[区县市]$/, "").trim();
}

function communityNameAliases(name: string): string[] {
  const aliases = new Set([name.trim()]);
  let current = name.trim();
  for (let index = 0; index < 3; index += 1) {
    const next = current
      .replace(/[（(](?:东区|西区|南区|北区|中区|一区|二区|三区|四区|五区|六区|七区|八区|九区|十区|[一二三四五六七八九十0-9]+期)[）)]$/, "")
      .replace(/(?:东区|西区|南区|北区|中区|一区|二区|三区|四区|五区|六区|七区|八区|九区|十区|[一二三四五六七八九十0-9]+期)$/, "")
      .trim();
    if (next === current || next.length < 2) break;
    aliases.add(next);
    current = next;
  }
  return Array.from(aliases);
}

function communityNameMatches(localName: string, sourceName: string) {
  if (localName === sourceName) return { matched: true, reason: "exact-name" };
  const aliases = communityNameAliases(localName);
  if (aliases.slice(1).includes(sourceName)) {
    return { matched: true, reason: "phase-suffix-alias" };
  }
  return { matched: false, reason: null };
}

function parseCrepriceCommunityPage(html: string): ParsedPrice {
  const h1Match = /<h1[^>]*class="[^"]*\bsituationHead\b[^"]*"[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const communityName = h1Match
    ? textFromHtml(h1Match[1]).replace(/房价\s*（住宅）$/, "").replace(/房价$/, "").trim()
    : "";

  const addressMatch = /地址：([^<]+)/.exec(html);
  const address = addressMatch ? textFromHtml(addressMatch[1]) : null;
  const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(html);
  const titleText = titleMatch ? textFromHtml(titleMatch[1]) : "";
  const crumbDistrictMatch = /<a href="\/district\/[^"]+\?city=sh">([^<]+)<\/a>/i.exec(html);
  const district = crumbDistrictMatch
    ? normalizeDistrict(textFromHtml(crumbDistrictMatch[1]))
    : districtFromShanghaiLabel(titleText);

  const priceBlockMatch = /<p>\s*平均房价\s*<span[^>]*>（([^）]+)）<\/span>\s*<\/p>\s*<div class="fl">\s*<span[^>]*>([\d,]+)<\/span>\s*元\/㎡/i.exec(html);

  if (!communityName) throw new Error("CREPrice parse failed: missing community name.");
  if (!priceBlockMatch) throw new Error("CREPrice parse failed: missing average price block.");

  const sourcePeriod = priceBlockMatch[1].trim();
  const unitPriceYuanPerSqm = Number(priceBlockMatch[2].replace(/,/g, ""));
  if (!Number.isFinite(unitPriceYuanPerSqm) || unitPriceYuanPerSqm <= 0) {
    throw new Error(`CREPrice parse failed: invalid unit price "${priceBlockMatch[2]}".`);
  }

  return {
    communityName,
    address,
    district,
    sourcePeriod,
    unitPriceYuanPerSqm,
  };
}

function findCrepriceSearchCandidates(html: string): Array<{ sourceUrl: string; label: string; district: string | null }> {
  const candidates: Array<{ sourceUrl: string; label: string; district: string | null }> = [];
  const linkPattern = /<a[^>]+href="([^"]*\/community\/[^"]+?city=sh[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(linkPattern)) {
    const label = textFromHtml(match[2]);
    candidates.push({
      sourceUrl: normalizeCrepriceUrl(match[1]),
      label,
        district: districtFromShanghaiLabel(label),
    });
  }
  return candidates;
}

async function fetchHtml(sourceUrl: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const response = await fetch(sourceUrl, {
    signal: controller.signal,
    headers: {
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
    },
  }).finally(() => clearTimeout(timeout));

  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

async function findCommunity(communityId: number) {
  const { db, schema } = await import("../lib/db/client");
  const rows = await db
    .select({
      id: schema.communities.id,
      name: schema.communities.name,
      district: schema.communities.district,
      amapAddress: schema.communities.amapAddress,
    })
    .from(schema.communities)
    .where(eq(schema.communities.id, communityId))
    .limit(1);

  return rows[0];
}

async function listCommunitiesForDiscovery(options: {
  limit: number;
  offset: number;
  district?: string;
  missingOnly: boolean;
  schoolId?: number;
  nameLike?: string;
}): Promise<CommunityCandidate[]> {
  const { db, schema } = await import("../lib/db/client");
  const predicates = [];
  if (options.district) predicates.push(eq(schema.communities.district, options.district));
  if (options.nameLike) predicates.push(ilike(schema.communities.name, `%${options.nameLike}%`));
  if (options.schoolId) {
    predicates.push(
      exists(
        db
          .select({ id: schema.schoolCommunities.id })
          .from(schema.schoolCommunities)
          .where(
            and(
              eq(schema.schoolCommunities.communityId, schema.communities.id),
              eq(schema.schoolCommunities.schoolId, options.schoolId),
            ),
          ),
      ),
    );
  }
  if (options.missingOnly) {
    predicates.push(
      not(
        exists(
          db
            .select({ id: schema.communityPriceSources.id })
            .from(schema.communityPriceSources)
            .where(
              and(
                eq(schema.communityPriceSources.communityId, schema.communities.id),
                eq(schema.communityPriceSources.sourceName, SOURCE_NAME),
                eq(schema.communityPriceSources.active, true),
              ),
            ),
        ),
      ),
    );
  }

  const base = db
    .select({
      id: schema.communities.id,
      name: schema.communities.name,
      district: schema.communities.district,
      amapAddress: schema.communities.amapAddress,
    })
    .from(schema.communities);

  return (predicates.length > 0 ? base.where(and(...predicates)) : base)
    .orderBy(schema.communities.district, schema.communities.name)
    .offset(options.offset)
    .limit(options.limit);
}

async function upsertSnapshot(communityId: number, sourceUrl: string, parsed: ParsedPrice) {
  const { db, schema } = await import("../lib/db/client");
  const existing = await db
    .select({ id: schema.communityPriceSnapshots.id })
    .from(schema.communityPriceSnapshots)
    .where(
      and(
        eq(schema.communityPriceSnapshots.communityId, communityId),
        eq(schema.communityPriceSnapshots.sourceName, SOURCE_NAME),
        eq(schema.communityPriceSnapshots.sourcePeriod, parsed.sourcePeriod),
      ),
    )
    .limit(1);

  const raw = {
    sourceCommunityName: parsed.communityName,
    sourceAddress: parsed.address,
  };

  if (existing[0]) {
    const [updated] = await db
      .update(schema.communityPriceSnapshots)
      .set({
        sourceUrl,
        unitPriceYuanPerSqm: parsed.unitPriceYuanPerSqm,
        raw,
        fetchedAt: new Date(),
      })
      .where(eq(schema.communityPriceSnapshots.id, existing[0].id))
      .returning();
    return { action: "updated", row: updated };
  }

  const [inserted] = await db
    .insert(schema.communityPriceSnapshots)
    .values({
      communityId,
      sourceName: SOURCE_NAME,
      sourceUrl,
      sourcePeriod: parsed.sourcePeriod,
      unitPriceYuanPerSqm: parsed.unitPriceYuanPerSqm,
      raw,
    })
    .returning();
  return { action: "inserted", row: inserted };
}

async function upsertSource(communityId: number, sourceUrl: string, parsed?: ParsedPrice, matchReason?: string) {
  const { db, schema } = await import("../lib/db/client");
  const values = {
    communityId,
    sourceName: SOURCE_NAME,
    sourceUrl,
    sourceCommunityName: parsed?.communityName,
    sourceAddress: parsed?.address,
    raw: parsed ? { importedFrom: "fetch-community-prices", parsedPeriod: parsed.sourcePeriod, matchReason } : undefined,
    updatedAt: new Date(),
  };

  const [row] = await db
    .insert(schema.communityPriceSources)
    .values(values)
    .onConflictDoUpdate({
      target: [schema.communityPriceSources.communityId, schema.communityPriceSources.sourceName],
      set: values,
    })
    .returning();
  return row;
}

type BatchSource = {
  communityId: number;
  sourceUrl: string;
  communityName: string;
  district: string;
};

async function reportCoverage(options: {
  district?: string;
  schoolId?: number;
  nameLike?: string;
}) {
  const { db } = await import("../lib/db/client");
  const namePattern = options.nameLike ? `%${options.nameLike}%` : undefined;
  const rows = await db.execute(sql`
    SELECT
      c.district,
      COUNT(DISTINCT c.id)::int AS total,
      COUNT(DISTINCT cpsrc.community_id)::int AS source_mapped,
      COUNT(DISTINCT cps.community_id)::int AS priced
    FROM communities c
    ${options.schoolId
      ? sql`INNER JOIN school_communities sc
          ON sc.community_id = c.id
          AND sc.school_id = ${options.schoolId}`
      : sql``}
    LEFT JOIN community_price_sources cpsrc
      ON cpsrc.community_id = c.id
      AND cpsrc.source_name = ${SOURCE_NAME}
      AND cpsrc.active = true
    LEFT JOIN community_price_snapshots cps
      ON cps.community_id = c.id
      AND cps.source_name = ${SOURCE_NAME}
    WHERE
      ${options.district ? sql`c.district = ${options.district}` : sql`true`}
      AND ${namePattern ? sql`c.name ILIKE ${namePattern}` : sql`true`}
    GROUP BY c.district
    ORDER BY c.district
  `);

  return rows.rows;
}

async function listBatchSources(options: {
  limit: number;
  district?: string;
  missingOnly: boolean;
}): Promise<BatchSource[]> {
  const { db, schema } = await import("../lib/db/client");

  const predicates = [
    eq(schema.communityPriceSources.sourceName, SOURCE_NAME),
    eq(schema.communityPriceSources.active, true),
  ];
  if (options.district) {
    predicates.push(eq(schema.communities.district, options.district));
  }
  if (options.missingOnly) {
    predicates.push(
      not(
        exists(
          db
            .select({ id: schema.communityPriceSnapshots.id })
            .from(schema.communityPriceSnapshots)
            .where(
              and(
                eq(schema.communityPriceSnapshots.communityId, schema.communityPriceSources.communityId),
                eq(schema.communityPriceSnapshots.sourceName, SOURCE_NAME),
              ),
            ),
        ),
      ),
    );
  }

  return db
    .select({
      communityId: schema.communityPriceSources.communityId,
      sourceUrl: schema.communityPriceSources.sourceUrl,
      communityName: schema.communities.name,
      district: schema.communities.district,
    })
    .from(schema.communityPriceSources)
    .innerJoin(schema.communities, eq(schema.communityPriceSources.communityId, schema.communities.id))
    .where(and(...predicates))
    .orderBy(schema.communities.district, schema.communities.name, desc(schema.communityPriceSources.updatedAt))
    .limit(options.limit);
}

async function fetchAndMaybeWrite(input: {
  communityId: number;
  sourceUrl: string;
  apply: boolean;
  importSource: boolean;
  timeoutMs: number;
}) {
  const community = await findCommunity(input.communityId);
  if (!community) throw new Error(`Community not found: ${input.communityId}`);

  const html = await fetchHtml(input.sourceUrl, input.timeoutMs);
  const parsed = parseCrepriceCommunityPage(html);
  const nameMatches = parsed.communityName === community.name;
  const result = {
    apply: input.apply,
    sourceName: SOURCE_NAME,
    community,
    parsed,
    nameMatches,
  };

  if (!nameMatches) {
    console.warn(
      `Warning: source community name "${parsed.communityName}" does not equal local community "${community.name}".`,
    );
  }

  if (!input.apply) return { ...result, dryRun: true };

  const source = input.importSource
    ? await upsertSource(input.communityId, input.sourceUrl, parsed)
    : undefined;
  const write = await upsertSnapshot(input.communityId, input.sourceUrl, parsed);
  return { ...result, source, write };
}

function pickDiscoveryMatch(
  community: CommunityCandidate,
  parsedOrCandidates: ParsedPrice | Array<{ sourceUrl: string; label: string; district: string | null }>,
) {
  if (!Array.isArray(parsedOrCandidates)) {
    const nameMatch = communityNameMatches(community.name, parsedOrCandidates.communityName);
    const districtMatches = !parsedOrCandidates.district || parsedOrCandidates.district === normalizeDistrict(community.district);
    return nameMatch.matched && districtMatches
      ? { sourceUrl: null, parsed: parsedOrCandidates, reason: nameMatch.reason === "exact-name" ? "direct-detail" : "direct-detail-phase-suffix-alias" }
      : null;
  }

  for (const candidate of parsedOrCandidates) {
    const labelWithoutSuffix = candidate.label
      .replace(/^上海[^区县市]+[区县市]/, "")
      .replace(/住宅房价行情$/, "")
      .replace(/房价行情$/, "")
      .trim();
    const nameMatch = communityNameMatches(community.name, labelWithoutSuffix);
    if (nameMatch.matched && (!candidate.district || candidate.district === normalizeDistrict(community.district))) {
      return {
        sourceUrl: candidate.sourceUrl,
        parsed: null,
        reason: nameMatch.reason === "exact-name" ? "search-result" : "search-result-phase-suffix-alias",
      };
    }
  }
  return null;
}

async function discoverOneSource(community: CommunityCandidate, timeoutMs: number) {
  const searchUrl = `https://m.creprice.cn/ha/indexSearch.html?keyword=${encodeURIComponent(community.name)}`;
  const html = await fetchHtml(searchUrl, timeoutMs);

  if (/<h1[^>]*class="[^"]*\bsituationHead\b/i.test(html)) {
    let parsed: ParsedPrice;
    try {
      parsed = parseCrepriceCommunityPage(html);
    } catch (error) {
      return {
        community,
        searchUrl,
        matched: false,
        reason: "direct-detail-unusable",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const match = pickDiscoveryMatch(community, parsed);
    if (!match) {
      return {
        community,
        searchUrl,
        matched: false,
        reason: "direct-detail-mismatch",
        parsed,
      };
    }
    const canonicalMatch = /<link\s+rel="canonical"\s+href="([^"]+)"/i.exec(html);
    const sourceUrl = normalizeCrepriceUrl(canonicalMatch?.[1] ?? searchUrl);
    return { community, searchUrl, matched: true, sourceUrl, parsed, reason: match.reason };
  }

  const candidates = findCrepriceSearchCandidates(html);
  const match = pickDiscoveryMatch(community, candidates);
  if (!match?.sourceUrl) {
    return { community, searchUrl, matched: false, reason: "no-exact-search-result", candidates };
  }

  const detailHtml = await fetchHtml(match.sourceUrl, timeoutMs);
  const parsed = parseCrepriceCommunityPage(detailHtml);
  const detailMatch = pickDiscoveryMatch(community, parsed);
  if (!detailMatch) {
    return {
      community,
      searchUrl,
      matched: false,
      reason: "detail-mismatch-after-search",
      sourceUrl: match.sourceUrl,
      parsed,
    };
  }

  return { community, searchUrl, matched: true, sourceUrl: match.sourceUrl, parsed, reason: match.reason };
}

async function main() {
  const communityId = Number(argValue("community-id"));
  const sourceUrl = argValue("source-url");
  const apply = hasFlag("apply");
  const batch = hasFlag("batch");
  const discoverSources = hasFlag("discover-sources");
  const report = hasFlag("report");
  const jsonl = hasFlag("jsonl");
  const importSource = hasFlag("import-source");
  const missingOnly = hasFlag("missing-only");
  const district = argValue("district");
  const limit = Number(argValue("limit") ?? (batch ? "50" : "1"));
  const offset = Number(argValue("offset") ?? "0");
  const delayMs = Number(argValue("delay-ms") ?? "1000");
  const timeoutMs = Number(argValue("timeout-ms") ?? "10000");
  const schoolId = argValue("school-id") ? Number(argValue("school-id")) : undefined;
  const nameLike = argValue("name-like");

  if (!Number.isInteger(limit) || limit <= 0) throw new Error("--limit must be a positive integer.");
  if (!Number.isInteger(offset) || offset < 0) throw new Error("--offset must be a non-negative integer.");
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("--delay-ms must be a non-negative number.");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be a positive number.");
  if (schoolId !== undefined && (!Number.isInteger(schoolId) || schoolId <= 0)) {
    throw new Error("--school-id must be a positive integer.");
  }

  if (report) {
    console.log(JSON.stringify({
      sourceName: SOURCE_NAME,
      filters: { district, schoolId, nameLike },
      rows: await reportCoverage({ district, schoolId, nameLike }),
    }, null, 2));
    return;
  }

  if (discoverSources) {
    const communities = await listCommunitiesForDiscovery({ limit, offset, district, missingOnly, schoolId, nameLike });
    const summary = { apply, total: communities.length, matched: 0, imported: 0, failed: 0 };
    const results: unknown[] = [];

    for (const [index, community] of communities.entries()) {
      try {
        const discovery = await discoverOneSource(community, timeoutMs);
        if (!discovery.matched) {
          results.push(discovery);
        } else {
          summary.matched += 1;
          const sourceUrl = discovery.sourceUrl;
          if (!sourceUrl) throw new Error(`Discovery matched without a source URL for community ${community.id}.`);
          const source = apply
            ? await upsertSource(community.id, sourceUrl, discovery.parsed, discovery.reason)
            : undefined;
          if (source) summary.imported += 1;
          const row = { ...discovery, source };
          results.push(row);
          if (jsonl) console.log(JSON.stringify({ type: "result", row }));
          if (index < communities.length - 1 && delayMs > 0) await sleep(delayMs);
          continue;
        }
      } catch (error) {
        summary.failed += 1;
        results.push({
          community,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (jsonl) console.log(JSON.stringify({ type: "result", row: results[results.length - 1] }));
      if (index < communities.length - 1 && delayMs > 0) await sleep(delayMs);
    }

    if (jsonl) console.log(JSON.stringify({ type: "summary", summary }));
    else console.log(JSON.stringify({ summary, results }, null, 2));
    return;
  }

  if (batch) {
    const sources = await listBatchSources({ limit, district, missingOnly });
    const summary = { apply, total: sources.length, inserted: 0, updated: 0, failed: 0, dryRun: 0 };
    const results: unknown[] = [];

    for (const [index, source] of sources.entries()) {
      try {
        const result = await fetchAndMaybeWrite({
          communityId: source.communityId,
          sourceUrl: source.sourceUrl,
          apply,
          importSource: false,
          timeoutMs,
        });
        const action = "write" in result ? result.write.action : "dryRun";
        if (action === "inserted") summary.inserted += 1;
        else if (action === "updated") summary.updated += 1;
        else summary.dryRun += 1;
        const row = { communityId: source.communityId, communityName: source.communityName, action, result };
        results.push(row);
        if (jsonl) console.log(JSON.stringify({ type: "result", row }));
      } catch (error) {
        summary.failed += 1;
        const row = {
          communityId: source.communityId,
          communityName: source.communityName,
          error: error instanceof Error ? error.message : String(error),
        };
        results.push(row);
        if (jsonl) console.log(JSON.stringify({ type: "result", row }));
      }
      if (index < sources.length - 1 && delayMs > 0) await sleep(delayMs);
    }

    if (jsonl) console.log(JSON.stringify({ type: "summary", summary }));
    else console.log(JSON.stringify({ summary, results }, null, 2));
    return;
  }

  if (!Number.isInteger(communityId) || communityId <= 0) {
    throw new Error("Missing or invalid --community-id.");
  }
  if (!sourceUrl) {
    throw new Error("Missing --source-url.");
  }
  if (!/^https:\/\/m\.creprice\.cn\/community\/.+\.html\?city=sh\b/.test(sourceUrl)) {
    throw new Error("Only CREPrice Shanghai mobile community URLs are supported for now.");
  }
  if (importSource && !apply) {
    throw new Error("--import-source requires --apply.");
  }

  const result = await fetchAndMaybeWrite({ communityId, sourceUrl, apply, importSource, timeoutMs });
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { pool } = await import("../lib/db/client");
    await pool.end();
  });
