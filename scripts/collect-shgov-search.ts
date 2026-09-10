import path from "node:path";
import { collectShgovSearch } from "../lib/ingest/shgov-search";

const args = process.argv.slice(2);
const value = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const keywords = value("keywords")?.split(",").map((item) => item.trim()).filter(Boolean);
async function main() {
  const result = await collectShgovSearch({ keywords, outputDir: value("output"), pageSize: value("page-size") ? Number(value("page-size")) : undefined, maxPages: value("max-pages") ? Number(value("max-pages")) : undefined, timeoutMs: value("timeout-ms") ? Number(value("timeout-ms")) : undefined, delayMs: value("delay-ms") ? Number(value("delay-ms")) : undefined });
  console.log(JSON.stringify({ manifest: path.join(result.root, "manifest.json"), complete: result.manifest.complete, resources: result.manifest.resources.length, byKeyword: Object.fromEntries(result.manifest.keywords.map((keyword) => [keyword, { pages: result.manifest.resources.filter((resource) => resource.keyword === keyword).length, failures: result.manifest.resources.filter((resource) => resource.keyword === keyword && (resource.status === null || resource.status < 200 || resource.status >= 300 || resource.error)).length }])) }, null, 2));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
