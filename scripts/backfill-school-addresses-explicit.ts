/**
 * Incrementally backfill reviewed school addresses from explicit official-source mappings.
 *
 * Safety rules:
 * - default mode is dry-run; pass --apply to write
 * - exports target snapshot and match report
 * - never overwrites nonblank address
 * - every UPDATE is guarded by id + district + name + blank address
 * - does not delete, truncate, seed, or touch school-community data
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

const { Client } = pg;

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const district = valueArg("--district");

type SchoolType = "primary" | "middle" | "nine_year";

type Mapping = {
  id: number;
  district: string;
  type?: SchoolType;
  name: string;
  address: string;
  matchedName: string;
  sourceTitle: string;
  sourceUrl: string;
  note?: string;
};

type SchoolRow = {
  id: number;
  district: string;
  type: SchoolType;
  name: string;
  address: string | null;
  attrs: Record<string, unknown> | null;
};

type ReportRow = {
  mapping: Mapping;
  school: SchoolRow | null;
  action: "dry-run" | "update" | "skip-district-filter" | "skip-not-found" | "skip-name-mismatch" | "skip-type-mismatch" | "skip-address-not-blank";
  updatedRows: number;
};

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1]?.trim();
  return undefined;
}

function outputPaths() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "explicit-school-address-backfill", stamp);
  mkdirSync(dir, { recursive: true });
  return {
    snapshot: path.join(dir, "target-schools-before.json"),
    report: path.join(dir, apply ? "matches-applied.json" : "matches-dry-run.json"),
  };
}

/** Official PDF extraction can insert spaces inside Chinese school names. */
export function normalizeSchoolIdentityName(value: string) {
  return value.replace(/[\s　]+/g, "").trim();
}

const sourcePath = valueArg("--source") ?? path.join(process.cwd(), "data", "explicit-school-addresses.json");

type SourceFile = {
  items?: Mapping[];
};

function loadMappings() {
  if (!existsSync(sourcePath)) throw new Error(`Source JSON not found: ${sourcePath}`);
  const source = JSON.parse(readFileSync(sourcePath, "utf8")) as SourceFile;
  return (source.items ?? []).filter(
    (item) => item.id && item.district && item.name?.trim() && item.address?.trim() && item.matchedName?.trim(),
  );
}

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const mappings = loadMappings();
    const activeMappings = district ? mappings.filter((item) => item.district === district) : mappings;
    const ids = activeMappings.map((item) => item.id);
    const paths = outputPaths();
    const reports: ReportRow[] = [];

    if (ids.length === 0) {
      writeFileSync(paths.snapshot, "[]\n", "utf8");
      writeFileSync(paths.report, "[]\n", "utf8");
      console.log(`No mappings${district ? ` for district=${district}` : ""}.`);
      return;
    }

    const snapshot = await client.query<SchoolRow>(
      `
        SELECT id, district, type, name, address, attrs
        FROM schools
        WHERE id = ANY($1::int[])
        ORDER BY district, id
      `,
      [ids],
    );
    writeFileSync(paths.snapshot, JSON.stringify(snapshot.rows, null, 2), "utf8");

    const byId = new Map(snapshot.rows.map((row) => [row.id, row]));
    console.log(`Mappings: ${activeMappings.length}${district ? ` (district=${district})` : ""}`);
    console.log(`Snapshot: ${paths.snapshot}`);
    console.log(`Mode: ${apply ? "apply" : "dry-run"}`);

    let updated = 0;
    await client.query("BEGIN");
    for (const mapping of mappings) {
      if (district && mapping.district !== district) {
        reports.push({ mapping, school: null, action: "skip-district-filter", updatedRows: 0 });
        continue;
      }

      const school = byId.get(mapping.id) ?? null;
      if (!school) {
        reports.push({ mapping, school, action: "skip-not-found", updatedRows: 0 });
        continue;
      }
      if (normalizeSchoolIdentityName(school.name) !== normalizeSchoolIdentityName(mapping.name) || school.district !== mapping.district) {
        reports.push({ mapping, school, action: "skip-name-mismatch", updatedRows: 0 });
        continue;
      }
      if (mapping.type && school.type !== mapping.type) {
        reports.push({ mapping, school, action: "skip-type-mismatch", updatedRows: 0 });
        continue;
      }
      if (school.address && school.address.trim()) {
        reports.push({ mapping, school, action: "skip-address-not-blank", updatedRows: 0 });
        continue;
      }

      console.log(`${apply ? "UPDATE" : "DRY"} id=${mapping.id} ${mapping.district} ${mapping.name} -> ${mapping.address}`);
      let updatedRows = 0;
      if (apply) {
        const result = await client.query(
          `
            UPDATE schools
            SET
              address = $1,
              attrs = jsonb_set(
                coalesce(attrs, '{}'::jsonb),
                '{official_school_address_source}',
                $2::jsonb,
                true
              ),
              updated_at = now()
            WHERE id = $3
              AND district = $4
              AND name = $5
              AND (address IS NULL OR btrim(address) = '')
          `,
          [
            mapping.address,
            JSON.stringify({
              source_title: mapping.sourceTitle,
              source_url: mapping.sourceUrl,
              matched_name: mapping.matchedName,
              note: mapping.note ?? null,
              collected_at: new Date().toISOString(),
            }),
            mapping.id,
            mapping.district,
            school.name,
          ],
        );
        updatedRows = result.rowCount ?? 0;
        updated += updatedRows;
      }
      reports.push({ mapping, school, action: apply ? "update" : "dry-run", updatedRows });
    }

    writeFileSync(paths.report, JSON.stringify(reports, null, 2), "utf8");
    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");
    console.log(`Report: ${paths.report}`);
    console.log(`Done. candidates=${activeMappings.length}, updated=${updated}, dryRun=${!apply}`);
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
