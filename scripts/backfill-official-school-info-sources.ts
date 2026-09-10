/** Register existing official school-info provenance into web_data_source.
 * Dry-run by default; pass --apply to commit. This only inserts/upserts source
 * rows derived from attrs.official_school_info_source and never changes schools.
 */
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const apply = process.argv.includes("--apply");

async function main() {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    const rows = await client.query<{
      id: number;
      name: string;
      district: string;
      source: Record<string, unknown>;
    }>(
      `
        SELECT id, name, district, attrs->'official_school_info_source' AS source
        FROM public.schools
        WHERE jsonb_typeof(attrs->'official_school_info_source') = 'object'
          AND coalesce(
            nullif(attrs->'official_school_info_source'->>'url', ''),
            nullif(attrs->'official_school_info_source'->>'source_url', '')
          ) IS NOT NULL
      `,
    );
    let upserted = 0;
    for (const row of rows.rows) {
      const source = row.source;
      const url = String(source.url ?? source.source_url ?? "");
      if (!url) continue;
      if (!apply) continue;
      await client.query(
        `
          INSERT INTO public.web_data_source(
            school_id, source_type, source_name, source_url, source_title, evidence,
            confidence, raw, fetched_at, updated_at
          )
          VALUES ($1, 'official_school_info', '上海市各区教育局/政府公开信息', $2, $3, $4, 'high', $5::jsonb, now(), now())
          ON CONFLICT (school_id, source_url, source_type)
          DO UPDATE SET source_title=excluded.source_title, evidence=excluded.evidence,
            confidence=excluded.confidence, raw=excluded.raw, fetched_at=excluded.fetched_at, updated_at=now()
        `,
        [
          row.id,
          url,
          String(source.name ?? source.source_title ?? "官方学校信息公示"),
          `官方学校信息公示匹配学校“${String(source.matched_name ?? row.name)}”，用于补充办学性质或地址。`,
          JSON.stringify({ district: row.district, school: row.name, source }),
        ],
      );
      upserted += 1;
    }
    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");
    const total = Number((await client.query("SELECT count(*)::int AS count FROM public.web_data_source")).rows[0].count);
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", candidates: rows.rows.length, upserted, sourcesTotal: total }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
