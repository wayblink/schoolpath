/**
 * 高德 PlaceSearch 反查居委附近小区 → 灌进 communities + school_communities 表
 *
 * 用法：
 *   pnpm tsx scripts/fetch-communities.ts
 *
 * 前置条件：
 *   - .env.local 里有 NEXT_PUBLIC_AMAP_KEY
 *   - 这个 key 在 console.amap.com 必须勾选 "Web 服务" 平台（不是只 Web 端 JS API）
 *   - DB 已 migrate 到含 communities + school_communities 表的版本
 *
 * 流程：
 *   1. 从 DB 读所有 schools.attrs.matching_committees 收集 unique 居委集合
 *   2. 对每个居委：
 *      a. 地理编码 → 得到中心坐标
 *      b. 周边 PlaceSearch (types=120300|120301 住宅区，radius=600m) 拿候选小区 POI
 *      c. upsert 进 communities 表（按 name + district 唯一）
 *      d. upsert school_communities 关联（每个 community 关联到所有 matching_committees 含该居委的学校）
 *   3. 输出统计
 *
 * 所有插入条目 verified=false，等人工核验
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../lib/db/client";

const envPath = path.join(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const KEY = process.env.AMAP_REST_KEY ?? process.env.NEXT_PUBLIC_AMAP_KEY ?? process.env.AMAP_KEY;
if (!KEY) {
  console.error("✗ Missing AMAP_REST_KEY (优先) 或 NEXT_PUBLIC_AMAP_KEY");
  process.exit(1);
}

const BASE = "https://restapi.amap.com/v3";
const TODAY = new Date().toISOString().slice(0, 10);

type AmapResp = { status: string; info: string; infocode?: string; [k: string]: unknown };

async function call(endpoint: string, params: Record<string, string>): Promise<AmapResp> {
  const url = new URL(`${BASE}/${endpoint}`);
  url.searchParams.set("key", KEY!);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  const data = (await res.json()) as AmapResp;
  if (data.status !== "1") {
    const code = data.infocode ?? "unknown";
    const info = data.info ?? "unknown";
    if (code === "10009" || info.includes("USERKEY_PLAT_NOMATCH")) {
      throw new Error(
        `高德 REST API 拒绝：key 没勾 'Web 服务' 平台。\n` +
        `→ console.amap.com 编辑 key 加 'Web 服务' 后重跑。`,
      );
    }
    throw new Error(`AMap ${endpoint} failed: ${info} (code=${code})`);
  }
  return data;
}

async function geocodeCommittee(committee: string, district: string): Promise<{ lat: number; lng: number; address: string; via: string } | null> {
  // 优先策略 1: inputtips fuzzy 匹配（短名 + 完整地址都好用，且自带 district 字段）
  const tipsQueries = [
    `${committee} ${district}`,
    `${committee}社区`,
    committee,
  ];
  for (const q of tipsQueries) {
    try {
      const data = await call("assistant/inputtips", {
        keywords: q,
        city: "021",
        citylimit: "true",
        datatype: "poi",
      });
      const tips = (data.tips as Array<{ name: string; location: string | unknown; district?: string; address?: string }>) ?? [];
      const valid = tips.filter((t) => typeof t.location === "string" && (t.location as string).length > 0);
      // 优先选 district 含目标区的
      const districtHit = valid.find((t) => t.district?.includes(district));
      const hit = districtHit ?? valid[0];
      if (hit) {
        const [lng, lat] = (hit.location as string).split(",").map(Number);
        if (Number.isFinite(lng) && Number.isFinite(lat)) {
          return { lat, lng, address: hit.address || hit.name, via: `inputtips:${q}` };
        }
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("USERKEY_PLAT_NOMATCH") || msg.includes("Web 服务")) throw err;
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  // 优先策略 2: place/text 居委会 / 居民委员会 / 居委 / 社区
  const queries = [
    `${committee}居委会`,
    `${committee}居民委员会`,
    `${committee}居委`,
    `${committee}社区`,
  ];
  for (const q of queries) {
    try {
      const data = await call("place/text", {
        keywords: q,
        city: "021",
        citylimit: "true",
        offset: "5",
        page: "1",
        extensions: "base",
      });
      const pois = (data.pois as Array<{ location: string; address: string; name: string; pname: string; cityname: string; adname: string }>) ?? [];
      const districtHit = pois.find((p) => p.adname?.includes(district));
      const hit = districtHit ?? pois[0];
      if (hit?.location) {
        const [lng, lat] = hit.location.split(",").map(Number);
        return { lat, lng, address: hit.address || hit.name, via: `place_text:${q}` };
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("USERKEY_PLAT_NOMATCH") || msg.includes("Web 服务")) throw err;
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  try {
    const data = await call("geocode/geo", { address: `上海市${district}区${committee}`, city: "上海" });
    const list = data.geocodes as Array<{ location: string; formatted_address: string }>;
    if (list && list.length > 0) {
      const [lng, lat] = list[0].location.split(",").map(Number);
      return { lat, lng, address: list[0].formatted_address, via: "geocode_fallback" };
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("USERKEY_PLAT_NOMATCH") || msg.includes("Web 服务")) throw err;
  }
  return null;
}

type PoiResult = {
  id: string;
  name: string;
  type: string;
  typecode: string;
  address: string;
  location: string;
};

async function searchCommunitiesAround(lat: number, lng: number): Promise<PoiResult[]> {
  // types: 120300 住宅区 | 120301 住宅小区 | 120302 别墅 | 120303 商住两用
  const data = await call("place/around", {
    location: `${lng},${lat}`,
    radius: "600",
    types: "120300|120301|120302|120303",
    offset: "25",
    page: "1",
    extensions: "base",
  });
  const pois = (data.pois as PoiResult[]) ?? [];
  return pois.filter((p) => p.typecode?.startsWith("12030"));
}

// 高德对空字段经常返回空数组 [] 而非 null/string。强制 string 化。
function s(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return "";
  if (v == null) return "";
  return String(v);
}

async function upsertCommunity(
  name: string,
  district: string,
  poi: PoiResult,
  sourceCommittee: string,
  amapQueryCenter: string,
): Promise<number> {
  const existing = await db
    .select()
    .from(schema.communities)
    .where(and(eq(schema.communities.name, name), eq(schema.communities.district, district)))
    .limit(1);
  if (existing.length > 0) return existing[0].id;

  const [lng, lat] = s(poi.location).split(",").map(Number);
  const [inserted] = await db
    .insert(schema.communities)
    .values({
      name,
      district,
      lng,
      lat,
      amapPoiId: s(poi.id),
      amapTypeCode: s(poi.typecode),
      amapTypeName: s(poi.type),
      amapAddress: s(poi.address),
      sourceCommittee,
      sourceQuery: amapQueryCenter,
      sourceUrl: `https://www.amap.com/place/${s(poi.id)}`,
      sourceName: "amap_placesearch_around_committee",
      sourceDate: TODAY,
      verified: false,
      attrs: { raw_typecode: s(poi.typecode), raw_type: s(poi.type) },
    })
    .returning({ id: schema.communities.id });
  return inserted.id;
}

async function upsertSchoolCommunity(
  schoolId: number,
  communityId: number,
  committeeName: string,
  poiAddress: string,
) {
  const existing = await db
    .select()
    .from(schema.schoolCommunities)
    .where(
      and(
        eq(schema.schoolCommunities.schoolId, schoolId),
        eq(schema.schoolCommunities.communityId, communityId),
        eq(schema.schoolCommunities.year, 2025),
      ),
    )
    .limit(1);
  if (existing.length > 0) return;

  await db.insert(schema.schoolCommunities).values({
    schoolId,
    communityId,
    committeeName,
    year: 2025,
    sourceName: "amap_placesearch_via_committee",
    sourceUrl: "https://sh.bendibao.com/edu/202547/296230.shtm",
    sourceQuote: `对口居委 "${committeeName}" + 高德 POI 地址 "${poiAddress}"`,
    sourceDate: TODAY,
    verified: false,
    notes: "未核验。来源链：教育局对口居委表 → 高德 PlaceSearch 反查居委附近小区。可能漏小区或多挂小区。",
  });
}

type SchoolRow = {
  id: number;
  name: string;
  attrs: Record<string, unknown> | null;
};

async function main() {
  const districtArg = process.argv.find((a) => a.startsWith("--district"));
  const DISTRICT = districtArg
    ? (districtArg.split("=")[1] ?? process.argv[process.argv.indexOf(districtArg) + 1] ?? "徐汇").trim()
    : "徐汇";

  console.log(`高德 PlaceSearch 反查居委附近小区`);
  console.log(`KEY: ${KEY?.slice(0, 8)}...${KEY?.slice(-4)}`);
  console.log(`DISTRICT: ${DISTRICT}`);
  console.log(`今天: ${TODAY}\n`);

  const schoolsList: SchoolRow[] = await db
    .select({ id: schema.schools.id, name: schema.schools.name, attrs: schema.schools.attrs })
    .from(schema.schools)
    .where(eq(schema.schools.district, DISTRICT));
  console.log(`schools (${DISTRICT}): ${schoolsList.length}`);

  // 收集 committee → [schoolIds] 反向索引
  const committeeToSchools = new Map<string, number[]>();
  for (const s of schoolsList) {
    const list = (s.attrs as { matching_committees?: string[] } | null)?.matching_committees ?? [];
    for (const raw of list) {
      const committee = raw.replace(/（部分）/g, "").trim();
      if (!committeeToSchools.has(committee)) committeeToSchools.set(committee, []);
      committeeToSchools.get(committee)!.push(s.id);
    }
  }
  console.log(`unique committees: ${committeeToSchools.size}\n`);

  let totalCommunities = 0;
  let totalLinks = 0;
  const failedGeo: string[] = [];

  for (const [committee, schoolIds] of committeeToSchools.entries()) {
    const geo = await geocodeCommittee(committee, DISTRICT);
    if (!geo) {
      console.log(`  ✗ ${committee}: 地理编码失败`);
      failedGeo.push(committee);
      continue;
    }
    let pois: PoiResult[] = [];
    try {
      pois = await searchCommunitiesAround(geo.lat, geo.lng);
    } catch (err) {
      console.log(`  ✗ ${committee}: around search 失败 - ${(err as Error).message}`);
      continue;
    }
    console.log(`  ${committee} (${geo.lat.toFixed(4)},${geo.lng.toFixed(4)}) → ${pois.length} 个候选小区`);

    for (const poi of pois) {
      try {
        if (!poi.name || !poi.id || !poi.location) {
          console.log(`    ⚠ skip POI (缺字段): name=${poi.name} id=${poi.id} loc=${poi.location}`);
          continue;
        }
        const [lng, lat] = poi.location.split(",").map(Number);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
          console.log(`    ⚠ skip POI (坐标解析失败): ${poi.name} loc=${poi.location}`);
          continue;
        }
        const communityId = await upsertCommunity(
          poi.name,
          DISTRICT,
          poi,
          committee,
          `${geo.lng},${geo.lat}`,
        );
        for (const schoolId of schoolIds) {
          await upsertSchoolCommunity(schoolId, communityId, committee, poi.address ?? "");
          totalLinks++;
        }
        totalCommunities++;
      } catch (err) {
        console.log(`    ⚠ skip POI (upsert 异常): ${poi.name} - ${(err as Error).message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`\n[派生] 初中校通过对口小学池继承小区...`);
  const derivedCount = await deriveMiddleSchoolCommunities(schoolsList, DISTRICT);

  console.log(`\n✓ Done.`);
  console.log(`  小区候选插入: ${totalCommunities} 次（含重复 upsert）`);
  console.log(`  学校-小区直接关联: ${totalLinks} 次`);
  console.log(`  学校-小区派生关联: ${derivedCount} 次`);
  if (failedGeo.length > 0) {
    console.log(`  地理编码失败的居委 (${failedGeo.length}): ${failedGeo.join(", ")}`);
    console.log(`  → 这些居委需要人工查中心点后手动补 communities 表`);
  }

  const totalDistinct = await db.select().from(schema.communities);
  const totalSchoolCommunities = await db.select().from(schema.schoolCommunities);
  console.log(`\n  DB 统计:`);
  console.log(`  - communities 表行数: ${totalDistinct.length}`);
  console.log(`  - school_communities 表行数: ${totalSchoolCommunities.length}`);
  console.log(`  - 所有条目均 verified=false，需人工核验`);

  process.exit(0);
}

function normalizeSchoolName(name: string): string {
  return name
    .replace(/^上海市(徐汇区)?/, "")
    .replace(/（部分）/g, "")
    .replace(/[（）()]/g, "")
    .replace(/小学|校区/g, "")
    .trim();
}

async function deriveMiddleSchoolCommunities(schoolsList: SchoolRow[], district: string): Promise<number> {
  const middleSchools = await db
    .select()
    .from(schema.schools)
    .where(and(eq(schema.schools.district, district), eq(schema.schools.type, "middle")));

  const primarySchoolIndex = new Map<string, number>();
  for (const sc of schoolsList) {
    const attrs = (sc.attrs as { shortName?: string } | null) ?? {};
    if (attrs.shortName) primarySchoolIndex.set(normalizeSchoolName(attrs.shortName), sc.id);
    primarySchoolIndex.set(normalizeSchoolName(sc.name), sc.id);
  }
  const idToName = new Map(schoolsList.map((sc) => [sc.id, sc.name]));

  let derived = 0;
  for (const middle of middleSchools) {
    const attrs = (middle.attrs as { feeder_schools?: string[] } | null) ?? {};
    const feeders = attrs.feeder_schools ?? [];
    if (feeders.length === 0) continue;

    const matchedPrimaryIds = new Set<number>();
    const matchedFeederNames: string[] = [];
    const unmatchedFeeders: string[] = [];
    for (const feeder of feeders) {
      const key = normalizeSchoolName(feeder);
      const id = primarySchoolIndex.get(key);
      if (id != null) {
        matchedPrimaryIds.add(id);
        matchedFeederNames.push(feeder);
      } else {
        unmatchedFeeders.push(feeder);
      }
    }

    if (matchedPrimaryIds.size === 0) {
      console.log(`  ${middle.name}: 0 feeder 命中 DB（${feeders.length} 个 feeder 都不在 9 校内）`);
      continue;
    }
    console.log(`  ${middle.name}: ${matchedPrimaryIds.size}/${feeders.length} feeder 命中: ${matchedFeederNames.join("、")}${unmatchedFeeders.length > 0 ? `（未命中: ${unmatchedFeeders.join("、")}）` : ""}`);

    const sourceLinks = await db
      .select()
      .from(schema.schoolCommunities)
      .where(eq(schema.schoolCommunities.year, 2025));
    const linksToCopy = sourceLinks.filter((l) => matchedPrimaryIds.has(l.schoolId));

    for (const link of linksToCopy) {
      const existing = await db
        .select()
        .from(schema.schoolCommunities)
        .where(
          and(
            eq(schema.schoolCommunities.schoolId, middle.id),
            eq(schema.schoolCommunities.communityId, link.communityId),
            eq(schema.schoolCommunities.year, 2025),
          ),
        )
        .limit(1);
      if (existing.length > 0) continue;

      const feederName = idToName.get(link.schoolId) ?? "未知小学";
      await db.insert(schema.schoolCommunities).values({
        schoolId: middle.id,
        communityId: link.communityId,
        committeeName: `via ${link.committeeName ?? "?"}`,
        year: 2025,
        sourceName: "derived_via_feeder_school",
        sourceUrl: "https://www.shijiancn.com/zhengcezixun/63627.html",
        sourceQuote: `经由对口小学「${feederName}」（feeder_schools 池）继承小区，原居委 ${link.committeeName ?? "?"}`,
        sourceDate: TODAY,
        verified: false,
        notes: "派生关系。若对口小学池本身有误，这里也会有误。",
      });
      derived++;
    }
  }
  return derived;
}

main().catch((err) => {
  console.error("\n✗ FAILED:", (err as Error).message);
  process.exit(1);
});
