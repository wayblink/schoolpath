/**
 * Read-only audit for school district source and coverage.
 *
 * It combines current DB coverage with official Shanghai enrollment policy links.
 * By default it writes a timestamped JSON snapshot under .tmp/.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();

const years = valueArg("--years")
  ?.split(",")
  .map((item) => Number(item.trim()))
  .filter((item) => Number.isFinite(item) && item > 2000);
const jsonOnly = process.argv.includes("--json");
const noRemote = process.argv.includes("--no-remote");
const writeStable = process.argv.includes("--write-stable");

let closePool: (() => Promise<void>) | undefined;

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1]?.trim();
  return undefined;
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    missing: "缺对口来源",
    "source-found": "有来源",
    "boundary-text": "有边界文本",
    "partially-linked": "部分结构化",
    linked: "已结构化",
  };
  return labels[status] ?? status;
}

async function main() {
  const [{ buildSchoolDistrictAudit }, dbClient] = await Promise.all([
    import("../lib/school-district-audit"),
    import("../lib/db/client"),
  ]);
  closePool = () => dbClient.pool.end();
  const audit = await buildSchoolDistrictAudit({
    years: years?.length ? years : undefined,
    includeRemoteSources: !noRemote,
  });

  if (jsonOnly) {
    console.log(JSON.stringify(audit, null, 2));
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportDir = path.join(process.cwd(), ".tmp", "school-district-source-audit", stamp);
  mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "audit.json");
  writeFileSync(reportPath, JSON.stringify(audit, null, 2));

  if (writeStable) {
    const stablePath = path.join(process.cwd(), "data", "school-district-sources-audit.json");
    writeFileSync(stablePath, JSON.stringify(audit, null, 2));
  }

  console.log(`# school district source audit`);
  console.log(`generated_at: ${audit.generatedAt}`);
  console.log(`report: ${reportPath}`);
  console.log("");

  for (const summary of audit.summary) {
    console.log(
      `${summary.year}: schools=${summary.schoolTotal}, linked_schools=${summary.linkedSchools}, coverage=${summary.coveragePercent}%, scope_sources=${summary.scopeSourceCount}`,
    );
  }

  console.log("\n## district gaps");
  for (const row of audit.rows
    .filter((item) => item.status !== "linked")
    .sort((a, b) => a.year - b.year || a.coveragePercent - b.coveragePercent || b.scopeSourceCount - a.scopeSourceCount)) {
    console.log(
      [
        row.year,
        row.district,
        statusLabel(row.status),
        `linked=${row.linkedSchools}/${row.schoolTotal}(${row.coveragePercent}%)`,
        `boundary_text=${row.boundaryTextSchools}`,
        `scope_sources=${row.scopeSourceCount}`,
        row.sources[0]?.title ? `top_source=${row.sources[0].title}` : "top_source=-",
      ].join(" | "),
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool?.();
  });
