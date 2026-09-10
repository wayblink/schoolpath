/**
 * 从每个学校的对口小区点位算"学区外框" polygon，覆盖 district_boundaries 表里的占位矩形。
 *
 * 算法（Approach A）：
 *   1. 拉每校的 community 点 (lng, lat)
 *   2. 过滤异常点（不在徐汇核心区的）—— 防 3 个错位居委污染
 *   3. 对每个点做 BUFFER_M 米 buffer 成圆
 *   4. union 所有圆 → MultiPolygon / Polygon
 *   5. simplify 平滑（容忍 ~10m）
 *   6. upsert 进 district_boundaries（同 school_id + year，覆盖之前的占位矩形）
 *
 * 用法：
 *   pnpm tsx scripts/build-school-hulls.ts             # 真跑灌库
 *   pnpm tsx scripts/build-school-hulls.ts --dry-run   # 只打印面积/点数，不写库
 *
 * 调优：
 *   BUFFER_M  单点 buffer 半径（米）。120 是经验值（小区核心半径 50-80m + 缓冲），
 *             太大会糊住相邻居委，太小会出现孤岛
 *   SIMPLIFY_TOLERANCE  化简容忍度（度），0.0001 度 ≈ 10m
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { eq, and, inArray } from "drizzle-orm";
import * as turf from "@turf/turf";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import { db, schema } from "../lib/db/client";

const envPath = path.join(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const DRY = process.argv.includes("--dry-run");
const ALL_DISTRICTS = process.argv.includes("--all-districts");
const districtArg = process.argv.find((a) => a.startsWith("--district"));
const DISTRICT_FILTER = districtArg
  ? ((districtArg.split("=")[1] ?? process.argv[process.argv.indexOf(districtArg) + 1] ?? "").trim() || null)
  : null;
const BUFFER_M = Number(process.env.BUFFER_M ?? "120");
const SIMPLIFY_TOLERANCE = Number(process.env.SIMPLIFY_TOLERANCE ?? "0.0001");
// 上海市 bbox 用来剔除脏数据点 (跨上海市的)
const SHANGHAI_BBOX = {
  minLng: 120.85,
  maxLng: 122.05,
  minLat: 30.65,
  maxLat: 31.90,
};

function isInShanghai(lng: number | null, lat: number | null): boolean {
  if (lng == null || lat == null) return false;
  return (
    lng >= SHANGHAI_BBOX.minLng &&
    lng <= SHANGHAI_BBOX.maxLng &&
    lat >= SHANGHAI_BBOX.minLat &&
    lat <= SHANGHAI_BBOX.maxLat
  );
}

async function main() {
  console.log(`build-school-hulls 算法=buffer+union+simplify`);
  console.log(`BUFFER_M=${BUFFER_M}  SIMPLIFY_TOLERANCE=${SIMPLIFY_TOLERANCE}  DRY=${DRY}`);
  console.log(`上海市 bbox 过滤: ${SHANGHAI_BBOX.minLng}-${SHANGHAI_BBOX.maxLng}, ${SHANGHAI_BBOX.minLat}-${SHANGHAI_BBOX.maxLat}\n`);

  // 决定 districts 范围
  let targetDistricts: string[];
  if (DISTRICT_FILTER) {
    targetDistricts = [DISTRICT_FILTER];
  } else if (ALL_DISTRICTS) {
    const rows = await db
      .selectDistinct({ district: schema.schools.district })
      .from(schema.schools);
    targetDistricts = rows.map((r) => r.district).filter(Boolean);
  } else {
    targetDistricts = ["徐汇"];
  }
  console.log(`处理 ${targetDistricts.length} 个 district: ${targetDistricts.join(", ")}\n`);

  const schools = await db
    .select()
    .from(schema.schools)
    .where(inArray(schema.schools.district, targetDistricts));
  console.log(`schools: ${schools.length}\n`);

  let writeOk = 0;
  let skip = 0;

  for (const school of schools) {
    const points = await db
      .select({
        lng: schema.communities.lng,
        lat: schema.communities.lat,
        name: schema.communities.name,
        osmPolygon: schema.communities.osmPolygon,
      })
      .from(schema.schoolCommunities)
      .innerJoin(
        schema.communities,
        eq(schema.schoolCommunities.communityId, schema.communities.id),
      )
      .where(
        and(
          eq(schema.schoolCommunities.schoolId, school.id),
          eq(schema.schoolCommunities.year, 2025),
        ),
      );

    if (points.length === 0) {
      console.log(`  ⏭  ${school.name}: 0 communities，跳过`);
      skip++;
      continue;
    }

    const total = points.length;
    const inXuhui = points.filter((p) => isInShanghai(p.lng, p.lat));
    const filteredOut = total - inXuhui.length;

    if (inXuhui.length === 0) {
      console.log(`  ⏭  ${school.name}: ${total} points 全部在徐汇 bbox 外，跳过`);
      skip++;
      continue;
    }

    // 优先用 OSM 真实 polygon，缺则用点 + 120m buffer 兜底
    const polysWithOsm = inXuhui.filter((p) => p.osmPolygon != null);
    const polysWithBuffer = inXuhui.filter((p) => p.osmPolygon == null);

    const features: Feature<Polygon>[] = [];
    for (const p of polysWithOsm) {
      features.push(turf.feature(p.osmPolygon as Polygon));
    }
    for (const p of polysWithBuffer) {
      const buf = turf.buffer(turf.point([p.lng!, p.lat!]), BUFFER_M, { units: "meters" });
      if (buf) features.push(buf as Feature<Polygon>);
    }
    const featureCollection = turf.featureCollection(features);

    // union 所有圆
    let unioned: Feature<Polygon | MultiPolygon> | null;
    try {
      unioned = turf.union(featureCollection as never);
    } catch (err) {
      console.log(`  ✗ ${school.name}: union 失败 - ${(err as Error).message}`);
      skip++;
      continue;
    }
    if (!unioned) {
      console.log(`  ✗ ${school.name}: union 返回 null`);
      skip++;
      continue;
    }

    // simplify 平滑
    const simplified = turf.simplify(unioned, {
      tolerance: SIMPLIFY_TOLERANCE,
      highQuality: false,
    });

    const areaKm2 = turf.area(simplified) / 1_000_000;
    const geomType = simplified.geometry.type;
    const ringCount =
      geomType === "Polygon"
        ? (simplified.geometry as Polygon).coordinates.length
        : (simplified.geometry as MultiPolygon).coordinates.length;

    console.log(
      `  ✓ ${school.name}: ${total} pts (${inXuhui.length} 在徐汇, 过滤 ${filteredOut}; OSM真实 ${polysWithOsm.length} / buffer兜底 ${polysWithBuffer.length}) → ${geomType} (${ringCount} ring${ringCount > 1 ? "s" : ""}), 面积 ${areaKm2.toFixed(2)} km²`,
    );

    if (DRY) continue;

    // 删除该 school + year 的旧 boundary，写入新的
    await db
      .delete(schema.districtBoundaries)
      .where(
        and(
          eq(schema.districtBoundaries.schoolId, school.id),
          eq(schema.districtBoundaries.year, 2025),
        ),
      );

    await db.insert(schema.districtBoundaries).values({
      schoolId: school.id,
      year: 2025,
      geojson: simplified.geometry,
      notes: `auto-generated; ${polysWithOsm.length} OSM 真实 polygon + ${polysWithBuffer.length} buffer(${BUFFER_M}m) 兜底 + union + simplify(tol=${SIMPLIFY_TOLERANCE}); 源 ${total} community(过滤后 ${inXuhui.length})`,
    });
    writeOk++;
  }

  console.log(`\n✓ Done. 写入 ${writeOk}，跳过 ${skip}`);
  if (DRY) console.log(`  (--dry-run 模式，未实际写库)`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\n✗ FAILED:", (err as Error).message);
  console.error((err as Error).stack);
  process.exit(1);
});
