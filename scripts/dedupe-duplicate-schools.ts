/**
 * Dedupe duplicate-name schools that are xhs-flush phantom rows scattered across
 * the wrong districts. For each researched phantom group: keep ONE row in the
 * real district (correcting its district if needed), fill school_nature (and a
 * high-confidence address), and delete the other phantom rows. Also collapses
 * one exact-duplicate group (上海中学东校).
 *
 * Inputs: .tmp/dedupe/research_merged.json (name -> {real_district,nature,address,confidence,...})
 *         .tmp/dedupe/categories.json     (phantom / legit / exact lists)
 *
 * Safety: single transaction, dry-run by default (ROLLBACK), --apply to COMMIT.
 * Refuses to delete any row that is referenced by a FK (school_communities /
 * district_boundaries / policies). Writes an action report to .tmp/dedupe/.
 * A pg_dump backup already exists in .tmp/backups/ (see prior step).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

const { Client } = pg;
loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
// Names to skip entirely (noise / genuinely ambiguous same-name-different-district).
const SKIP = new Set(["浦东新区", "向阳小学"]);

type Research = {
  real_district: string;
  nature: string;
  address: string | null;
  confidence: string;
  real_full_name?: string;
};
type Row = { id: number; district: string; type: string; nature: string | null; address: string | null };

type Action = {
  name: string;
  keepId: number;
  updates: Record<string, string>;
  deleteIds: number[];
  note: string;
};

function load<T>(p: string): T {
  return JSON.parse(readFileSync(path.join(process.cwd(), p), "utf8")) as T;
}

async function main() {
  const research = load<Record<string, Research>>(".tmp/dedupe/research_merged.json");
  const cats = load<{ phantom: string[]; exact: string[] }>(".tmp/dedupe/categories.json");
  const dir = path.join(process.cwd(), ".tmp", "dedupe");
  mkdirSync(dir, { recursive: true });

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  const actions: Action[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];

  try {
    const rowsOf = async (name: string): Promise<Row[]> =>
      (
        await client.query<Row>(
          `SELECT id, district, type::text, school_nature::text AS nature, address
           FROM schools WHERE name = $1 ORDER BY id`,
          [name],
        )
      ).rows;

    const refCount = async (id: number): Promise<number> =>
      Number(
        (
          await client.query(
            `SELECT
               (SELECT count(*) FROM school_communities WHERE school_id=$1) +
               (SELECT count(*) FROM district_boundaries WHERE school_id=$1) +
               (SELECT count(*) FROM policies WHERE school_id=$1) AS c`,
            [id],
          )
        ).rows[0].c,
      );

    // ---- phantom groups ----
    for (const name of cats.phantom) {
      if (SKIP.has(name)) {
        skipped.push(name);
        continue;
      }
      const r = research[name];
      const rows = await rowsOf(name);
      if (!r || rows.length < 2) {
        warnings.push(`${name}: 无研究结果或行数<2，跳过`);
        continue;
      }
      if (r.nature === "unknown" && r.confidence === "low") {
        skipped.push(name);
        continue;
      }
      // pick keep row: prefer one already in the real district (lowest id), else lowest id overall
      const inReal = rows.filter((x) => x.district === r.real_district).sort((a, b) => a.id - b.id);
      const keep = inReal[0] ?? rows[0];
      const deleteIds = rows.filter((x) => x.id !== keep.id).map((x) => x.id);

      const updates: Record<string, string> = {};
      if (keep.district !== r.real_district) updates.district = r.real_district;
      if (!keep.nature && (r.nature === "公立" || r.nature === "私立")) updates.school_nature = r.nature;
      if (!keep.address && r.address && r.confidence === "high") updates.address = r.address;

      actions.push({
        name,
        keepId: keep.id,
        updates,
        deleteIds,
        note: `real=${r.real_district}/${r.nature} conf=${r.confidence}`,
      });
    }

    // ---- exact duplicate groups (same district & type) ----
    for (const name of cats.exact) {
      const rows = await rowsOf(name);
      if (rows.length < 2) continue;
      // keep the row with a non-null nature, else lowest id
      const keep = rows.find((x) => x.nature) ?? rows[0];
      const deleteIds = rows.filter((x) => x.id !== keep.id).map((x) => x.id);
      actions.push({ name, keepId: keep.id, updates: {}, deleteIds, note: "exact-dup collapse" });
    }

    // ---- FK safety check on every delete id ----
    for (const a of actions) {
      for (const id of a.deleteIds) {
        const refs = await refCount(id);
        if (refs > 0) {
          throw new Error(`待删行 id=${id} (${a.name}) 有 ${refs} 处外键引用，中止。需先处理引用。`);
        }
      }
    }

    const totalDeletes = actions.reduce((s, a) => s + a.deleteIds.length, 0);
    const totalUpdates = actions.filter((a) => Object.keys(a.updates).length > 0).length;
    const districtCorrections = actions.filter((a) => a.updates.district).length;

    writeFileSync(
      path.join(dir, "actions.json"),
      JSON.stringify({ actions, skipped, warnings }, null, 2),
      "utf8",
    );

    console.log(`Mode: ${apply ? "APPLY (COMMIT)" : "dry-run (ROLLBACK)"}`);
    console.log(`groups acted: ${actions.length} | deletes: ${totalDeletes} | row-updates: ${totalUpdates} | district-corrections: ${districtCorrections}`);
    console.log(`skipped (noise/ambiguous): ${skipped.join(", ") || "(none)"}`);
    if (warnings.length) console.log(`warnings:\n  ${warnings.join("\n  ")}`);
    console.log("\nsample actions:");
    for (const a of actions.slice(0, 12)) {
      console.log(`  ${a.name}: keep ${a.keepId} ${JSON.stringify(a.updates)} | del [${a.deleteIds.join(",")}] (${a.note})`);
    }

    // ---- apply in one transaction ----
    await client.query("BEGIN");
    for (const a of actions) {
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [k, v] of Object.entries(a.updates)) {
        params.push(v);
        sets.push(`${k} = $${params.length}${k === "school_nature" ? "::school_nature" : ""}`);
      }
      if (sets.length) {
        params.push(a.keepId);
        await client.query(`UPDATE schools SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length}`, params);
      }
      if (a.deleteIds.length) {
        await client.query(`DELETE FROM schools WHERE id = ANY($1::int[])`, [a.deleteIds]);
      }
    }

    const remainingDupes = Number(
      (await client.query(`SELECT count(*)::int c FROM (SELECT name FROM schools GROUP BY name HAVING count(*)>1) t`)).rows[0].c,
    );
    const totalSchools = Number((await client.query(`SELECT count(*)::int c FROM schools`)).rows[0].c);
    console.log(`\nafter: schools=${totalSchools}, remaining duplicate-name groups=${remainingDupes} (expect = legit同区对 + skipped)`);

    if (apply) {
      await client.query("COMMIT");
      console.log("COMMITTED.");
    } else {
      await client.query("ROLLBACK");
      console.log("ROLLED BACK (dry-run). Review .tmp/dedupe/actions.json, then re-run with --apply.");
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
