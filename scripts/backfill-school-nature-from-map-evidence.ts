/** Fill blank school_nature from strict, already-captured map POI evidence. */
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
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
const reportDir = path.join(process.cwd(), ".tmp", "school-nature-map-backfill", stamp);

type School = {
  id: number;
  name: string;
  district: string;
  type: "primary" | "middle" | "nine_year";
  address: string | null;
  school_nature: "公立" | "私立" | null;
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

function compact(value: string, district = "") {
  return value
    .replace(/[\s　]/g, "")
    .replace(/[（）()]/g, "")
    .replace(/^上海(?:市)?/, "")
    .replace(new RegExp(`^${district}(?:区)?`), "")
    .replace(/学校$/, "")
    .replace(/（小学部|初中部|中学部）|\(小学部\)|\(初中部\)|\(中学部\)/g, "")
    .replace(/^(?:民办|私立)/, "")
    .replace(/初级中学$/, "中学")
    .trim();
}

export function normalizeMapNature(value: string | null | undefined): "公立" | "私立" | null {
  const text = value?.trim() ?? "";
  const privateHit = /民办|私立/.test(text);
  const publicHit = /公办|公立/.test(text);
  if (privateHit === publicHit) return null;
  return privateHit ? "私立" : "公立";
}

function districtToken(district: string) {
  return district === "浦东" ? "浦东新区" : `${district}区`;
}

function stageCompatible(type: School["type"], poiType: string) {
  if (/高中|高级中学/.test(poiType)) return false;
  if (type === "primary") return /小学|九年一贯制学校/.test(poiType);
  if (type === "middle") return /中学|初中|九年一贯制学校|完全中学/.test(poiType);
  return /小学|中学|初中|九年一贯制学校|完全中学/.test(poiType);
}

export function eligibleMapNatureEvidence(school: Pick<School, "name" | "district" | "type" | "address" | "school_nature">, evidence: MapEvidence | null) {
  if (school.school_nature || !evidence || evidence.provider !== "baidu_browser") return false;
  const nature = normalizeMapNature(evidence.poi_name);
  if (!nature || !evidence.poi_name?.trim() || !evidence.poi_type?.trim()) return false;
  if (compact(school.name, school.district) !== compact(evidence.poi_name, school.district)) return false;
  if (!evidence.address?.includes(districtToken(school.district))) return false;
  if (!stageCompatible(school.type, evidence.poi_type)) return false;
  if (Number(evidence.score) < minScore) return false;
  return true;
}

async function main() {
  mkdirSync(reportDir, { recursive: true });
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    const rows = (await client.query<School>(`
      SELECT id,name,district,type,address,school_nature,attrs
      FROM public.schools
      WHERE school_nature IS NULL
      ORDER BY district,id
    `)).rows;
    const candidates = rows.filter((school) => eligibleMapNatureEvidence(
      school,
      (school.attrs?.baidu_browser_school_location_match as MapEvidence | undefined) ?? null,
    ));
    const actions: Array<Record<string, unknown>> = [];
    let updated = 0;
    for (const school of candidates) {
      const evidence = school.attrs!.baidu_browser_school_location_match as MapEvidence;
      const nature = normalizeMapNature(evidence.poi_name);
      const raw = {
        migration: "school_nature_from_map_evidence",
        school_id: school.id,
        school_name: school.name,
        district: school.district,
        school_type: school.type,
        normalized_nature: nature,
        provider: evidence.provider,
        poi_name: evidence.poi_name,
        poi_type: evidence.poi_type,
        address: evidence.address,
        score: evidence.score,
        uid: evidence.uid ?? null,
        fetched_at: evidence.fetched_at ?? null,
        rule: "blank nature + same district + normalized exact name + stage-compatible POI + explicit public/private label + score >= 270",
      };
      let action = "dry-run";
      if (apply && nature) {
        const result = await client.query(`
          UPDATE public.schools
          SET school_nature = $1::school_nature,
              attrs = jsonb_set(coalesce(attrs, '{}'::jsonb), '{map_school_nature_evidence}', $2::jsonb, true),
              updated_at = now()
          WHERE id = $3 AND school_nature IS NULL
          RETURNING id
        `, [nature, JSON.stringify(raw), school.id]);
        updated += result.rowCount ?? 0;
        if (result.rowCount) {
          const sourceUrl = `https://map.baidu.com/search/${encodeURIComponent(evidence.poi_name!)}`;
          await client.query(`
            INSERT INTO public.web_data_source(
              school_id,source_type,source_name,source_url,source_title,source_date,evidence,confidence,raw,fetched_at,created_at,updated_at
            ) VALUES ($1,'map_school_nature','百度地图浏览器检索',$2,$3,$4,$5,'medium',$6::jsonb,$7,now(),now())
            ON CONFLICT (school_id,source_url,source_type)
            DO UPDATE SET source_title=excluded.source_title,source_date=excluded.source_date,evidence=excluded.evidence,confidence=excluded.confidence,raw=excluded.raw,fetched_at=excluded.fetched_at,updated_at=now()
          `, [school.id, sourceUrl, evidence.poi_name, evidence.fetched_at?.slice(0, 10) ?? null, `百度地图同区、同名、同学段 POI 明确标注${nature === "私立" ? "民办/私立" : "公办/公立"}；仅用于补充空性质字段。`, JSON.stringify(raw), evidence.fetched_at ?? null]);
          action = "updated";
        } else action = "skipped_nonnull";
      }
      actions.push({ schoolId: school.id, schoolName: school.name, district: school.district, nature, poiName: evidence.poi_name, score: evidence.score, action, raw });
    }
    writeFileSync(path.join(reportDir, apply ? "backfill-applied.json" : "backfill-dry-run.json"), JSON.stringify({ mode: apply ? "apply" : "dry-run", minScore, targets: rows.length, candidates: candidates.length, updated, actions }, null, 2));
    if (apply) await client.query("COMMIT"); else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", minScore, targets: rows.length, candidates: candidates.length, updated, reportDir }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.endsWith("backfill-school-nature-from-map-evidence.ts")) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
