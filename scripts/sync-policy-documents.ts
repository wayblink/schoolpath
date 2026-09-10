/**
 * Synchronize policy rows added to public.policies into the layered
 * catalog.policy_documents projection.
 *
 * Dry-run is the default; pass --apply to commit. The public row id is the
 * durable identity, so this operation cannot duplicate a policy document.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

type PolicyRow = {
  id: number;
  school_id: number | null;
  district: string | null;
  scope: string;
  year: number;
  title: string;
  source_url: string | null;
  content: string;
  change_summary: string | null;
  fetched_at: string | null;
};

type Action = PolicyRow & {
  districtId: number | null;
  catalogSchoolId: number | null;
  action: "insert" | "dry-run" | "skip-existing" | "skip-no-district";
};

function outputDir() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "policy-document-sync", stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const client = new pg.Client({ connectionString: databaseUrl });
  const dir = outputDir();
  await client.connect();
  let inserted = 0;
  const actions: Action[] = [];

  try {
    await client.query("BEGIN");
    const { rows } = await client.query<PolicyRow>(`
      SELECT p.id, p.school_id, p.district, p.scope::text, p.year, p.title,
             p.source_url, p.content, p.change_summary, p.fetched_at::text
      FROM public.policies p
      LEFT JOIN catalog.policy_documents target ON target.legacy_id = p.id
      WHERE target.id IS NULL
      ORDER BY p.id
    `);

    for (const policy of rows) {
      const districtResult = policy.district
        ? await client.query<{ id: number }>("SELECT id FROM catalog.districts WHERE canonical_name = $1", [policy.district])
        : { rows: [] as { id: number }[] };
      const districtId = districtResult.rows[0]?.id ?? null;
      if (!districtId) {
        actions.push({ ...policy, districtId, catalogSchoolId: null, action: "skip-no-district" });
        continue;
      }

      const schoolResult = policy.school_id
        ? await client.query<{ id: number }>("SELECT id FROM catalog.schools WHERE legacy_id = $1", [policy.school_id])
        : { rows: [] as { id: number }[] };
      const catalogSchoolId = schoolResult.rows[0]?.id ?? null;

      if (apply) {
        const result = await client.query(
          `INSERT INTO catalog.policy_documents
             (legacy_id, school_id, district_id, scope, year, title, source_url, content, change_summary, fetched_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (legacy_id) DO UPDATE SET
             school_id=excluded.school_id, district_id=excluded.district_id,
             scope=excluded.scope, year=excluded.year, title=excluded.title,
             source_url=excluded.source_url, content=excluded.content,
             change_summary=excluded.change_summary, fetched_at=excluded.fetched_at
           RETURNING id`,
          [policy.id, catalogSchoolId, districtId, policy.scope, policy.year, policy.title, policy.source_url, policy.content, policy.change_summary, policy.fetched_at],
        );
        inserted += result.rowCount ?? 0;
      }
      actions.push({ ...policy, districtId, catalogSchoolId, action: apply ? "insert" : "dry-run" });
    }

    writeFileSync(path.join(dir, apply ? "sync-applied.json" : "sync-dry-run.json"), JSON.stringify(actions, null, 2), "utf8");
    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", candidates: rows.length, eligible: actions.filter((action) => action.action === "insert" || action.action === "dry-run").length, skippedNoDistrict: actions.filter((action) => action.action === "skip-no-district").length, inserted, report: dir }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
