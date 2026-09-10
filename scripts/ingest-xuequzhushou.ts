import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseXuequzhushouHtml } from "../lib/ingest/xuequzhushou";

async function main() {
  const sourceUrl = "https://xuequzhushou.cn/";
  const inputArg = process.argv.find((arg) => arg.startsWith("--input="))?.slice(8);
  const html = inputArg
    ? readFileSync(path.resolve(inputArg), "utf8")
    : await fetch(sourceUrl).then(async (response) => {
        if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
        return response.text();
      });
  const parsed = parseXuequzhushouHtml(html, sourceUrl);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const outputDir = path.join(process.cwd(), "data", "ingest", "xuequzhushou", stamp);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(path.join(outputDir, "source.html"), html);
  writeFileSync(path.join(outputDir, "parsed.json"), JSON.stringify(parsed, null, 2));
  writeFileSync(path.join(outputDir, "manifest.json"), JSON.stringify({
    sourceUrl,
    fetchedAt: new Date().toISOString(),
    parserVersion: 1,
    contentHash: parsed.contentHash,
    stats: parsed.stats,
  }, null, 2));
  console.log(JSON.stringify({ outputDir, contentHash: parsed.contentHash, stats: parsed.stats }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
