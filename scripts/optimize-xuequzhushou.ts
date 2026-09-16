/**
 * Iterative, auditable optimization pass for the Xuequzhushou source.
 *
 * Default mode only fetches/parses and writes an immutable snapshot. Loading
 * a snapshot into ingest/audit and publishing catalog relations are separate
 * explicit steps.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseXuequzhushouHtml, type ParsedXuequzhushou, type SourceDistrict } from "../lib/import/xuequzhushou";

const SOURCE_URL = "https://xuequzhushou.cn/";
const ALLOWED_DISTRICTS = new Set(["黄浦区", "静安区", "长宁区", "虹口区", "杨浦区", "徐汇区", "闵行区", "浦东新区", "普陀区"]);

function filterNineDistricts(parsed: ParsedXuequzhushou): ParsedXuequzhushou {
  const districts: Record<string, SourceDistrict> = {};
  const districtOrder = parsed.districtOrder.filter((name) => ALLOWED_DISTRICTS.has(name));
  for (const name of districtOrder) districts[name] = parsed.districts[name];
  let primarySchoolCount = 0;
  let middleSchoolCount = 0;
  let streetCount = 0;
  let committeeRelationCount = 0;
  let coordinateCount = 0;
  let taggedSchoolCount = 0;
  for (const district of Object.values(districts)) {
    streetCount += district.街道?.length ?? 0;
    for (const school of district.小学 ?? []) {
      primarySchoolCount += 1;
      const committees = school.对口居委;
      committeeRelationCount += Array.isArray(committees) ? committees.length : committees ? 1 : 0;
      if (school.lng != null && school.lat != null) coordinateCount += 1;
      if (school.标签?.length) taggedSchoolCount += 1;
    }
    for (const school of district.初中 ?? []) {
      middleSchoolCount += 1;
      if (school.lng != null && school.lat != null) coordinateCount += 1;
    }
  }
  return {
    ...parsed,
    districts,
    districtOrder,
    stats: { districtCount: districtOrder.length, primarySchoolCount, middleSchoolCount, streetCount, committeeRelationCount, coordinateCount, taggedSchoolCount },
  };
}

function arg(name: string): string | undefined {
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function main() {
  const inputPath = arg("--input");
  const html = inputPath
    ? readFileSync(path.resolve(inputPath), "utf8")
    : await fetch(SOURCE_URL).then(async (response) => {
        if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
        return response.text();
      });
  const parsed = filterNineDistricts(parseXuequzhushouHtml(html, SOURCE_URL));
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const outputDir = path.join(process.cwd(), "data", "ingest", "xuequzhushou", stamp);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(path.join(outputDir, "source.html"), html);
  writeFileSync(path.join(outputDir, "parsed.json"), JSON.stringify(parsed, null, 2));
  writeFileSync(path.join(outputDir, "manifest.json"), JSON.stringify({
    sourceUrl: SOURCE_URL,
    fetchedAt: new Date().toISOString(),
    parserVersion: 1,
    scope: "shanghai-nine-districts",
    districts: parsed.districtOrder,
    contentHash: parsed.contentHash,
    stats: parsed.stats,
    nextStep: "Run data:import:xuequzhushou-homepage with this snapshot after reviewing the dry-run report.",
  }, null, 2));
  console.log(JSON.stringify({ outputDir, sourceUrl: SOURCE_URL, districts: parsed.districtOrder, stats: parsed.stats }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
