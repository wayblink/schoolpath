/**
 * Fill blank enrollment notes from reviewed official Pudong 2026 relation imports.
 *
 * The note is intentionally compact: complete community names remain in the
 * relation table, while the school record only states the evidenced count and
 * review status. Dry-run is the default; pass --apply to commit.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const OFFICIAL_SOURCES = new Set([
  "official_pudong_primary_2026",
  "official_pudong_middle_2026",
  "official_pudong_junior_2025",
]);

type OfficialCommunityGroup = {
  schoolId: number;
  schoolName: string;
  district: string;
  year: number;
  communityCount: number;
  relationIds: number[];
  sourceNames: string[];
  sourceUrls: string[];
  sourceQuotes: string[];
};

export function isOfficialPudongCommunitySource(sourceName: string) {
  return OFFICIAL_SOURCES.has(sourceName);
}

export function buildOfficialCommunityEnrollmentNote(input: {
  district: string;
  year: number;
  communityCount: number;
}) {
  if (!Number.isInteger(input.communityCount) || input.communityCount <= 0) return "";
  const district = input.district === "浦东" ? "浦东新区" : `${input.district}区`;
  return `${input.year}年${district}官方招生地段公示已收录${input.communityCount}个对应小区；完整对应关系见学校小区明细。关系由官方附件结构化导入，当前待人工复核。`;
}

function reportDir() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "official-community-enrollment-notes", stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const dir = reportDir();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    const groups = (await client.query<OfficialCommunityGroup>(`
      SELECT s.id AS "schoolId", s.name AS "schoolName", s.district,
             max(sc.year)::int AS year,
             count(DISTINCT sc.community_id)::int AS "communityCount",
             array_agg(DISTINCT sc.id ORDER BY sc.id) AS "relationIds",
             array_agg(DISTINCT sc.source_name ORDER BY sc.source_name) AS "sourceNames",
             array_agg(DISTINCT sc.source_url ORDER BY sc.source_url)
               FILTER (WHERE nullif(btrim(sc.source_url), '') IS NOT NULL) AS "sourceUrls",
             array_agg(DISTINCT sc.source_quote ORDER BY sc.source_quote)
               FILTER (WHERE nullif(btrim(sc.source_quote), '') IS NOT NULL) AS "sourceQuotes"
        FROM public.schools s
        JOIN public.school_communities sc ON sc.school_id = s.id
       WHERE s.district = '浦东'
         AND (s.enrollment_note IS NULL OR btrim(s.enrollment_note) = '')
         AND sc.source_name IN ('official_pudong_primary_2026', 'official_pudong_middle_2026', 'official_pudong_junior_2025')
         AND nullif(btrim(sc.source_url), '') IS NOT NULL
       GROUP BY s.id, s.name, s.district
       ORDER BY s.id
    `)).rows;
    const actions: Array<Record<string, unknown>> = [];
    let schoolsUpdated = 0;
    let catalogUpdated = 0;
    let sourcesUpserted = 0;
    for (const group of groups) {
      const note = buildOfficialCommunityEnrollmentNote(group);
      const raw = {
        migration: "official_pudong_community_links_to_enrollment_note",
        school_id: group.schoolId,
        school_name: group.schoolName,
        district: group.district,
        source_year: group.year,
        community_count: group.communityCount,
        relation_ids: group.relationIds,
        source_names: group.sourceNames,
        source_urls: group.sourceUrls,
        relation_verified: false,
      };
      if (apply) {
        const updated = await client.query(
          `UPDATE public.schools
              SET enrollment_note = $1,
                  attrs = jsonb_set(coalesce(attrs, '{}'::jsonb), '{official_community_enrollment_note}', $2::jsonb, true),
                  updated_at = now()
            WHERE id = $3 AND (enrollment_note IS NULL OR btrim(enrollment_note) = '')
            RETURNING id`,
          [note, JSON.stringify(raw), group.schoolId],
        );
        schoolsUpdated += updated.rowCount ?? 0;
        if (updated.rowCount) {
          const catalog = await client.query(
            `UPDATE catalog.schools
                SET enrollment_note = $1,
                    attrs = jsonb_set(coalesce(attrs, '{}'::jsonb), '{official_community_enrollment_note}', $2::jsonb, true),
                    updated_at = now()
              WHERE legacy_id = $3 AND (enrollment_note IS NULL OR btrim(enrollment_note) = '')`,
            [note, JSON.stringify(raw), group.schoolId],
          );
          catalogUpdated += catalog.rowCount ?? 0;
          for (const sourceUrl of group.sourceUrls ?? []) {
            const source = await client.query(
              `INSERT INTO public.web_data_source(
                 school_id, source_type, source_name, source_url, source_title,
                 source_date, evidence, confidence, raw, fetched_at, created_at, updated_at
               ) VALUES ($1, 'official_admission', '上海市浦东新区教育局', $2,
                         $3, '2026', $4, 'high', $5::jsonb, now(), now(), now())
               ON CONFLICT (school_id, source_url, source_type) DO UPDATE SET
                 source_name = excluded.source_name,
                 source_title = excluded.source_title,
                 source_date = excluded.source_date,
                 evidence = excluded.evidence,
                 confidence = excluded.confidence,
                 raw = excluded.raw,
                 fetched_at = now(), updated_at = now()
               RETURNING id`,
              [group.schoolId, sourceUrl, `${group.schoolName} 2026年官方招生地段`, group.sourceQuotes?.[0] ?? note, JSON.stringify(raw)],
            );
            sourcesUpserted += source.rowCount ?? 0;
          }
        }
      }
      actions.push({
        schoolId: group.schoolId,
        schoolName: group.schoolName,
        communityCount: group.communityCount,
        sourceUrls: group.sourceUrls,
        note,
        action: apply ? "updated" : "dry-run",
      });
    }
    const summary = {
      mode: apply ? "apply" : "dry-run",
      candidates: groups.length,
      schoolsUpdated,
      catalogUpdated,
      sourcesUpserted,
      report: dir,
    };
    writeFileSync(
      path.join(dir, apply ? "backfill-applied.json" : "backfill-dry-run.json"),
      JSON.stringify({ ...summary, actions }, null, 2),
      "utf8",
    );
    if (apply) await client.query("COMMIT"); else await client.query("ROLLBACK");
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
