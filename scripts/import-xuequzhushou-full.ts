import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";
import { buildXuequzhushouImport, importXuequzhushou } from "../lib/ingest/xuequzhushou-import";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: tsx scripts/import-xuequzhushou-full.ts --snapshot=<source.html> [--apply] [--fetched-at=<ISO timestamp>]\nDefault: read-only dry-run. Imports homepage data only; site/map documents have a separate importer.");
    return;
  }
  for (const arg of args) {
    if (arg !== "--apply" && !arg.startsWith("--snapshot=") && !arg.startsWith("--fetched-at=")) throw new Error(`Unknown option: ${arg}`);
  }
  const snapshot = args.find(arg => arg.startsWith("--snapshot="))?.slice("--snapshot=".length);
  if (!snapshot) throw new Error("--snapshot=<path to source.html> is required");
  const fetchedAt = args.find(arg => arg.startsWith("--fetched-at="))?.slice("--fetched-at=".length);
  if (fetchedAt && Number.isNaN(Date.parse(fetchedAt))) throw new Error("--fetched-at must be a valid timestamp from capture evidence");
  const snapshotPath = path.resolve(snapshot);
  const plan = buildXuequzhushouImport(readFileSync(snapshotPath, "utf8"));
  loadLocalEnv();
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const report = await importXuequzhushou(client, plan, { apply: args.includes("--apply"), snapshotPath, fetchedAt });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await client.end();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
