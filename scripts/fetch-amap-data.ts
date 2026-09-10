/**
 * 高德 REST API 数据丰富脚本：
 * 1. 拉徐汇区 + 13 个街道的官方 polygon → data/streets/xuhui.geojson
 * 2. 地理编码 schools.json 里每所学校的地址 → 替换 lat/lng
 * 3. 列出所有 matching_committees 居委名 → 报告需手画的数量
 *
 * 用法：
 *   NEXT_PUBLIC_AMAP_KEY=xxx pnpm tsx scripts/fetch-amap-data.ts
 *
 * 高德 key 必须开启"Web 服务"平台（不是 JS API），在 console.amap.com 编辑 key 添加。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

// Load .env.local manually (tsx doesn't auto-load like Next.js does)
const envPath = path.join(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const KEY = process.env.NEXT_PUBLIC_AMAP_KEY ?? process.env.AMAP_KEY;
if (!KEY) {
  console.error("✗ Missing NEXT_PUBLIC_AMAP_KEY in env. Did you fill .env.local?");
  process.exit(1);
}

const BASE = "https://restapi.amap.com/v3";

type AmapResp = { status: string; info: string; infocode?: string; [k: string]: unknown };

async function call(endpoint: string, params: Record<string, string>): Promise<AmapResp> {
  const url = new URL(`${BASE}/${endpoint}`);
  url.searchParams.set("key", KEY!);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const data = (await res.json()) as AmapResp;
  if (data.status !== "1") {
    const code = data.infocode ?? "unknown";
    const info = data.info ?? "unknown";
    if (code === "10009" || info.includes("USERKEY_PLAT_NOMATCH")) {
      throw new Error(
        `高德 REST API 拒绝：你的 key 还没开启 "Web 服务" 平台。\n` +
        `→ 打开 https://console.amap.com/dev/key/app 编辑这个 key，"服务平台" 勾选 "Web 服务" 后保存。\n` +
        `→ 然后重跑这个脚本。`,
      );
    }
    throw new Error(`AMap API ${endpoint} failed: ${info} (code=${code})`);
  }
  return data;
}

// 高德 polyline 格式: "lng,lat;lng,lat;...|ring2|ring3"
function polylineToPolygons(polyline: string): number[][][][] {
  if (!polyline) return [];
  const polygons: number[][][][] = [];
  for (const ringStr of polyline.split("|")) {
    const ring: number[][] = ringStr
      .split(";")
      .filter(Boolean)
      .map((pair) => pair.split(",").map(Number) as [number, number]);
    if (ring.length >= 3) polygons.push([ring]);
  }
  return polygons;
}

async function fetchStreets() {
  console.log("\n[1/3] Fetching 徐汇区 + 街道 polygons...");
  const data = await call("config/district", {
    keywords: "徐汇区",
    subdistrict: "2",
    extensions: "all",
    showbiz: "false",
  });
  const root = (data.districts as Array<Record<string, unknown>>)[0];
  if (!root) {
    console.error("  ✗ no district returned");
    return;
  }

  const features: unknown[] = [];

  // 徐汇区本身
  const xhPolygons = polylineToPolygons((root.polyline as string) ?? "");
  for (const poly of xhPolygons) {
    features.push({
      type: "Feature",
      properties: {
        name: root.name,
        adcode: root.adcode,
        level: root.level,
        center: root.center,
      },
      geometry: { type: "Polygon", coordinates: poly },
    });
  }

  // 子级行政区（街道）
  const subs = (root.districts as Array<Record<string, unknown>>) ?? [];
  let streetCount = 0;
  for (const sub of subs) {
    // sub 可能还有 districts (子街道下的居委)，但通常居委级 polyline 为空
    const subPolygons = polylineToPolygons((sub.polyline as string) ?? "");
    for (const poly of subPolygons) {
      features.push({
        type: "Feature",
        properties: {
          name: sub.name,
          adcode: sub.adcode,
          level: sub.level,
          center: sub.center,
        },
        geometry: { type: "Polygon", coordinates: poly },
      });
    }
    if (subPolygons.length > 0) streetCount++;
    else console.log(`  ⚠️  ${sub.name} 无 polyline 数据`);
  }

  const fc = { type: "FeatureCollection", features };
  const outDir = path.join(process.cwd(), "data", "streets");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "xuhui.geojson");
  writeFileSync(outPath, JSON.stringify(fc, null, 2), "utf-8");
  console.log(`  ✓ saved ${features.length} features (1 区 + ${streetCount} 街道) → ${outPath}`);
}

type SchoolJson = {
  name: string;
  address?: string;
  lat?: number;
  lng?: number;
  attrs?: { matching_committees?: string[]; [k: string]: unknown };
  [k: string]: unknown;
};

async function geocodeSchools() {
  console.log("\n[2/3] Geocoding school addresses...");
  const schoolsPath = path.join(process.cwd(), "data", "schools.json");
  const schools: SchoolJson[] = JSON.parse(readFileSync(schoolsPath, "utf-8"));

  let updated = 0;
  let skipped = 0;
  for (const s of schools) {
    if (!s.address) {
      console.log(`  - ${s.name}: 无 address，跳过`);
      skipped++;
      continue;
    }
    // 用学校名 + 上海徐汇 提高准确度
    const query = `上海市徐汇区${s.address}`;
    try {
      const data = await call("geocode/geo", { address: query, city: "上海" });
      const geocodes = data.geocodes as Array<{ location: string; formatted_address: string }>;
      if (geocodes && geocodes.length > 0) {
        const [lng, lat] = geocodes[0].location.split(",").map(Number);
        const dLat = Math.abs((s.lat ?? 0) - lat);
        const dLng = Math.abs((s.lng ?? 0) - lng);
        const drift = Math.sqrt(dLat * dLat + dLng * dLng);
        s.lat = lat;
        s.lng = lng;
        const driftLabel = drift > 0.01 ? `⚠️ 漂移 ${(drift * 111).toFixed(0)} km` : `✓ 微调`;
        console.log(`  ${driftLabel}  ${s.name}  → (${lat.toFixed(5)}, ${lng.toFixed(5)})`);
        updated++;
      } else {
        console.log(`  ⚠️  ${s.name}: 地理编码无结果（${query}）`);
      }
    } catch (err) {
      console.error(`  ✗ ${s.name}: ${(err as Error).message}`);
    }
    // 限频
    await new Promise((r) => setTimeout(r, 200));
  }

  writeFileSync(schoolsPath, JSON.stringify(schools, null, 2), "utf-8");
  console.log(`  ✓ updated ${updated} schools, skipped ${skipped} → ${schoolsPath}`);
}

async function reportCommittees() {
  console.log("\n[3/3] 居委清单（高德 REST API 不提供居委级 polygon，必须手画）");
  const schoolsPath = path.join(process.cwd(), "data", "schools.json");
  const schools: SchoolJson[] = JSON.parse(readFileSync(schoolsPath, "utf-8"));

  const all = new Set<string>();
  const bySchool: Array<{ school: string; committees: string[] }> = [];
  for (const s of schools) {
    const list = s.attrs?.matching_committees ?? [];
    bySchool.push({ school: s.name, committees: list });
    for (const c of list) all.add(c.replace(/（部分）/g, "").trim());
  }

  for (const item of bySchool) {
    console.log(`  ${item.school} (${item.committees.length})`);
    console.log(`    ${item.committees.join("、")}`);
  }

  console.log(`\n  唯一居委总数: ${all.size}`);
  console.log(`  → 这些需要在 https://geojson.io 上按 真实街道边界 + 教育局原文 手画 polygon`);
  console.log(`  → 街道 polygon 已就位 (data/streets/xuhui.geojson)，可以叠在底图上作为辅助参考`);
}

async function main() {
  console.log(`高德 REST API 数据丰富脚本`);
  console.log(`KEY: ${KEY?.slice(0, 8)}...${KEY?.slice(-4)} (length=${KEY?.length})`);

  await fetchStreets();
  await geocodeSchools();
  await reportCommittees();

  console.log("\n✓ Done. 下一步：");
  console.log("  1. 写专门的 PostgreSQL 增量更新脚本，只更新本次核验出的 lat/lng 字段");
  console.log("  2. 更新前备份并核对影响行数，禁止用 seed 重灌库");
  console.log("  3. 手画居委 polygon（参考街道边界 + 教育局原文）");
}

main().catch((err) => {
  console.error("\n✗ FAILED:", (err as Error).message);
  process.exit(1);
});
