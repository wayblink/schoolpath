/**
 * Import 2026 Pudong official primary/middle school catchment XLSX rows.
 *
 * The two source files are cached XLSX attachments from Pudong Education Bureau
 * pages. The importer keeps only an explicit community-name column as the
 * community entity; road/house-number boundaries stay in source_quote.
 *
 * Default: dry-run. Pass --apply to insert missing communities and links.
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const year = 2026;
const district = "浦东";

const SOURCES = [
  {
    type: "primary" as const,
    sourceName: "official_pudong_primary_2026",
    sourceDate: "2026",
    sourceUrl: "https://www.pudong.gov.cn/zwgk/ywjy-jyjzdgz/2026/97/354039.html",
    file: ".tmp/official-policy-cache/www.pudong.gov.cn_zwgk_ywjy-jyjzdgz_2026_97_354039_ef393c5c94244ea398840560580338d1.xlsx.html",
  },
  {
    type: "middle" as const,
    sourceName: "official_pudong_middle_2026",
    sourceDate: "2026",
    sourceUrl: "https://www.pudong.gov.cn/zwgk/ywjy-jyjzdgz/2026/97/354040.html",
    file: ".tmp/official-policy-cache/www.pudong.gov.cn_zwgk_ywjy-jyjzdgz_2026_97_354040_0efeab37a5d54fa9993d0fe9a7ea588f.xlsx.html",
  },
] as const;

type SchoolType = "primary" | "middle";
export type School = { id: number; name: string; district: string; type: SchoolType; aliases: string[] | null };
type Community = { id: number; name: string; district: string; source_committee: string | null };
type Link = { id: number; school_id: number; community_id: number; year: number };
type Source = (typeof SOURCES)[number];
type RawRow = {
  sourceType: SchoolType;
  sourceName: string;
  sourceUrl: string;
  rowNumber: number;
  grade: string;
  sequence: string;
  school: string;
  area: string;
  street: string;
  community: string;
  notes: string;
};
type Pairing = {
  sourceType: SchoolType;
  sourceName: string;
  sourceUrl: string;
  schoolName: string;
  communityName: string;
  streets: string[];
  areas: string[];
  notes: string[];
  rowNumbers: number[];
};

type Action = {
  sourceType: SchoolType;
  schoolName: string;
  matchedSchoolId?: number;
  matchedSchoolName?: string;
  communityName: string;
  action:
    | "dry-run-insert"
    | "insert"
    | "skip-existing-link"
    | "skip-unmatched-school"
    | "skip-ambiguous-school"
    | "skip-invalid-community";
  reason?: string;
  communityId?: number;
  linkId?: number;
  sourceQuote: string;
};

function normalize(value: string) {
  return value
    .replace(/[\s\u00a0]/g, "")
    .replace(/[（）]/g, (char) => (char === "（" ? "(" : ")"))
    .trim();
}

function normalizeCommunity(value: string) {
  return normalize(value).replace(/[【】\[\]]/g, "");
}

export function schoolVariants(value: string) {
  const normalized = normalize(value);
  const variants = new Set([normalized]);
  for (const prefix of ["上海市浦东新区", "上海市", "浦东新区"]) {
    if (normalized.startsWith(prefix)) variants.add(normalized.slice(prefix.length));
  }
  for (const item of [...variants]) {
    variants.add(item.replace(/\((?:小学部|中学部|初中部|高中部)\)$/g, ""));
  }
  return [...variants].filter(Boolean);
}

export function matchOfficialSchool(officialName: string, sourceType: SchoolType, schools: School[]) {
  const normalizedOfficialName = normalize(officialName);
  const exactCanonicalMatches = schools.filter(
    (school) => school.type === sourceType && normalize(school.name) === normalizedOfficialName,
  );
  // A full official name is stronger evidence than a shortened legacy alias.
  // Keep multiple exact rows ambiguous so duplicate entities are never collapsed.
  if (exactCanonicalMatches.length > 0) return exactCanonicalMatches;

  const sourceVariants = new Set(schoolVariants(officialName));
  const matches = new Map<number, School>();
  for (const school of schools) {
    if (school.type !== sourceType) continue;
    const targetVariants = [school.name, ...(school.aliases ?? [])].flatMap(schoolVariants);
    if (targetVariants.some((variant) => sourceVariants.has(variant))) matches.set(school.id, school);
  }
  return [...matches.values()];
}

function decodeXml(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function xmlText(value: string) {
  return decodeXml(value.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function unzipEntry(file: string, entry: string) {
  return execFileSync("unzip", ["-p", file, entry], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
}

function parseSharedStrings(xml: string) {
  return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((match) => xmlText(match[1] ?? ""));
}

function colIndex(reference: string) {
  const letters = reference.match(/[A-Z]+/i)?.[0]?.toUpperCase() ?? "A";
  let index = 0;
  for (const char of letters) index = index * 26 + char.charCodeAt(0) - 64;
  return index - 1;
}

function parseSheet(xml: string, strings: string[], source: Source): RawRow[] {
  const rows: RawRow[] = [];
  for (const rowMatch of xml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)) {
    const rowXml = rowMatch[1] ?? "";
    const rowNumber = Number(rowMatch[0].match(/\br="(\d+)"/)?.[1] ?? 0);
    const cells = ["", "", "", "", "", "", ""];
    for (const cellMatch of rowXml.matchAll(/<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1] ?? "";
      const body = cellMatch[2] ?? "";
      const index = colIndex(attrs.match(/\br="([A-Z]+\d+)"/i)?.[1] ?? "A1");
      if (index < 0 || index >= cells.length) continue;
      const value = body.match(/<v[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? "";
      const raw = /\bt="s"/.test(attrs) ? strings[Number(value)] ?? "" : xmlText(value);
      cells[index] = raw;
    }
    if (rowNumber === 1 || cells.every((cell) => !cell)) continue;
    const [grade, sequence, school, area, street, community, notes] = cells;
    rows.push({
      sourceType: source.type,
      sourceName: source.sourceName,
      sourceUrl: source.sourceUrl,
      rowNumber,
      grade,
      sequence,
      school,
      area,
      street,
      community,
      notes,
    });
  }
  return rows;
}

function parseXlsx(file: string, source: Source) {
  if (!existsSync(file)) throw new Error(`XLSX not found: ${file}`);
  return parseSheet(unzipEntry(file, "xl/worksheets/sheet1.xml"), parseSharedStrings(unzipEntry(file, "xl/sharedStrings.xml")), source);
}

function invalidCommunityReason(value: string) {
  const name = normalizeCommunity(value);
  if (!name) return "小区名称为空";
  if (name.length < 2 || name.length > 60) return "小区名称长度异常";
  if (/统筹|待定|无对应|不详|其他小区|合计|总计/.test(name)) return "占位或汇总文本";
  if (/学校|小学|中学|幼儿园|教育局/.test(name)) return "学校或机构名称";
  if (/\d|路|弄|号|公路|大道|街道$|镇$|行政村$|范围|区域|道路/.test(name)) return "道路、门牌或行政区域文本";
  return null;
}

function dedupePairings(rows: RawRow[]) {
  const map = new Map<string, Pairing>();
  const stats = { emptyCommunity: 0, invalidCommunity: 0, invalidReasons: {} as Record<string, number> };
  for (const row of rows) {
    const reason = invalidCommunityReason(row.community);
    if (reason) {
      stats[reason === "小区名称为空" ? "emptyCommunity" : "invalidCommunity"] += 1;
      stats.invalidReasons[reason] = (stats.invalidReasons[reason] ?? 0) + 1;
      continue;
    }
    const key = `${row.sourceType}::${normalize(row.school)}::${normalizeCommunity(row.community)}`;
    const existing = map.get(key);
    if (existing) {
      if (row.street && !existing.streets.includes(row.street)) existing.streets.push(row.street);
      if (row.area && !existing.areas.includes(row.area)) existing.areas.push(row.area);
      if (row.notes && !existing.notes.includes(row.notes)) existing.notes.push(row.notes);
      existing.rowNumbers.push(row.rowNumber);
      continue;
    }
    map.set(key, {
      sourceType: row.sourceType,
      sourceName: row.sourceName,
      sourceUrl: row.sourceUrl,
      schoolName: row.school,
      communityName: normalizeCommunity(row.community),
      streets: row.street ? [row.street] : [],
      areas: row.area ? [row.area] : [],
      notes: row.notes ? [row.notes] : [],
      rowNumbers: [row.rowNumber],
    });
  }
  return { pairings: [...map.values()], stats };
}

function sourceQuote(pairing: Pairing) {
  const parts = [
    pairing.streets.length ? `对口地段所属街镇：${pairing.streets.join("、")}` : "",
    pairing.areas.length ? `对口地段：${pairing.areas.join("、")}` : "",
    pairing.notes.length ? `情况说明：${pairing.notes.join("；")}` : "",
  ].filter(Boolean);
  const quote = parts.join("；");
  return quote.length > 1800 ? `${quote.slice(0, 1780)}…(原始行${pairing.rowNumbers.length}条)` : quote;
}

function outputDir() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "pudong-official-community-link-import-2026", stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function main() {
  const dir = outputDir();
  const parsed = SOURCES.flatMap((source) => parseXlsx(path.resolve(process.cwd(), source.file), source));
  const { pairings, stats } = dedupePairings(parsed);
  writeFileSync(path.join(dir, "parsed-official-rows.json"), JSON.stringify(parsed, null, 2));
  writeFileSync(path.join(dir, "deduped-pairings.json"), JSON.stringify(pairings, null, 2));

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const schools = await client.query<School>(`SELECT id, name, district, type, aliases FROM schools WHERE district = $1 AND type IN ('primary','middle') ORDER BY id`, [district]);
    const communities = await client.query<Community>(`SELECT id, name, district, source_committee FROM communities WHERE district = $1 ORDER BY id`, [district]);
    const links = await client.query<Link>(`SELECT sc.id, sc.school_id, sc.community_id, sc.year FROM school_communities sc JOIN schools s ON s.id = sc.school_id WHERE s.district = $1 AND sc.year = $2`, [district, year]);
    const communityByKey = new Map<string, Community[]>();
    for (const community of communities.rows) communityByKey.set(normalizeCommunity(community.name), [...(communityByKey.get(normalizeCommunity(community.name)) ?? []), community]);
    const existingLinks = new Set(links.rows.map((link) => `${link.school_id}::${link.community_id}::${link.year}`));
    const actions: Action[] = [];
    const unmatched = new Map<string, number>();
    const ambiguous = new Map<string, number>();
    let insertedCommunities = 0;
    let insertedLinks = 0;
    let existingLinksCount = 0;
    const sourceRows = Object.fromEntries(SOURCES.map((source) => [source.type, parsed.filter((row) => row.sourceType === source.type).length]));
    await client.query("BEGIN");
    for (const pairing of pairings) {
      const matches = matchOfficialSchool(pairing.schoolName, pairing.sourceType, schools.rows);
      const quote = sourceQuote(pairing);
      if (matches.length === 0) {
        unmatched.set(pairing.schoolName, (unmatched.get(pairing.schoolName) ?? 0) + 1);
        actions.push({ sourceType: pairing.sourceType, schoolName: pairing.schoolName, communityName: pairing.communityName, action: "skip-unmatched-school", reason: "同区同学段没有唯一匹配学校", sourceQuote: quote });
        continue;
      }
      if (matches.length !== 1) {
        ambiguous.set(pairing.schoolName, (ambiguous.get(pairing.schoolName) ?? 0) + 1);
        actions.push({ sourceType: pairing.sourceType, schoolName: pairing.schoolName, communityName: pairing.communityName, action: "skip-ambiguous-school", reason: `匹配到${matches.length}所同名学校`, sourceQuote: quote });
        continue;
      }
      const school = matches[0];
      const communityMatches = communityByKey.get(normalizeCommunity(pairing.communityName)) ?? [];
      let community = communityMatches.length === 1 ? communityMatches[0] : undefined;
      if (communityMatches.length > 1) {
        actions.push({ sourceType: pairing.sourceType, schoolName: pairing.schoolName, matchedSchoolId: school.id, matchedSchoolName: school.name, communityName: pairing.communityName, action: "skip-invalid-community", reason: `同区规范化同名小区${communityMatches.length}条`, sourceQuote: quote });
        continue;
      }
      if (!community && apply) {
        const result = await client.query<Community>(
          `INSERT INTO communities (name, district, source_committee, source_query, source_url, source_name, source_date, verified, notes, attrs)
           VALUES ($1,$2,$3,$4,$5,$6,$7,false,$8,$9::jsonb)
           ON CONFLICT (name, district) DO NOTHING RETURNING id,name,district,source_committee`,
          [pairing.communityName, district, pairing.streets.join("、") || null, `${district} ${pairing.communityName}`, pairing.sourceUrl, pairing.sourceName, "2026", "2026浦东官方招生地段公示导入；关系未人工核验，坐标待补。", JSON.stringify({ import_kind: pairing.sourceName, source_school_name: pairing.schoolName, streets: pairing.streets, source_rows: pairing.rowNumbers })],
        );
        community = result.rows[0] ?? (await client.query<Community>(`SELECT id,name,district,source_committee FROM communities WHERE district=$1 AND name=$2 LIMIT 1`, [district, pairing.communityName])).rows[0];
        if (result.rows[0]) insertedCommunities += 1;
      }
      if (!community) {
        actions.push({ sourceType: pairing.sourceType, schoolName: pairing.schoolName, matchedSchoolId: school.id, matchedSchoolName: school.name, communityName: pairing.communityName, action: "dry-run-insert", sourceQuote: quote });
        continue;
      }
      const linkKey = `${school.id}::${community.id}::${year}`;
      if (existingLinks.has(linkKey)) {
        existingLinksCount += 1;
        actions.push({ sourceType: pairing.sourceType, schoolName: pairing.schoolName, matchedSchoolId: school.id, matchedSchoolName: school.name, communityName: pairing.communityName, action: "skip-existing-link", communityId: community.id, sourceQuote: quote });
        continue;
      }
      if (!apply) {
        actions.push({ sourceType: pairing.sourceType, schoolName: pairing.schoolName, matchedSchoolId: school.id, matchedSchoolName: school.name, communityName: pairing.communityName, action: "dry-run-insert", communityId: community.id, sourceQuote: quote });
        continue;
      }
      const result = await client.query<{ id: number }>(
        `INSERT INTO school_communities (school_id,community_id,committee_name,year,source_name,source_url,source_quote,source_date,verified,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false,$9) ON CONFLICT (school_id,community_id,year) DO NOTHING RETURNING id`,
        [school.id, community.id, pairing.streets.join("、") || null, year, pairing.sourceName, pairing.sourceUrl, quote, "2026", "2026浦东官方招生地段公示导入；关系未人工核验，待后续核验。"],
      );
      if (result.rows[0]) {
        insertedLinks += 1;
        existingLinks.add(linkKey);
        actions.push({ sourceType: pairing.sourceType, schoolName: pairing.schoolName, matchedSchoolId: school.id, matchedSchoolName: school.name, communityName: pairing.communityName, action: "insert", communityId: community.id, linkId: result.rows[0].id, sourceQuote: quote });
      } else {
        existingLinksCount += 1;
        actions.push({ sourceType: pairing.sourceType, schoolName: pairing.schoolName, matchedSchoolId: school.id, matchedSchoolName: school.name, communityName: pairing.communityName, action: "skip-existing-link", communityId: community.id, sourceQuote: quote });
      }
    }
    const report = path.join(dir, apply ? "import-applied.json" : "import-dry-run.json");
    writeFileSync(path.join(dir, "unmatched-schools.json"), JSON.stringify(Object.fromEntries(unmatched), null, 2));
    writeFileSync(path.join(dir, "ambiguous-schools.json"), JSON.stringify(Object.fromEntries(ambiguous), null, 2));
    writeFileSync(report, JSON.stringify({ mode: apply ? "apply" : "dry-run", year, district, sourceRows, rawRows: parsed.length, pairings: pairings.length, stats, unmatchedSchoolCount: unmatched.size, ambiguousSchoolCount: ambiguous.size, insertedCommunities, insertedLinks, existingLinks: existingLinksCount, plannedLinks: actions.filter((action) => action.action === "dry-run-insert" || action.action === "insert").length, actions }, null, 2));
    if (apply) await client.query("COMMIT"); else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", year, district, sourceRows, rawRows: parsed.length, pairings: pairings.length, stats, unmatchedSchoolCount: unmatched.size, ambiguousSchoolCount: ambiguous.size, insertedCommunities, insertedLinks, existingLinks: existingLinksCount, plannedLinks: actions.filter((action) => action.action === "dry-run-insert" || action.action === "insert").length, report }, null, 2));
    console.log("No deletes, resets, seeds, updates, or overwrites were performed.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.endsWith("import-pudong-official-community-links-2026.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
