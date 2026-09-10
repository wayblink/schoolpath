/**
 * Expand short school names from official district school-info records.
 *
 * Safety rules:
 * - dry-run by default; pass --apply to write
 * - no deletes, no merges
 * - only updates schools where char_length(name) <= 5
 * - moves the previous short name into aliases
 * - never overwrites an existing non-blank address
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

const { Client } = pg;

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const sourcePath =
  valueArg("--source") ?? path.join(process.cwd(), "data", "audit", "official-school-info", "latest.json");
const minScore = numberArg("--min-score") ?? 230;
const district = valueArg("--district");
const auditLogPath =
  valueArg("--audit-log") ?? path.join(process.cwd(), "data", "audit", "school-data-audit-log.jsonl");
const outDir = path.join(
  process.cwd(),
  "data",
  "audit",
  "official-short-name-audited-apply",
  new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-"),
);

type SchoolRow = {
  id: number;
  name: string;
  district: string;
  type: "primary" | "middle" | "nine_year";
  aliases: string[] | null;
  address: string | null;
  school_nature: "公立" | "私立" | null;
  attrs: Record<string, unknown> | null;
};

type SourceRecord = {
  district: string;
  stage: "primary" | "middle" | "unknown";
  name: string;
  nature: string;
  address: string;
  sourceTitle: string;
  sourceUrl: string;
};

type SourceFile = {
  generatedAt: string;
  records: SourceRecord[];
};

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1]?.trim();
  return undefined;
}

function numberArg(name: string) {
  const raw = valueArg(name);
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number.`);
  return parsed;
}

function compactName(value: string) {
  return value
    .replace(/^上海市/, "")
    .replace(/[\s　·•\-—()（）]/g, "")
    .replace(/（.*?）|\(.*?\)/g, "")
    .trim();
}

function compactAddress(value: string | null | undefined) {
  return (value ?? "")
    .replace(/^上海市/, "")
    .replace(/区/g, "")
    .replace(/[\s　,，;；()（）]/g, "")
    .trim();
}

function typeMatches(school: SchoolRow, record: SourceRecord) {
  if (record.stage === "unknown") return true;
  if (school.type === "nine_year") return true;
  return school.type === record.stage;
}

function normalizeNature(value: string | null | undefined): "公立" | "私立" | null {
  if (!value) return null;
  if (value.includes("民办")) return "私立";
  if (value.includes("公办") || value.includes("公立")) return "公立";
  return null;
}

function scoreCandidate(school: SchoolRow, record: SourceRecord) {
  if (school.district !== record.district || !typeMatches(school, record)) return -100;
  const shortName = compactName(school.name);
  const officialName = compactName(record.name);
  if (!shortName || !officialName || officialName.length <= shortName.length) return -100;
  let score = 0;
  if (officialName.includes(shortName)) score = 230;
  if (compactAddress(school.address) && compactAddress(record.address)) {
    const a = compactAddress(school.address);
    const b = compactAddress(record.address);
    if (a.includes(b) || b.includes(a)) score += 30;
  }
  return score;
}

function hasAddress(value: string | null | undefined) {
  return Boolean(value && value.trim());
}

async function main() {
  if (!existsSync(sourcePath)) throw new Error(`Source JSON not found: ${sourcePath}`);
  mkdirSync(path.dirname(auditLogPath), { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const source = JSON.parse(readFileSync(sourcePath, "utf8")) as SourceFile;
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  const events: unknown[] = [];
  let changed = 0;
  let skipped = 0;

  try {
    const schools = await client.query<SchoolRow>(
      `
        SELECT id, name, district, type, aliases, address, school_nature, attrs
        FROM schools
        WHERE char_length(name) <= 5
          AND ($1::text IS NULL OR district = $1)
        ORDER BY district, id
      `,
      [district ?? null],
    );

    await client.query("BEGIN");
    for (const school of schools.rows) {
      const ranked = source.records
        .filter((record) => record.district === school.district && typeMatches(school, record))
        .map((record) => ({ record, score: scoreCandidate(school, record) }))
        .filter((item) => item.score >= minScore)
        .sort((a, b) => b.score - a.score);
      const best = ranked[0];
      if (!best) {
        skipped += 1;
        continue;
      }

      const duplicate = await client.query(
        `
          SELECT id
          FROM schools
          WHERE id <> $1 AND district = $2 AND type = $3 AND name = $4
          LIMIT 1
        `,
        [school.id, school.district, school.type, best.record.name],
      );
      if (duplicate.rows.length > 0) {
        skipped += 1;
        continue;
      }

      const aliases = Array.from(new Set([...(school.aliases ?? []), school.name].filter(Boolean)));
      const nextNature = school.school_nature == null ? normalizeNature(best.record.nature) : null;
      const nextAddress = !hasAddress(school.address) && hasAddress(best.record.address) ? best.record.address.trim() : null;
      const changes: Record<string, { from: unknown; to: unknown }> = {
        name: { from: school.name, to: best.record.name },
        aliases: { from: school.aliases ?? [], to: aliases },
      };
      if (nextNature) changes.school_nature = { from: school.school_nature, to: nextNature };
      if (nextAddress) changes.address = { from: school.address, to: nextAddress };

      const sourcePayload = {
        source_title: best.record.sourceTitle,
        source_url: best.record.sourceUrl,
        matched_name: best.record.name,
        match_score: best.score,
        collected_at: new Date().toISOString(),
        previous_name: school.name,
      };
      const attrsPatch = {
        ...(school.attrs ?? {}),
        official_short_name_source: sourcePayload,
        official_short_name_sources: [
          ...(((school.attrs?.official_short_name_sources as unknown[]) ?? []).filter(Boolean)),
          sourcePayload,
        ].slice(-10),
      };

      const event = {
        ts: new Date().toISOString(),
        operation: "official_short_name_expand",
        mode: apply ? "apply" : "dry-run",
        school_id: school.id,
        school_name: school.name,
        district: school.district,
        score: best.score,
        changes,
        source: {
          type: "official_school_info",
          name: "上海市各区教育局/政府公开信息",
          title: best.record.sourceTitle,
          url: best.record.sourceUrl,
          matched_name: best.record.name,
          raw_nature: best.record.nature,
          raw_address: best.record.address,
        },
        before: {
          name: school.name,
          district: school.district,
          type: school.type,
          address: school.address,
          school_nature: school.school_nature,
          aliases: school.aliases ?? [],
        },
        after: {
          name: best.record.name,
          district: school.district,
          type: school.type,
          address: nextAddress ?? school.address,
          school_nature: nextNature ?? school.school_nature,
          aliases,
        },
      };

      events.push(event);
      console.log(JSON.stringify(event));

      if (apply) {
        const result = await client.query(
          `
            UPDATE schools
            SET
              name = $1,
              aliases = $2::text[],
              address = coalesce($3, address),
              school_nature = coalesce($4::school_nature, school_nature),
              attrs = $5::jsonb,
              updated_at = now()
            WHERE id = $6 AND name = $7 AND district = $8 AND char_length(name) <= 5
          `,
          [
            best.record.name,
            aliases,
            nextAddress,
            nextNature,
            JSON.stringify(attrsPatch),
            school.id,
            school.name,
            school.district,
          ],
        );
        if ((result.rowCount ?? 0) > 0) {
          await client.query(
            `
              INSERT INTO web_data_source (
                school_id,
                source_type,
                source_name,
                source_url,
                source_title,
                evidence,
                confidence,
                raw,
                fetched_at,
                updated_at
              )
              VALUES ($1, 'official_school_info', $2, $3, $4, $5, 'high', $6::jsonb, now(), now())
              ON CONFLICT (school_id, source_url, source_type)
              DO UPDATE SET
                source_name = excluded.source_name,
                source_title = excluded.source_title,
                evidence = excluded.evidence,
                confidence = excluded.confidence,
                raw = excluded.raw,
                fetched_at = excluded.fetched_at,
                updated_at = now()
            `,
            [
              school.id,
              "上海市各区教育局/政府公开信息",
              best.record.sourceUrl,
              best.record.sourceTitle,
              `官方公开信息将“${school.name}”确认为“${best.record.name}”。`,
              JSON.stringify({
                score: best.score,
                raw: best.record,
                changes,
              }),
            ],
          );
          appendFileSync(auditLogPath, `${JSON.stringify(event)}\n`, "utf8");
          changed += 1;
        }
      } else {
        changed += 1;
      }
    }

    writeFileSync(path.join(outDir, apply ? "applied-events.json" : "dry-run-events.json"), JSON.stringify(events, null, 2));
    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");

    console.log(
      JSON.stringify({
        mode: apply ? "apply" : "dry-run",
        sourcePath,
        auditLogPath,
        minScore,
        district: district ?? null,
        changed,
        skipped,
        eventReport: path.join(outDir, apply ? "applied-events.json" : "dry-run-events.json"),
      }),
    );
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
