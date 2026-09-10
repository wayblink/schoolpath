/** Apply only strictly reviewed, exact school-location matches from a dry-run report. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const sourceReport = valueArg("--source");
const minScore = Number(valueArg("--min-score") ?? "300");
const provider = valueArg("--provider");
if (!sourceReport || !existsSync(sourceReport)) throw new Error("--source must point to an existing dry-run report.");
if (!Number.isFinite(minScore) || minScore < 300) throw new Error("--min-score must be at least 300.");
if (!provider || !new Set(["amap", "tencent", "baidu_browser"]).has(provider)) {
  throw new Error("--provider must be amap, tencent, or baidu_browser.");
}

type School = {
  id: number;
  name: string;
  district: string;
  address: string | null;
  lng: number | null;
  lat: number | null;
};

type Match = {
  poiId: string;
  poiName: string;
  poiType: string;
  address: string;
  lat: number;
  lng: number;
  score: number;
};

type SourceRecord = { school: School; match: Match | null; action: string };
type Action = {
  schoolId: number;
  name: string;
  district: string;
  score: number | null;
  action: "dry-run" | "updated" | "skip";
  reason?: string;
};

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

function districtAddressToken(district: string) {
  return district === "浦东" ? "上海市浦东新区" : `上海市${district}区`;
}

function shanghaiInRange(lng: number, lat: number) {
  return lng >= 120.85 && lng <= 122.15 && lat >= 30.65 && lat <= 31.9;
}

function roadTokens(value: string | null) {
  if (!value) return [];
  return [...value.matchAll(/[\u4e00-\u9fff]{2,}(?:路|街|道|巷|弄)/g)].map((match) => match[0]);
}

function addressSupportsSameDistrict(school: School, match: Match) {
  if (match.address.includes(districtAddressToken(school.district))) return true;
  // Some AMap POI responses omit the district prefix. For an exact school
  // name, a shared road token with the catalog address is sufficient to keep
  // the identity and location evidence tied to the same campus.
  const schoolRoads = new Set(roadTokens(school.address));
  return roadTokens(match.address).some((road) => schoolRoads.has(road));
}

function eligibility(record: SourceRecord) {
  const { school, match } = record;
  if (!match) return "missing POI match";
  if (match.score < minScore) return `score ${match.score} is below ${minScore}`;
  if (match.poiName !== school.name) return "POI name is not an exact match";
  if (!addressSupportsSameDistrict(school, match)) return "POI address is outside the target district";
  if (!shanghaiInRange(match.lng, match.lat)) return "coordinates are outside Shanghai bounds";
  return null;
}

function outputPaths() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "reviewed-school-location-apply", stamp);
  mkdirSync(dir, { recursive: true });
  return {
    snapshot: path.join(dir, "target-schools-before.json"),
    report: path.join(dir, apply ? "apply-report.json" : "dry-run-report.json"),
  };
}

async function main() {
  const parsed = JSON.parse(readFileSync(sourceReport!, "utf8")) as SourceRecord[];
  const uniqueRecords = [...new Map(parsed.map((record) => [record.school.id, record])).values()];
  const eligible = uniqueRecords.filter((record) => eligibility(record) === null);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const paths = outputPaths();

  try {
    const ids = eligible.map((record) => record.school.id);
    const current = ids.length
      ? await client.query<School>("SELECT id,name,district,address,lng,lat FROM schools WHERE id = ANY($1::int[]) ORDER BY id", [ids])
      : { rows: [] as School[] };
    writeFileSync(paths.snapshot, JSON.stringify(current.rows, null, 2), "utf8");
    const currentById = new Map(current.rows.map((row) => [row.id, row]));
    const actions: Action[] = [];
    let updated = 0;

    await client.query("BEGIN");
    for (const record of uniqueRecords) {
      const reason = eligibility(record);
      if (reason) {
        actions.push({ schoolId: record.school.id, name: record.school.name, district: record.school.district, score: record.match?.score ?? null, action: "skip", reason });
        continue;
      }

      const match = record.match!;
      const row = currentById.get(record.school.id);
      if (!row || row.name !== record.school.name || row.district !== record.school.district) {
        actions.push({ schoolId: record.school.id, name: record.school.name, district: record.school.district, score: match.score, action: "skip", reason: "database identity does not match report" });
        continue;
      }
      if (row.address?.trim() && row.lng != null && row.lat != null) {
        actions.push({ schoolId: row.id, name: row.name, district: row.district, score: match.score, action: "skip", reason: "location already complete" });
        continue;
      }

      if (apply) {
        const evidence = JSON.stringify({
          provider,
          source:
            provider === "amap"
              ? "amap_place_text"
              : provider === "tencent"
                ? "tencent_place_search"
                : "baidu_map_browser_search",
          source_report: path.resolve(sourceReport!),
          poi_id: match.poiId,
          poi_name: match.poiName,
          poi_type: match.poiType,
          address: match.address,
          score: match.score,
          fetched_at: new Date().toISOString(),
          filled: { address: !row.address?.trim(), lat: row.lat == null, lng: row.lng == null },
        });
        const result = await client.query(
          `UPDATE schools
           SET address = CASE WHEN address IS NULL OR btrim(address) = '' THEN $1 ELSE address END,
               lat = CASE WHEN lat IS NULL THEN $2 ELSE lat END,
               lng = CASE WHEN lng IS NULL THEN $3 ELSE lng END,
               attrs = jsonb_set(coalesce(attrs, '{}'::jsonb), '{school_location_match}', $4::jsonb, true),
               updated_at = now()
           WHERE id = $5 AND name = $6 AND district = $7
             AND (address IS NULL OR btrim(address) = '' OR lat IS NULL OR lng IS NULL)`,
          [match.address, match.lat, match.lng, evidence, row.id, row.name, row.district],
        );
        updated += result.rowCount ?? 0;
      }
      actions.push({ schoolId: row.id, name: row.name, district: row.district, score: match.score, action: apply ? "updated" : "dry-run" });
    }

    writeFileSync(paths.report, JSON.stringify({ mode: apply ? "apply" : "dry-run", sourceReport: path.resolve(sourceReport!), provider, minScore, eligible: eligible.length, updated, actions }, null, 2), "utf8");
    if (apply) await client.query("COMMIT"); else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", sourceReport: path.resolve(sourceReport!), provider, minScore, candidates: uniqueRecords.length, eligible: eligible.length, planned: actions.filter((action) => action.action === "dry-run").length, updated, skipped: actions.filter((action) => action.action === "skip").length, report: paths.report }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
