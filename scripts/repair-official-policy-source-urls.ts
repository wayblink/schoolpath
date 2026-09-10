/** Repair local file:// provenance for official policy cache rows.
 *
 * The cache filename is a deterministic copy of the official enrollment URL.
 * Dry-run is the default; pass --apply to commit. No school fields are changed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";
import { inferCachedSourceUrl } from "./backfill-official-policy-cache";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");

function reportDir() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "repair-official-policy-source-urls", stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

type Row = {
  id: number;
  school_id: number;
  school_name: string;
  source_url: string | null;
  source_title: string | null;
  file: string | null;
};

async function main() {
  const dir = reportDir();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const rows = (await client.query<Row>(`
      SELECT wd.id, wd.school_id, s.name AS school_name, wd.source_url, wd.source_title,
             wd.raw->>'file' AS file
      FROM public.web_data_source wd
      JOIN public.schools s ON s.id = wd.school_id
      WHERE wd.source_type = 'official_admission'
        AND wd.raw->>'migration' = 'official_policy_cache'
        AND wd.source_url LIKE 'file://%'
      ORDER BY wd.id
    `)).rows;
    const actions = rows.map((row) => {
      const officialUrl = row.file ? inferCachedSourceUrl(path.basename(row.file)) : null;
      return {
        id: row.id,
        schoolId: row.school_id,
        schoolName: row.school_name,
        sourceTitle: row.source_title,
        oldUrl: row.source_url,
        officialUrl,
        action: officialUrl ? (apply ? "update" : "dry-run-update") : "skip-unrecognized-cache-file",
      };
    });
    let updated = 0;
    await client.query("BEGIN");
    if (apply) {
      for (const action of actions.filter((item) => item.officialUrl)) {
        const result = await client.query(
          `UPDATE public.web_data_source
           SET source_url = $1, raw = jsonb_set(coalesce(raw, '{}'::jsonb), '{official_url}', to_jsonb($1::text), true), updated_at = now()
           WHERE id = $2 AND source_url LIKE 'file://%'`,
          [action.officialUrl, action.id],
        );
        updated += result.rowCount ?? 0;
      }
    }
    writeFileSync(path.join(dir, apply ? "repair-applied.json" : "repair-dry-run.json"), JSON.stringify({ mode: apply ? "apply" : "dry-run", scanned: rows.length, eligible: actions.filter((item) => item.officialUrl).length, updated, actions }, null, 2));
    if (apply) await client.query("COMMIT"); else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", scanned: rows.length, eligible: actions.filter((item) => item.officialUrl).length, updated, report: dir }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
