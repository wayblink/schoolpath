/** Publish public schools absent from catalog by stable legacy_id. */
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
    await client.query("begin");
    const before = await client.query<{ count: number }>(`select count(*)::int count from public.schools p where not exists (select 1 from catalog.schools c where c.legacy_id=p.id)`);
    const result = await client.query(`
      insert into catalog.schools
        (legacy_id, canonical_name, district_id, school_type, school_nature, tier, address, lat, lng, enrollment_note, attrs, source_status)
      select p.id, p.name, d.id, p.type::text, p.school_nature::text, p.tier, p.address, p.lat, p.lng, p.enrollment_note,
             coalesce(p.attrs, '{}'::jsonb) || jsonb_build_object('published_from_public_school_id', p.id), 'published_projection'
      from public.schools p
      join catalog.districts d on replace(d.canonical_name,'区','') = replace(p.district,'区','')
      where not exists (select 1 from catalog.schools c where c.legacy_id=p.id)
      on conflict (legacy_id) do nothing
    `);
    console.log(JSON.stringify({ candidates: before.rows[0].count, inserted: result.rowCount ?? 0, mode: apply ? "apply" : "dry-run" }));
    if (apply) await client.query("commit"); else await client.query("rollback");
  } catch (error) { await client.query("rollback"); throw error; }
  finally { await client.end(); }
}
main().catch((error) => { console.error(error); process.exit(1); });
