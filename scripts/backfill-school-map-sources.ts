/** Register strict, already-captured Baidu map evidence for schools without sources. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const minScore = Number(valueArg("--min-score") ?? "270");
if (!Number.isFinite(minScore) || minScore < 270) throw new Error("--min-score must be at least 270.");

type School = {
  id: number;
  name: string;
  district: string;
  type: string;
  address: string | null;
  attrs: Record<string, unknown> | null;
};

type MapEvidence = {
  provider?: string;
  poi_name?: string;
  poi_type?: string;
  address?: string;
  score?: number;
  uid?: string;
  fetched_at?: string;
};

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

export function normalizeMapSchoolName(value: string) {
  return value
    .replace(/[\s　]/g, "")
    .replace(/[（）()]/g, "")
    .replace(/^上海(?:市)?/, "")
    .replace(/^民办/, "")
    .replace(/学校$/, "")
    .replace(/（初中部|中学部|小学部）|\(初中部\)|\(中学部\)|\(小学部\)/g, "")
    .replace(/初级中学$/, "中学")
    .trim();
}

function districtToken(district: string) {
  return district === "浦东" ? "浦东新区" : `${district}区`;
}

function isMiddlePoi(type: string) {
  return /中学|初中|九年一贯制学校|完全中学/.test(type) && !/高中|高级中学/.test(type);
}

function hasCampusAmbiguity(name: string, type: string) {
  return /校区|分校|分部|附属/.test(name) || /校区|分校|分部/.test(type);
}

export function eligibleSchoolMapSource(school: School, evidence: MapEvidence | null) {
  if (!evidence || evidence.provider !== "baidu_browser") return false;
  if (school.type !== "middle") return false;
  if (!evidence.poi_name?.trim() || normalizeMapSchoolName(school.name) !== normalizeMapSchoolName(evidence.poi_name)) return false;
  if (!evidence.address?.includes(districtToken(school.district))) return false;
  if (!isMiddlePoi(evidence.poi_type ?? "") || hasCampusAmbiguity(evidence.poi_name, evidence.poi_type ?? "")) return false;
  if (Number(evidence.score) < minScore) return false;
  return true;
}

function reportDir() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "school-map-source-backfill", stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function main() {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const dir = reportDir();
  try {
    const rows = (await client.query<School>(`
      SELECT s.id, s.name, s.district, s.type, s.address, s.attrs
      FROM public.schools s
      WHERE NOT EXISTS (SELECT 1 FROM public.web_data_source w WHERE w.school_id = s.id)
      ORDER BY s.district, s.id
    `)).rows;
    const candidates = rows.filter((school) => eligibleSchoolMapSource(
      school,
      (school.attrs?.baidu_browser_school_location_match as MapEvidence | undefined) ?? null,
    ));
    writeFileSync(path.join(dir, "candidates.json"), JSON.stringify(candidates, null, 2), "utf8");
    const actions: Array<Record<string, unknown>> = [];
    let upserted = 0;
    await client.query("BEGIN");
    for (const school of candidates) {
      const evidence = school.attrs!.baidu_browser_school_location_match as MapEvidence;
      const sourceUrl = `https://map.baidu.com/search/${encodeURIComponent(evidence.poi_name!)}`;
      const raw = {
        migration: "strict_school_map_source_backfill",
        school_id: school.id,
        school_name: school.name,
        district: school.district,
        provider: evidence.provider,
        poi_name: evidence.poi_name,
        poi_type: evidence.poi_type,
        address: evidence.address,
        score: evidence.score,
        uid: evidence.uid ?? null,
        fetched_at: evidence.fetched_at ?? null,
        rule: "same district + normalized exact school name + middle-school POI + score >= 270 + no campus marker",
      };
      if (apply) {
        const result = await client.query(`
          INSERT INTO public.web_data_source(
            school_id, source_type, source_name, source_url, source_title,
            source_date, evidence, confidence, raw, fetched_at, created_at, updated_at
          ) VALUES ($1, 'map', '百度地图浏览器检索', $2, $3, $4, $5, 'high', $6::jsonb, $7, now(), now())
          ON CONFLICT (school_id, source_url, source_type)
          DO UPDATE SET source_title=excluded.source_title, source_date=excluded.source_date,
            evidence=excluded.evidence, confidence=excluded.confidence, raw=excluded.raw,
            fetched_at=excluded.fetched_at, updated_at=now()
          RETURNING id
        `, [school.id, sourceUrl, evidence.poi_name, evidence.fetched_at?.slice(0, 10) ?? null,
          `百度地图同区中学 POI 与学校名称严格归一化一致，检索得分 ${evidence.score}。`, JSON.stringify(raw), evidence.fetched_at ?? null]);
        upserted += result.rowCount ?? 0;
      }
      actions.push({ schoolId: school.id, schoolName: school.name, district: school.district, poiName: evidence.poi_name, score: evidence.score, action: apply ? "upsert" : "dry-run", sourceUrl });
    }
    writeFileSync(path.join(dir, apply ? "backfill-applied.json" : "backfill-dry-run.json"), JSON.stringify({ mode: apply ? "apply" : "dry-run", minScore, targets: rows.length, candidates: candidates.length, upserted, actions }, null, 2), "utf8");
    if (apply) await client.query("COMMIT"); else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", minScore, targets: rows.length, candidates: candidates.length, upserted, reportDir: dir }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.endsWith("backfill-school-map-sources.ts")) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
