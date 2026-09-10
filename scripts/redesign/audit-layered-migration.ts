import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "../load-env";

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const connectionString = databaseUrl;

const entities = [
  { name: "schools", source: "public.schools", target: "catalog.schools" },
  { name: "communities", source: "public.communities", target: "catalog.communities" },
  {
    name: "school_community_assignments",
    source: "public.school_communities",
    target: "catalog.school_community_assignments",
  },
  { name: "policy_documents", source: "public.policies", target: "catalog.policy_documents" },
] as const;

const client = new pg.Client({ connectionString });

async function main() {
  await client.connect();
  try {
    const results = [];
    for (const entity of entities) {
      const { rows: [counts] } = await client.query<{
        source_count: number;
        target_count: number;
        missing_legacy_ids: number;
        unexpected_legacy_ids: number;
      }>(`
        SELECT
          (SELECT count(*)::int FROM ${entity.source}) AS source_count,
          (SELECT count(*)::int FROM ${entity.target}) AS target_count,
          (SELECT count(*)::int FROM ${entity.source} source
            WHERE NOT EXISTS (SELECT 1 FROM ${entity.target} target WHERE target.legacy_id = source.id)) AS missing_legacy_ids,
          (SELECT count(*)::int FROM ${entity.target} target
            WHERE NOT EXISTS (SELECT 1 FROM ${entity.source} source WHERE source.id = target.legacy_id)) AS unexpected_legacy_ids
      `);

      results.push({
        entity: entity.name,
        sourceTable: entity.source,
        targetTable: entity.target,
        ...counts,
        aligned:
          counts.source_count === counts.target_count &&
          counts.missing_legacy_ids === 0 &&
          counts.unexpected_legacy_ids === 0,
      });
    }

    const report = {
      generatedAt: new Date().toISOString(),
      database: new URL(connectionString).pathname.slice(1),
      passed: results.every((result) => result.aligned),
      results,
    };
    const date = report.generatedAt.slice(0, 10).replaceAll("-", "");
    const outputDir = path.join(process.cwd(), "data/audit/redesign-migration", date);
    const outputPath = path.join(outputDir, "diff-report.json");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.table(results);
    console.log(`Migration audit report: ${outputPath}`);
    if (!report.passed) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
