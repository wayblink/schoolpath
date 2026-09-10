/**
 * Promote official candidates whose extracted community name exactly matches
 * one existing community in the same district.
 *
 * This is deliberately narrower than committee matching: it never treats a
 * boundary description, address range, street, or ambiguous name as a link.
 * Dry-run is the default; pass --apply to commit the transaction.
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
const district = valueArg("--district");
const limit = Number(valueArg("--limit") ?? "0");
const statuses = listArg("--status", ["pending"]);
const confidences = listArg("--confidence", ["high", "medium"]);
const candidateIdValues = listArg("--candidate-id", []);
const candidateIds = candidateIdValues.map((value) => Number(value));

if (!Number.isInteger(year) || year < 2000) throw new Error("--year must be a valid year.");
if (!Number.isInteger(limit) || limit < 0) throw new Error("--limit must be a non-negative integer.");
if (candidateIds.some((value) => !Number.isInteger(value) || value <= 0)) {
  throw new Error("--candidate-id must contain positive integer IDs.");
}

type Candidate = {
  id: number;
  school_id: number;
  district: string;
  school_name_raw: string;
  community_name_raw: string;
  committee_name_raw: string | null;
  source_url: string | null;
  source_title: string;
  source_date: string | null;
  source_quote: string;
  confidence: string;
  raw: Record<string, unknown> | null;
};

type Community = { id: number; district: string; name: string };
type ExistingLink = { school_id: number; community_id: number; year: number };

type Action = {
  candidateId: number;
  schoolId: number;
  schoolName: string;
  district: string;
  candidateName: string;
  normalizedName: string;
  communityId: number | null;
  communityName: string | null;
  action: "dry-run-insert" | "insert" | "skip-existing-link" | "skip-ambiguous" | "skip-invalid-name";
  reason?: string;
  sourceTitle: string;
  sourceUrl: string | null;
  sourceQuote: string;
};

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

function listArg(name: string, fallback: string[]) {
  const value = valueArg(name);
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : fallback;
}

function normalizeCommunityName(value: string) {
  return value
    .replace(/[\s\u00a0]/g, "")
    .replace(/[（）()【】\[\]]/g, "")
    .replace(/(社区居委会|居民委员会|居委会|居委|居民区)$/g, "")
    .trim();
}

function isResidentialCommunityName(value: string) {
  const normalized = normalizeCommunityName(value);
  if (normalized.length < 2 || normalized.length > 40) return false;
  if (/(小学|中学|学校|幼儿园|培训|居委|社区|街道|村民|村委|委员会|片区|地区|开发区|镇$|筹|部队|集体户口)/.test(normalized)) return false;
  if (/[路街公路]/.test(normalized) || /号|弄/.test(normalized)) return false;
  if (/^(统筹|待定|其他|无|合计|总计)$/.test(normalized)) return false;
  return /(小区|公寓|花园|家园|苑|坊|里|城|府|湾|邸|庭)$/.test(normalized) || /(?:新村|[一二三四五六七八九十百]+村)$/.test(normalized);
}

function outputDir() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "direct-community-candidate-promotion", stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function main() {
  const dir = outputDir();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const candidates = await client.query<Candidate>(
      `SELECT id, school_id, district, school_name_raw, community_name_raw, committee_name_raw,
              source_url, source_title, source_date, source_quote, confidence, raw
       FROM public.school_community_candidates
       WHERE year = $1 AND school_id IS NOT NULL
         AND status = ANY($2) AND confidence = ANY($3)
         AND ($4::text IS NULL OR district = $4)
         AND ($5::int[] IS NULL OR id = ANY($5::int[]))
         AND COALESCE((raw->>'boundaryOnly')::boolean, false) = false
       ORDER BY district, id ${limit > 0 ? `LIMIT ${limit}` : ""}`,
      [year, statuses, confidences, district ?? null, candidateIds.length ? candidateIds : null],
    );
    const communities = await client.query<Community>(
      `SELECT id, district, name FROM public.communities
       WHERE ($1::text IS NULL OR district = $1) ORDER BY district, id`,
      [district ?? null],
    );
    const links = await client.query<ExistingLink>(
      `SELECT sc.school_id, sc.community_id, sc.year
       FROM public.school_communities sc JOIN public.schools s ON s.id = sc.school_id
       WHERE sc.year = $1 AND ($2::text IS NULL OR s.district = $2)`,
      [year, district ?? null],
    );
    const schools = await client.query<{ id: number; name: string }>(
      `SELECT id, name FROM public.schools WHERE ($1::text IS NULL OR district = $1)`,
      [district ?? null],
    );
    const schoolNames = new Map(schools.rows.map((school) => [school.id, school.name]));
    const communitiesByKey = new Map<string, Community[]>();
    for (const community of communities.rows) {
      const key = `${community.district}|${normalizeCommunityName(community.name)}`;
      communitiesByKey.set(key, [...(communitiesByKey.get(key) ?? []), community]);
    }
    const existing = new Set(links.rows.map((link) => `${link.school_id}:${link.community_id}:${link.year}`));
    const actions: Action[] = [];
    const promoted = new Set<number>();
    let inserted = 0;
    let wouldInsert = 0;

    await client.query("BEGIN");
    for (const candidate of candidates.rows) {
      const normalizedName = normalizeCommunityName(candidate.community_name_raw);
      const base = {
        candidateId: candidate.id,
        schoolId: candidate.school_id,
        schoolName: schoolNames.get(candidate.school_id) ?? candidate.school_name_raw,
        district: candidate.district,
        candidateName: candidate.community_name_raw,
        normalizedName,
        sourceTitle: candidate.source_title,
        sourceUrl: candidate.source_url,
        sourceQuote: candidate.source_quote,
      };
      if (!isResidentialCommunityName(candidate.community_name_raw)) {
        actions.push({ ...base, communityId: null, communityName: null, action: "skip-invalid-name", reason: "名称为边界、道路、地址范围或占位文本" });
        continue;
      }
      const matches = communitiesByKey.get(`${candidate.district}|${normalizedName}`) ?? [];
      if (matches.length !== 1) {
        actions.push({ ...base, communityId: null, communityName: null, action: "skip-ambiguous", reason: matches.length ? `同区同名小区 ${matches.length} 条` : "同区没有规范化同名小区" });
        continue;
      }
      const community = matches[0];
      const key = `${candidate.school_id}:${community.id}:${year}`;
      if (existing.has(key)) {
        promoted.add(candidate.id);
        actions.push({ ...base, communityId: community.id, communityName: community.name, action: "skip-existing-link" });
        continue;
      }
      if (!apply) {
        wouldInsert += 1;
        actions.push({ ...base, communityId: community.id, communityName: community.name, action: "dry-run-insert" });
        continue;
      }
      const result = await client.query<{ id: number }>(
        `INSERT INTO public.school_communities(
           school_id, community_id, committee_name, year, source_name, source_url,
           source_quote, source_date, verified, notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9)
         ON CONFLICT (school_id, community_id, year) DO NOTHING RETURNING id`,
        [
          candidate.school_id,
          community.id,
          candidate.committee_name_raw ?? candidate.community_name_raw,
          year,
          "official_school_community_candidates:direct-name",
          candidate.source_url,
          candidate.source_quote,
          candidate.source_date ?? String(year),
          `官方候选 #${candidate.id} 与同区既有小区名称唯一相等；关系保留为未核验。`,
        ],
      );
      if (result.rows[0]) {
        inserted += 1;
        existing.add(key);
        promoted.add(candidate.id);
        actions.push({ ...base, communityId: community.id, communityName: community.name, action: "insert" });
      } else {
        actions.push({ ...base, communityId: community.id, communityName: community.name, action: "skip-existing-link" });
      }
    }
    if (apply && promoted.size) {
      await client.query(
        `UPDATE public.school_community_candidates
         SET status = 'promoted',
             review_notes = concat_ws(E'\\n', review_notes, $2::text), updated_at = now()
         WHERE id = ANY($1) AND status = ANY($3::text[]) AND year = $4 AND school_id IS NOT NULL`,
        [[...promoted], `direct-name promotion ${new Date().toISOString()}; relation remains unverified.`, statuses, year],
      );
    }
    const report = path.join(dir, apply ? "promotion-applied.json" : "promotion-dry-run.json");
    writeFileSync(report, JSON.stringify({ mode: apply ? "apply" : "dry-run", year, district: district ?? null, statuses, confidences, candidateIds: candidateIds.length ? candidateIds : null, candidates: candidates.rows.length, planned: actions.filter((a) => a.action === "dry-run-insert" || a.action === "insert").length, inserted, wouldInsert, report, actions }, null, 2));
    if (apply) await client.query("COMMIT"); else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", year, district: district ?? null, candidateIds: candidateIds.length ? candidateIds : null, candidates: candidates.rows.length, planned: actions.filter((a) => a.action === "dry-run-insert" || a.action === "insert").length, inserted, wouldInsert, promotedCandidates: promoted.size, report }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
