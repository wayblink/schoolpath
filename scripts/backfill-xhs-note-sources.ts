/** Register original XHS note-id provenance for schools that have no source row.
 *
 * Dry-run is the default; pass --apply to commit. This migration only inserts
 * provenance rows and never changes school fields or school-community links.
 */
import pg from "pg";
import { pathToFileURL } from "node:url";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const apply = process.argv.includes("--apply");

const NOTE_ID = /^[0-9a-f]{24}$/i;

export function noteUrl(value: unknown) {
  if (typeof value !== "string") return null;
  const noteId = value.trim();
  return NOTE_ID.test(noteId) ? `https://www.xiaohongshu.com/explore/${noteId}` : null;
}

type SchoolRow = {
  id: number;
  name: string;
  district: string;
  tier: string | null;
  xhs_first_note: string | null;
  xhs_last_note: string | null;
  xhs_first_query: string | null;
  xhs_last_query: string | null;
};

function planSources(row: SchoolRow) {
  const notes = [
    ["attrs.xhs_first_note", row.xhs_first_note, row.xhs_first_query],
    ["attrs.xhs_last_note", row.xhs_last_note, row.xhs_last_query],
  ] as const;
  const plans = new Map<string, Record<string, unknown>>();
  for (const [provenance, note, query] of notes) {
    const url = noteUrl(note);
    if (!url || plans.has(url)) continue;
    plans.set(url, {
      schoolId: row.id,
      schoolName: row.name,
      district: row.district,
      tier: row.tier,
      noteId: note?.trim(),
      query: query ?? null,
      provenance,
    });
  }
  return [...plans.entries()].map(([url, raw]) => ({ url, raw }));
}

async function main() {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    const rows = (await client.query<SchoolRow>(`
      SELECT s.id, s.name, s.district, s.tier,
             nullif(trim(s.attrs->>'xhs_first_note'), '') AS xhs_first_note,
             nullif(trim(s.attrs->>'xhs_last_note'), '') AS xhs_last_note,
             nullif(trim(s.attrs->>'xhs_first_query'), '') AS xhs_first_query,
             nullif(trim(s.attrs->>'xhs_last_query'), '') AS xhs_last_query
      FROM public.schools s
      WHERE NOT EXISTS (SELECT 1 FROM public.web_data_source w WHERE w.school_id = s.id)
      ORDER BY s.district, s.id
    `)).rows;
    const plans = rows.flatMap((row) => planSources(row).map((plan) => ({ row, ...plan })));
    let inserted = 0;
    for (const plan of plans) {
      const raw = plan.raw as Record<string, unknown>;
      const result = await client.query(
        `INSERT INTO public.web_data_source(
           school_id, source_type, source_name, source_url, source_title,
           evidence, confidence, raw, fetched_at, created_at, updated_at
         ) VALUES ($1, 'third_party_tier', '小红书 XHS', $2, $3, $4, 'medium', $5::jsonb, now(), now(), now())
         ON CONFLICT (school_id, source_url, source_type) DO NOTHING
         RETURNING id`,
        [
          plan.row.id,
          plan.url,
          `小红书梯队检索笔记（${String(raw.query ?? "未记录查询")})`,
          `原始采集记录通过 note_id 匹配学校“${plan.row.name}”（${plan.row.district}），仅作第三方梯队参考，不代表官方招生或学区结论。`,
          JSON.stringify({ migration: "xhs_note_source_registration", ...raw }),
        ],
      );
      inserted += result.rowCount ?? 0;
    }
    const sourcesTotal = Number((await client.query("SELECT count(*)::int AS count FROM public.web_data_source")).rows[0].count);
    if (apply) await client.query("COMMIT"); else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", schools: rows.length, candidates: plans.length, inserted, sourcesTotal }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
