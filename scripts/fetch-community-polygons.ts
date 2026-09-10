/**
 * 用 OSM Overpass API 抓每个 community 的真实建筑/居住区 polygon
 * 写入 communities.osm_polygon / osm_way_id / osm_fetched_at
 *
 * 用法:
 *   pnpm tsx scripts/fetch-community-polygons.ts                                # name 匹配，全 DB
 *   pnpm tsx scripts/fetch-community-polygons.ts --school-id 6                  # name 匹配，仅该 school
 *   pnpm tsx scripts/fetch-community-polygons.ts --mode by-location             # 位置匹配（徐汇 bbox 内全 residential）
 *   pnpm tsx scripts/fetch-community-polygons.ts --mode by-location --school-id 6
 *   pnpm tsx scripts/fetch-community-polygons.ts --refresh                      # 含已抓过的重抓
 *   pnpm tsx scripts/fetch-community-polygons.ts --dry-run                      # 只打印不写库
 *
 * by-name 模式（default）: 1 个 batch query 用 regex alternation 查 N 个 name 是否在 OSM。
 *   适合"上海新村"、"长桥五村"这类大牌小区。徐汇老城区命中率低（1-5%）
 *
 * by-location 模式: 单条 query 拉所有 way[landuse=residential]，对 community center 做 point-in-polygon。
 *   绕过 name 匹配，只要 OSM 有 polygon（即使无 name）就能挂上。预期更高命中率
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { eq, and, sql, or } from "drizzle-orm";
import * as turf from "@turf/turf";
import type { Feature, Polygon } from "geojson";
import { db, schema } from "../lib/db/client";

const envPath = path.join(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const REFRESH = args.includes("--refresh");
const modeArg = args.find((a) => a.startsWith("--mode"));
const MODE: "by-name" | "by-location" = modeArg
  ? ((modeArg.split("=")[1] ?? args[args.indexOf(modeArg) + 1] ?? "by-name").trim() as "by-name" | "by-location")
  : "by-name";
const schoolIdArg = args.find((a) => a.startsWith("--school-id"));
const SCHOOL_ID = schoolIdArg
  ? Number((schoolIdArg.split("=")[1] ?? args[args.indexOf(schoolIdArg) + 1] ?? "").trim())
  : null;
const districtArg = args.find((a) => a.startsWith("--district"));
const DISTRICT = districtArg
  ? ((districtArg.split("=")[1] ?? args[args.indexOf(districtArg) + 1] ?? "").trim() || null)
  : null;
const ALL_DISTRICTS = args.includes("--all-districts");

const OVERPASS_MIRRORS = [
  "https://z.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];

const TODAY = new Date().toISOString().slice(0, 10);
const BATCH_SIZE = 80; // 一次最多查多少个 name (regex 别太长)
const PER_REQ_TIMEOUT_MS = 45_000;
const XUHUI_BBOX = { south: 31.10, west: 121.40, north: 31.22, east: 121.50 };
// 上海市边界 bbox（用来在算 dynBbox 前剔除跨区脏数据）
const SHANGHAI_BBOX = { south: 30.65, west: 120.85, north: 31.90, east: 122.05 };

type OSMElement = {
  type: "way";
  id: number;
  bounds?: { minlat: number; maxlat: number; minlon: number; maxlon: number };
  geometry?: Array<{ lat: number; lon: number }>;
  tags?: Record<string, string>;
};

type OverpassResp = { elements: OSMElement[] };

function escapeRegex(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * 一次查询一批 community name。返回 name → OSMElement[] 映射（一个 name 可能多个 way）。
 * 用单条 query 包含所有名字的 regex alternation，比单条单查快 100 倍。
 */
async function batchQueryOverpass(names: string[]): Promise<Map<string, OSMElement[]>> {
  const escaped = names.map(escapeRegex).join("|");
  const q = `[out:json][timeout:60];
(
  way["name"~"^(${escaped})$"](${XUHUI_BBOX.south},${XUHUI_BBOX.west},${XUHUI_BBOX.north},${XUHUI_BBOX.east});
  way["name:zh"~"^(${escaped})$"](${XUHUI_BBOX.south},${XUHUI_BBOX.west},${XUHUI_BBOX.north},${XUHUI_BBOX.east});
);
out geom;`;

  for (const url of OVERPASS_MIRRORS) {
    try {
      const res = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "house-mapper/0.1",
          },
          body: `data=${encodeURIComponent(q)}`,
        },
        PER_REQ_TIMEOUT_MS,
      );
      if (!res.ok) {
        console.log(`    [mirror ${new URL(url).host}] HTTP ${res.status}`);
        continue;
      }
      const data = (await res.json()) as OverpassResp;
      const elems = (data.elements ?? []).filter((e) => e.geometry && e.geometry.length >= 3);

      const byName = new Map<string, OSMElement[]>();
      for (const e of elems) {
        const n = e.tags?.name ?? e.tags?.["name:zh"] ?? "";
        if (!n) continue;
        const list = byName.get(n) ?? [];
        list.push(e);
        byName.set(n, list);
      }
      console.log(`    [mirror ${new URL(url).host}] returned ${elems.length} ways → ${byName.size} unique names hit`);
      return byName;
    } catch (err) {
      console.log(`    [mirror ${new URL(url).host}] err: ${(err as Error).message}`);
    }
  }
  throw new Error("所有 Overpass 镜像都失败");
}

function osmToGeoJSON(elem: OSMElement): { type: "Polygon"; coordinates: number[][][] } | null {
  if (!elem.geometry || elem.geometry.length < 3) return null;
  const ring = elem.geometry.map((p) => [p.lon, p.lat] as [number, number]);
  // 确保闭合
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
  return { type: "Polygon", coordinates: [ring] };
}

/**
 * 一次拉指定 bbox 内所有 way[landuse=residential]，用于 by-location 模式
 */
async function fetchAllResidential(bbox: { south: number; west: number; north: number; east: number }): Promise<OSMElement[]> {
  const q = `[out:json][timeout:60];
way["landuse"="residential"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
out geom;`;
  for (const url of OVERPASS_MIRRORS) {
    try {
      const res = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "house-mapper/0.1" },
          body: `data=${encodeURIComponent(q)}`,
        },
        60_000,
      );
      if (!res.ok) {
        console.log(`    [mirror ${new URL(url).host}] HTTP ${res.status}`);
        continue;
      }
      const data = (await res.json()) as OverpassResp;
      const elems = (data.elements ?? []).filter((e) => e.geometry && e.geometry.length >= 3);
      console.log(`    [mirror ${new URL(url).host}] returned ${elems.length} residential ways in bbox`);
      return elems;
    } catch (err) {
      console.log(`    [mirror ${new URL(url).host}] err: ${(err as Error).message}`);
    }
  }
  throw new Error("所有 Overpass 镜像都失败");
}

async function processDistrict(districtFilter: string | null): Promise<{ hit: number; miss: number; targetCount: number }> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`处理 district=${districtFilter ?? "ALL"}`);
  console.log(`${"=".repeat(60)}`);

  // 拿出要查的 community 列表
  let targets;
  if (SCHOOL_ID != null) {
    targets = await db
      .selectDistinct({
        id: schema.communities.id,
        name: schema.communities.name,
        lng: schema.communities.lng,
        lat: schema.communities.lat,
        osmWayId: schema.communities.osmWayId,
      })
      .from(schema.communities)
      .innerJoin(
        schema.schoolCommunities,
        eq(schema.schoolCommunities.communityId, schema.communities.id),
      )
      .where(eq(schema.schoolCommunities.schoolId, SCHOOL_ID));
  } else if (districtFilter != null) {
    targets = await db
      .select({
        id: schema.communities.id,
        name: schema.communities.name,
        lng: schema.communities.lng,
        lat: schema.communities.lat,
        osmWayId: schema.communities.osmWayId,
      })
      .from(schema.communities)
      .where(eq(schema.communities.district, districtFilter));
  } else {
    targets = await db
      .select({
        id: schema.communities.id,
        name: schema.communities.name,
        lng: schema.communities.lng,
        lat: schema.communities.lat,
        osmWayId: schema.communities.osmWayId,
      })
      .from(schema.communities);
  }

  const initial = targets.length;
  if (!REFRESH) {
    targets = targets.filter((t) => !t.osmWayId);
  }
  console.log(`target communities: ${targets.length} (filter from ${initial}; ${initial - targets.length} 已有 osm_way_id 跳过)`);

  if (targets.length === 0) {
    return { hit: 0, miss: 0, targetCount: 0 };
  }

  let hit = 0;
  let miss = 0;

  if (MODE === "by-location") {
    // 先剔除跨区脏数据 (community 经纬度在上海市 bbox 外的)
    const inSH = targets.filter(
      (t) =>
        t.lng != null && t.lat != null &&
        t.lng >= SHANGHAI_BBOX.west && t.lng <= SHANGHAI_BBOX.east &&
        t.lat >= SHANGHAI_BBOX.south && t.lat <= SHANGHAI_BBOX.north,
    );
    const droppedOutOfSH = targets.length - inSH.length;
    const validPts = inSH as Array<{ lng: number; lat: number; [k: string]: unknown }>;
    if (droppedOutOfSH > 0) {
      console.log(`  ⚠️  剔除 ${droppedOutOfSH} 个跨上海市 bbox 的脏数据点`);
    }
    if (validPts.length === 0) {
      console.log("  ✗ 无有效 community 坐标，skip");
      return { hit: 0, miss: targets.length, targetCount: targets.length };
    }
    const PAD = 0.005;
    // 用 median 而不是 min/max 算 bbox，防 outlier。span 上限 15km
    const lats = validPts.map((p) => p.lat).sort((a, b) => a - b);
    const lngs = validPts.map((p) => p.lng).sort((a, b) => a - b);
    const medianLat = lats[Math.floor(lats.length / 2)];
    const medianLng = lngs[Math.floor(lngs.length / 2)];
    // 取 5-95 百分位作为 bbox 主体
    const p05 = (arr: number[]) => arr[Math.floor(arr.length * 0.05)];
    const p95 = (arr: number[]) => arr[Math.floor(arr.length * 0.95)];
    let bboxSouth = p05(lats) - PAD;
    let bboxNorth = p95(lats) + PAD;
    let bboxWest = p05(lngs) - PAD;
    let bboxEast = p95(lngs) + PAD;
    // span 上限 0.135° (~15km)
    const MAX_SPAN = 0.135;
    if (bboxNorth - bboxSouth > MAX_SPAN) {
      bboxSouth = medianLat - MAX_SPAN / 2;
      bboxNorth = medianLat + MAX_SPAN / 2;
    }
    if (bboxEast - bboxWest > MAX_SPAN) {
      bboxWest = medianLng - MAX_SPAN / 2;
      bboxEast = medianLng + MAX_SPAN / 2;
    }
    const dynBbox = { south: bboxSouth, north: bboxNorth, west: bboxWest, east: bboxEast };
    console.log(
      `  → by-location: bbox=(${dynBbox.south.toFixed(4)},${dynBbox.west.toFixed(4)})-(${dynBbox.north.toFixed(4)},${dynBbox.east.toFixed(4)}) ≈ ${((dynBbox.north - dynBbox.south) * 111).toFixed(1)}km × ${((dynBbox.east - dynBbox.west) * 111 * Math.cos((dynBbox.south * Math.PI) / 180)).toFixed(1)}km`,
    );
    let residentialWays: OSMElement[];
    try {
      residentialWays = await fetchAllResidential(dynBbox);
    } catch (err) {
      console.log(`  ✗ Overpass 失败: ${(err as Error).message}`);
      return { hit: 0, miss: targets.length, targetCount: targets.length };
    }
    type WayWithGeo = { elem: OSMElement; feature: Feature<Polygon>; areaM2: number };
    const ways: WayWithGeo[] = [];
    for (const elem of residentialWays) {
      const poly = osmToGeoJSON(elem);
      if (!poly) continue;
      const feature = turf.feature(poly);
      const areaM2 = turf.area(feature);
      ways.push({ elem, feature, areaM2 });
    }
    ways.sort((a, b) => a.areaM2 - b.areaM2);
    console.log(`  ${ways.length} 个有效 residential polygon（按面积升序）`);

    for (const c of targets) {
      if (c.lng == null || c.lat == null) {
        miss++;
        continue;
      }
      const pt = turf.point([c.lng, c.lat]);
      let matched: WayWithGeo | null = null;
      for (const w of ways) {
        if (turf.booleanPointInPolygon(pt, w.feature)) {
          matched = w;
          break;
        }
      }
      if (!matched) {
        miss++;
        continue;
      }
      const poly = osmToGeoJSON(matched.elem);
      if (!poly) {
        miss++;
        continue;
      }
      hit++;
      if (!DRY) {
        await db
          .update(schema.communities)
          .set({
            osmPolygon: poly,
            osmWayId: String(matched.elem.id),
            osmFetchedAt: TODAY,
          })
          .where(eq(schema.communities.id, c.id));
      }
    }
  } else {
    // by-name 模式
    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
      const slice = targets.slice(i, i + BATCH_SIZE);
      const names = slice.map((t) => t.name);
      console.log(`  batch [${i + 1}-${Math.min(i + BATCH_SIZE, targets.length)}/${targets.length}] 查 ${names.length} 个 name...`);

      let byName: Map<string, OSMElement[]>;
      try {
        byName = await batchQueryOverpass(names);
      } catch (err) {
        console.log(`  ✗ batch 失败: ${(err as Error).message}`);
        miss += slice.length;
        continue;
      }

      for (const c of slice) {
        const elems = byName.get(c.name);
        if (!elems || elems.length === 0) {
          miss++;
          continue;
        }
        elems.sort((a, b) => {
          const aa = a.bounds ? (a.bounds.maxlat - a.bounds.minlat) * (a.bounds.maxlon - a.bounds.minlon) : 0;
          const bb = b.bounds ? (b.bounds.maxlat - b.bounds.minlat) * (b.bounds.maxlon - b.bounds.minlon) : 0;
          return bb - aa;
        });
        const elem = elems[0];
        const poly = osmToGeoJSON(elem);
        if (!poly) {
          miss++;
          continue;
        }
        hit++;
        if (!DRY) {
          await db
            .update(schema.communities)
            .set({
              osmPolygon: poly,
              osmWayId: String(elem.id),
              osmFetchedAt: TODAY,
            })
            .where(eq(schema.communities.id, c.id));
        }
      }
    }
  }

  console.log(`  命中: ${hit} (${targets.length === 0 ? 0 : ((hit / targets.length) * 100).toFixed(1)}%)`);
  console.log(`  未命中: ${miss}`);
  return { hit, miss, targetCount: targets.length };
}

async function main() {
  console.log(`fetch-community-polygons: MODE=${MODE} SCHOOL_ID=${SCHOOL_ID ?? "ALL"} DISTRICT=${DISTRICT ?? (ALL_DISTRICTS ? "(all-districts)" : "default")} DRY=${DRY} REFRESH=${REFRESH}`);
  console.log(`Overpass mirrors: ${OVERPASS_MIRRORS.length}, batch=${BATCH_SIZE} names/req, timeout=${PER_REQ_TIMEOUT_MS}ms\n`);

  let totalHit = 0;
  let totalMiss = 0;
  let totalTargets = 0;

  if (ALL_DISTRICTS) {
    // 拿 DB 里所有 distinct district
    const rows = await db
      .selectDistinct({ district: schema.communities.district })
      .from(schema.communities);
    const districts = rows.map((r) => r.district).filter(Boolean);
    console.log(`扫描 ${districts.length} 个 distinct districts: ${districts.join(", ")}\n`);
    for (const d of districts) {
      const res = await processDistrict(d);
      totalHit += res.hit;
      totalMiss += res.miss;
      totalTargets += res.targetCount;
    }
  } else {
    const res = await processDistrict(DISTRICT);
    totalHit = res.hit;
    totalMiss = res.miss;
    totalTargets = res.targetCount;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`✓ Done.`);
  console.log(`  总命中: ${totalHit} (${totalTargets === 0 ? 0 : ((totalHit / totalTargets) * 100).toFixed(1)}%)`);
  console.log(`  总未命中: ${totalMiss}`);
  if (DRY) console.log(`  (--dry-run 模式，未实际写库)`);

  const totalWithOsm = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.communities)
    .where(or(sql`${schema.communities.osmWayId} IS NOT NULL`));
  console.log(`\n  DB 当前总共有 osm_polygon 的 community 数: ${totalWithOsm[0].n}`);

  process.exit(0);
}

main().catch((err) => {
  console.error("\n✗ FAILED:", (err as Error).message);
  process.exit(1);
});
