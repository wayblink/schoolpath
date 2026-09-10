/**
 * Verify school-community links when an official enrollment quote explicitly
 * contains the complete community or official enrollment-area name.
 *
 * Dry-run by default. Pass --apply to commit. This intentionally does not
 * infer a link from source_committee, feeder data, map proximity, or a short
 * road/land address such as `38弄`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const year = Number(valueArg("--year") ?? "2026");
const limit = Number(valueArg("--limit") ?? "0");

if (!Number.isInteger(year) || year <= 0) throw new Error("--year must be a positive integer.");
if (!Number.isInteger(limit) || limit < 0) throw new Error("--limit must be a non-negative integer.");

type LinkRow = {
  id: number;
  school_id: number;
  community_id: number;
  school_name: string;
  school_district: string;
  community_name: string;
  community_district: string;
  source_name: string | null;
  source_url: string | null;
  source_quote: string | null;
  verified: boolean;
  notes: string | null;
};

type Action = {
  id: number;
  schoolId: number;
  communityId: number;
  schoolName: string;
  schoolDistrict: string;
  communityName: string;
  sourceName: string | null;
  sourceUrl: string | null;
  sourceQuote: string | null;
  action: "dry-run-verify" | "verify" | "skip";
  reason?: string;
};

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

function outputDir() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "official-exact-community-verification", stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function normalize(value: string) {
  return value
    .replace(/[\s[:punct:]，。、；：！？（）()“”‘’《》【】]/g, "")
    .trim();
}

function isOfficialUrl(value: string | null) {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "shrxbm.edu.sh.gov.cn" || hostname.endsWith(".gov.cn");
  } catch {
    return false;
  }
}

function isOfficialSource(row: LinkRow) {
  const sourceName = row.source_name ?? "";
  return (
    (sourceName.startsWith("official_school_community_candidates:") ||
      sourceName === "official_pudong_junior_2025" ||
      sourceName === "official_baoshan_boundary_text") &&
    isOfficialUrl(row.source_url)
  );
}

function isResidentialName(value: string) {
  const name = normalize(value);
  if (name.length < 4) return false;
  if (/(小学|中学|学校|幼儿园|培训|居委|社区|街道|村民|村委|委员会|片区|地区|镇$|筹|部队|集体户口)/.test(name)) {
    return false;
  }
  // A suffix such as `一居/二居` is a committee sub-area, not a residential
  // entity, even when the parent project name looks residential.
  if (/[一二三四五六七八九十百]+居$/.test(name)) return false;
  // Road-boundary and bare address labels are kept as candidates for review;
  // they are not residential community names for automatic verification.
  if (/(路|街|公路)[0-9]+弄/.test(name) || /^(清河路|城中路|城东路|城南路|城北路|道路)/.test(name)) return false;
  if (/[路街公路]/.test(name) || /号|弄/.test(name)) return false;
  // Bare administrative villages are not residential projects. The two
  // explicit residential village forms seen in official boundary text are
  // names ending in `新村` or a numbered village such as `宝山一村`.
  const explicitResidentialVillage = /(?:新村|[一二三四五六七八九十百]+村)$/.test(name);
  return /(小区|公寓|花园|家园|苑|坊|里|城|府|湾|邸|庭)$/.test(name) || explicitResidentialVillage;
}

/**
 * Official boundary tables also name administrative residential areas such as
 * `某某社区`, `某某村` and `某某居委`. Those are valid catchment entities even
 * though they are not commercial residential projects. Keep this predicate
 * separate from isResidentialName so the latter remains conservative for UI
 * and geocoding use.
 */
function isExplicitOfficialAreaName(value: string) {
  const name = normalize(value);
  if (name.length < 3) return false;
  if (/(小学|中学|学校|幼儿园|培训|委员会|片区|地区|全区招生|开发区|旅游区|筹|部队|集体户口)/.test(name)) return false;
  if (/(路|街|公路)\d+弄/.test(name) || /^(清河路|城中路|城东路|城南路|城北路|道路)/.test(name)) return false;
  if (/[路街公路]\d*(号|弄)$/.test(name) || /^\d+(号|弄)$/.test(name)) return false;
  if (/(社区|居委会|居委|村民小组|中心村|新村|村)$/.test(name)) return true;
  return /(小区|公寓|花园|家园|苑|坊|里|城|府|湾|邸|庭)$/.test(name);
}

function quoteContainsCommunity(row: LinkRow) {
  if (!row.source_quote || !isExplicitOfficialAreaName(row.community_name)) return false;
  return normalize(row.source_quote).includes(normalize(row.community_name));
}

function reason(row: LinkRow) {
  if (row.school_district !== row.community_district) return "school/community district mismatch";
  if (!isOfficialSource(row)) return "non-official source";
  if (!isExplicitOfficialAreaName(row.community_name)) return "community name is not an explicit official enrollment-area entity";
  if (!quoteContainsCommunity(row)) return "official quote does not contain complete community name";
  return "official quote explicitly contains complete official enrollment-area name";
}

async function main() {
  const dir = outputDir();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const rows = await client.query<LinkRow>(
      `
        SELECT sc.id, sc.school_id, sc.community_id,
               s.name AS school_name, s.district AS school_district,
               c.name AS community_name, c.district AS community_district,
               sc.source_name, sc.source_url, sc.source_quote, sc.verified, sc.notes
        FROM school_communities sc
        JOIN schools s ON s.id = sc.school_id
        JOIN communities c ON c.id = sc.community_id
        WHERE sc.year = $1 AND sc.verified = false
        ORDER BY sc.id
        ${limit > 0 ? `LIMIT ${limit}` : ""}
      `,
      [year],
    );
    writeFileSync(path.join(dir, "links-source.json"), JSON.stringify(rows.rows, null, 2), "utf8");

    const actions: Action[] = rows.rows.map((row) => {
      const eligible = row.school_district === row.community_district && isOfficialSource(row) && quoteContainsCommunity(row);
      return {
        id: row.id,
        schoolId: row.school_id,
        communityId: row.community_id,
        schoolName: row.school_name,
        schoolDistrict: row.school_district,
        communityName: row.community_name,
        sourceName: row.source_name,
        sourceUrl: row.source_url,
        sourceQuote: row.source_quote,
        action: eligible ? (apply ? "verify" : "dry-run-verify") : "skip",
        reason: reason(row),
      };
    });
    writeFileSync(path.join(dir, apply ? "verification-applied.json" : "verification-dry-run.json"), JSON.stringify(actions, null, 2), "utf8");

    const eligible = rows.rows.filter((row) => row.school_district === row.community_district && isOfficialSource(row) && quoteContainsCommunity(row));
    await client.query("BEGIN");
    let verified = 0;
    if (apply) {
      for (const row of eligible) {
        const result = await client.query(
          `
            UPDATE school_communities
            SET verified = true,
                notes = concat_ws(E'\\n', notes, $2::text)
            WHERE id = $1 AND verified = false
          `,
          [
            row.id,
            `按官方原文精确包含完整住宅名称自动核验；来源=${row.source_name ?? ""}；核验时间=${new Date().toISOString()}`,
          ],
        );
        verified += result.rowCount ?? 0;
      }
    }
    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");

    const bySource = new Map<string, number>();
    const byDistrict = new Map<string, number>();
    for (const row of eligible) {
      bySource.set(row.source_name ?? "(null)", (bySource.get(row.source_name ?? "(null)") ?? 0) + 1);
      byDistrict.set(row.school_district, (byDistrict.get(row.school_district) ?? 0) + 1);
    }
    const summary = {
      mode: apply ? "apply" : "dry-run",
      year,
      scanned: rows.rows.length,
      eligible: eligible.length,
      verified,
      skipped: rows.rows.length - eligible.length,
      bySource: Object.fromEntries(bySource),
      byDistrict: Object.fromEntries(byDistrict),
      reportDir: dir,
    };
    writeFileSync(path.join(dir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

export { isExplicitOfficialAreaName, isOfficialSource, isResidentialName, normalize, quoteContainsCommunity };
