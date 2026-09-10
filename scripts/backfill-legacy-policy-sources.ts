/**
 * Promote legacy attrs.policy_url/data_source into web_data_source.
 *
 * Dry-run is the default; pass --apply to commit. This migration only adds
 * provenance rows and never changes schools or school-community relations.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");

type SchoolRow = {
  id: number;
  name: string;
  district: string;
  policy_url: string;
  data_source: string;
  enrollment_note: string | null;
  school_nature: string | null;
};

type Action = {
  schoolId: number;
  schoolName: string;
  district: string;
  sourceUrl: string;
  sourceName: string;
  sourceTitle: string;
  action: "insert" | "dry-run" | "skip-existing";
};

function outputDir() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "legacy-policy-sources", stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sourceName(dataSource: string) {
  return dataSource.replace(/\s*20\d{2}.*$/, "").trim() || "历史招生资料";
}

async function main() {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const dir = outputDir();
  try {
    const schools = await client.query<SchoolRow>(`
      SELECT id, name, district,
             nullif(trim(attrs->>'policy_url'), '') AS policy_url,
             nullif(trim(attrs->>'data_source'), '') AS data_source,
             enrollment_note, school_nature::text AS school_nature
      FROM public.schools
      WHERE nullif(trim(attrs->>'policy_url'), '') IS NOT NULL
        AND nullif(trim(attrs->>'data_source'), '') IS NOT NULL
      ORDER BY district, id
    `);
    const actions: Action[] = [];
    await client.query("BEGIN");
    let upserted = 0;

    for (const school of schools.rows) {
      const name = sourceName(school.data_source);
      const title = `${school.district}区历史招生政策资料`;
      const evidence = `来源从学校 legacy attrs.policy_url/data_source 提升；原始来源标记：${school.data_source}`;
      const raw = JSON.stringify({
        migration: "legacy_policy_source",
        legacy_policy_url: school.policy_url,
        legacy_data_source: school.data_source,
        school_name: school.name,
      });
      const result = await client.query<{ id: number }>(
        `
          INSERT INTO public.web_data_source(
            school_id, source_type, source_name, source_url, source_title,
            source_date, evidence, confidence, raw, fetched_at, created_at, updated_at
          )
          VALUES ($1, 'third_party_directory', $2, $3, $4, $5, $6, 'medium', $7::jsonb, now(), now(), now())
          ON CONFLICT (school_id, source_url, source_type) DO NOTHING
          RETURNING id
        `,
        [school.id, name, school.policy_url, title, school.data_source.match(/20\d{2}/)?.[0] ?? null, evidence, raw],
      );
      const action = result.rowCount ? (apply ? "insert" : "dry-run") : "skip-existing";
      if (apply) upserted += result.rowCount ?? 0;
      actions.push({
        schoolId: school.id,
        schoolName: school.name,
        district: school.district,
        sourceUrl: school.policy_url,
        sourceName: name,
        sourceTitle: title,
        action,
      });
    }

    writeFileSync(path.join(dir, apply ? "backfill-applied.json" : "backfill-dry-run.json"), JSON.stringify(actions, null, 2), "utf8");
    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", candidates: schools.rowCount, upserted, report: dir }, null, 2));
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
