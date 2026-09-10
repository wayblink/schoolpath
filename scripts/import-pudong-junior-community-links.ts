/**
 * Import the official 2025 浦东新区公办初中招生地段公示 into communities + school_communities.
 *
 * Source: https://www.shanghai.gov.cn/pdxqywjy/20250507/79de2fd60f4a42099fad4acc7aa78922.html
 * (discovered via the jjipi/school-district-web Scrapy spider; data re-scraped here into our
 *  provenance-tracked pipeline rather than importing their pre-parsed JSON.)
 *
 * Safety rules (mirrors import-baoshan-community-links.ts):
 * - default mode is dry-run; pass --apply to insert
 * - only inserts missing rows; never deletes, truncates, resets, seeds, or overwrites
 * - snapshots current 浦东 schools/communities/links and writes a detailed report under .tmp
 * - schools are matched against existing DB rows by normalized name; unmatched schools are
 *   reported, never auto-created
 * - the page's 小区名称 column is already structured, so no free-text boundary parsing is needed
 *
 * Usage:
 *   npx tsx scripts/import-pudong-junior-community-links.ts            # dry-run
 *   npx tsx scripts/import-pudong-junior-community-links.ts --apply    # insert
 *   npx tsx scripts/import-pudong-junior-community-links.ts --html=/tmp/pudong.html  # use cached html
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

const { Client } = pg;

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const district = "浦东";
const year = 2025;
const SOURCE_URL =
  "https://www.shanghai.gov.cn/pdxqywjy/20250507/79de2fd60f4a42099fad4acc7aa78922.html";
const SOURCE_NAME = "official_pudong_junior_2025";
const SOURCE_DATE = "2025-05-07";
const PSEUDO_SCHOOLS = new Set(["统筹安排", "统筹", ""]);
const htmlArg = valueArg("--html");

type SchoolType = "primary" | "middle" | "nine_year";

type SchoolRow = { id: number; name: string; district: string; type: SchoolType };
type CommunityRow = { id: number; name: string; district: string; source_committee: string | null };
type LinkRow = { id: number; school_id: number; community_id: number; year: number };

/** One row of the official table. */
type RawRow = {
  grade: string;
  seq: string;
  school: string;
  area: string; // 对口地段 (lane/road)
  street: string; // 对口地段所属街镇
  community: string; // 小区名称
  notes: string; // 情况说明
};

/** A deduplicated (school, community) pairing, aggregating all lane addresses. */
type Pairing = {
  schoolName: string;
  communityName: string;
  streets: string[];
  addrs: string[];
  notes: string[];
};

type PlannedAction = {
  schoolName: string;
  communityName: string;
  action:
    | "dry-run-insert"
    | "insert"
    | "skip-existing-link"
    | "skip-unmatched-school"
    | "skip-empty-community";
  communityId?: number;
  linkId?: number;
};

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1]?.trim();
  return undefined;
}

function outputPaths() {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "pudong-junior-link-import", stamp);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    rawSnapshot: path.join(dir, "parsed-official-rows.json"),
    pairsSnapshot: path.join(dir, "deduped-pairs.json"),
    schoolsSnapshot: path.join(dir, "pudong-schools-before.json"),
    communitiesSnapshot: path.join(dir, "pudong-communities-before.json"),
    linksSnapshot: path.join(dir, "pudong-links-before.json"),
    unmatchedSchools: path.join(dir, "unmatched-schools.json"),
    report: path.join(dir, apply ? "import-applied.json" : "import-dry-run.json"),
  };
}

function normalizeName(value: string) {
  return value
    .replace(/[（）]/g, (char) => (char === "（" ? "(" : ")"))
    .replace(/\s+/g, "")
    .trim();
}

function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function cellText(html: string) {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchHtml(): Promise<string> {
  if (htmlArg) {
    if (!existsSync(htmlArg)) throw new Error(`--html file not found: ${htmlArg}`);
    return readFileSync(htmlArg, "utf8");
  }
  const res = await fetch(SOURCE_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);
  return res.text();
}

/** Parse the single official table into raw rows. */
function parseRows(html: string): RawRow[] {
  const table = html.match(/<table[\s\S]*?<\/table>/i);
  if (!table) throw new Error("No <table> found on the page.");
  const rows = table[0].match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
  const out: RawRow[] = [];
  for (const tr of rows) {
    const cells = (tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) ?? []).map((c) =>
      cellText(c.replace(/^<t[dh][^>]*>/i, "").replace(/<\/t[dh]>$/i, "")),
    );
    if (cells.length < 7) continue;
    const [grade, seq, school, area, street, community, notes] = cells;
    if (!school || school === "学校名称" || grade.includes("招收年级")) continue;
    out.push({ grade, seq, school, area, street, community, notes });
  }
  return out;
}

/** Dedup raw rows to (school, community) pairings, aggregating lanes/streets/notes. */
function buildPairings(rows: RawRow[]) {
  const map = new Map<string, Pairing>();
  let emptyCommunity = 0;
  let pseudoSchool = 0;
  for (const r of rows) {
    if (PSEUDO_SCHOOLS.has(r.school)) {
      pseudoSchool += 1;
      continue;
    }
    if (!r.community) {
      emptyCommunity += 1;
      continue;
    }
    const key = `${normalizeName(r.school)}::${normalizeName(r.community)}`;
    let p = map.get(key);
    if (!p) {
      p = { schoolName: r.school, communityName: r.community, streets: [], addrs: [], notes: [] };
      map.set(key, p);
    }
    if (r.street && !p.streets.includes(r.street)) p.streets.push(r.street);
    if (r.area && !p.addrs.includes(r.area)) p.addrs.push(r.area);
    if (r.notes && !p.notes.includes(r.notes)) p.notes.push(r.notes);
  }
  return { pairings: [...map.values()], emptyCommunity, pseudoSchool };
}

function buildSourceQuote(p: Pairing) {
  const streets = p.streets.join("、");
  const addrs = p.addrs.join("、");
  const head = streets ? `${streets}：` : "";
  const quote = `${head}${addrs}`;
  // keep the quote bounded; the full list lives in the report json.
  return quote.length > 1500 ? `${quote.slice(0, 1490)}…(共${p.addrs.length}条)` : quote;
}

async function ensureCommunity(
  client: pg.Client,
  existingByKey: Map<string, CommunityRow>,
  p: Pairing,
): Promise<CommunityRow | undefined> {
  const key = normalizeName(p.communityName);
  const existing = existingByKey.get(key);
  if (existing) return existing;
  if (!apply) return undefined;

  const committee = p.streets.join("、") || null;
  const result = await client.query<CommunityRow>(
    `
      INSERT INTO communities (
        name, district, source_committee, source_query, source_url, source_name, source_date,
        verified, notes, attrs
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9::jsonb)
      ON CONFLICT (name, district) DO NOTHING
      RETURNING id, name, district, source_committee
    `,
    [
      p.communityName,
      district,
      committee,
      `${district} ${p.communityName}`,
      SOURCE_URL,
      SOURCE_NAME,
      SOURCE_DATE,
      "浦东2025公办初中招生地段公示导入；未补高德坐标，需后续核验。",
      JSON.stringify({
        import_kind: "official_pudong_junior_2025",
        streets: p.streets,
        source_school_name: p.schoolName,
      }),
    ],
  );

  const inserted =
    result.rows[0] ??
    (
      await client.query<CommunityRow>(
        `SELECT id, name, district, source_committee FROM communities WHERE district = $1 AND name = $2 LIMIT 1`,
        [district, p.communityName],
      )
    ).rows[0];
  if (!inserted) throw new Error(`Failed to insert/find community: ${p.communityName}`);
  existingByKey.set(key, inserted);
  return inserted;
}

async function main() {
  const paths = outputPaths();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const html = await fetchHtml();
    const rawRows = parseRows(html);
    writeFileSync(paths.rawSnapshot, JSON.stringify(rawRows, null, 2), "utf8");

    const { pairings, emptyCommunity, pseudoSchool } = buildPairings(rawRows);
    writeFileSync(paths.pairsSnapshot, JSON.stringify(pairings, null, 2), "utf8");

    const schools = await client.query<SchoolRow>(
      `SELECT id, name, district, type FROM schools WHERE district = $1 ORDER BY id`,
      [district],
    );
    writeFileSync(paths.schoolsSnapshot, JSON.stringify(schools.rows, null, 2), "utf8");

    const communities = await client.query<CommunityRow>(
      `SELECT id, name, district, source_committee FROM communities WHERE district = $1 ORDER BY id`,
      [district],
    );
    writeFileSync(paths.communitiesSnapshot, JSON.stringify(communities.rows, null, 2), "utf8");

    const links = await client.query<LinkRow>(
      `
        SELECT sc.id, sc.school_id, sc.community_id, sc.year
        FROM school_communities sc
        JOIN schools s ON s.id = sc.school_id
        WHERE s.district = $1 AND sc.year = $2
        ORDER BY sc.id
      `,
      [district, year],
    );
    writeFileSync(paths.linksSnapshot, JSON.stringify(links.rows, null, 2), "utf8");

    const schoolByName = new Map(schools.rows.map((s) => [normalizeName(s.name), s]));
    const existingCommunities = new Map(communities.rows.map((c) => [normalizeName(c.name), c]));
    const existingLinks = new Set(links.rows.map((l) => `${l.school_id}::${l.community_id}::${l.year}`));

    const report: PlannedAction[] = [];
    const unmatchedSchoolNames = new Set<string>();
    let insertedCommunities = 0;
    let reusedCommunities = 0;
    let insertedLinks = 0;
    let skippedExistingLinks = 0;
    let skippedUnmatchedSchool = 0;

    console.log(`Mode: ${apply ? "apply" : "dry-run"}`);
    console.log(`District: ${district}  Year: ${year}`);
    console.log(`Source: ${htmlArg ? `(cached) ${htmlArg}` : SOURCE_URL}`);
    console.log(`Raw rows parsed: ${rawRows.length}`);
    console.log(`  skipped (统筹安排/no school): ${pseudoSchool}`);
    console.log(`  skipped (empty 小区名称): ${emptyCommunity}`);
    console.log(`Deduped (school, community) pairings: ${pairings.length}`);
    console.log(`Existing ${district} schools: ${schools.rows.length}`);
    console.log(`Existing ${district} communities: ${communities.rows.length}`);
    console.log(`Existing ${district} links (year ${year}): ${links.rows.length}`);
    console.log(`Output: ${paths.dir}`);

    await client.query("BEGIN");
    for (const p of pairings) {
      const school = schoolByName.get(normalizeName(p.schoolName));
      if (!school) {
        unmatchedSchoolNames.add(p.schoolName);
        skippedUnmatchedSchool += 1;
        report.push({ schoolName: p.schoolName, communityName: p.communityName, action: "skip-unmatched-school" });
        continue;
      }

      const existed = existingCommunities.has(normalizeName(p.communityName));
      const community = await ensureCommunity(client, existingCommunities, p);
      if (existed) reusedCommunities += 1;
      else if (apply) insertedCommunities += 1;

      const linkKey = community ? `${school.id}::${community.id}::${year}` : `${school.id}::${normalizeName(p.communityName)}`;
      if (community && existingLinks.has(linkKey)) {
        skippedExistingLinks += 1;
        report.push({ schoolName: p.schoolName, communityName: p.communityName, action: "skip-existing-link", communityId: community.id });
        continue;
      }

      if (!apply) {
        report.push({ schoolName: p.schoolName, communityName: p.communityName, action: "dry-run-insert" });
        continue;
      }

      const result = await client.query<{ id: number }>(
        `
          INSERT INTO school_communities (
            school_id, community_id, committee_name, year, source_name, source_url, source_quote,
            source_date, verified, notes
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9)
          ON CONFLICT (school_id, community_id, year) DO NOTHING
          RETURNING id
        `,
        [
          school.id,
          community!.id,
          p.streets.join("、") || null,
          year,
          SOURCE_NAME,
          SOURCE_URL,
          buildSourceQuote(p),
          SOURCE_DATE,
          "浦东2025公办初中招生地段公示导入；未补高德坐标，需后续核验。",
        ],
      );
      const insertedLinkId = result.rows[0]?.id;
      if (insertedLinkId) {
        existingLinks.add(linkKey);
        insertedLinks += 1;
        report.push({ schoolName: p.schoolName, communityName: p.communityName, action: "insert", communityId: community!.id, linkId: insertedLinkId });
      } else {
        skippedExistingLinks += 1;
        report.push({ schoolName: p.schoolName, communityName: p.communityName, action: "skip-existing-link", communityId: community!.id });
      }
    }

    writeFileSync(paths.unmatchedSchools, JSON.stringify([...unmatchedSchoolNames].sort(), null, 2), "utf8");
    writeFileSync(paths.report, JSON.stringify(report, null, 2), "utf8");
    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");

    console.log(`Report: ${paths.report}`);
    console.log(
      JSON.stringify(
        {
          mode: apply ? "apply" : "dry-run",
          pairings: pairings.length,
          wouldInsertLinks: report.filter((r) => r.action === "dry-run-insert").length,
          insertedCommunities,
          reusedCommunities,
          insertedLinks,
          skippedExistingLinks,
          skippedUnmatchedSchool,
          unmatchedSchoolCount: unmatchedSchoolNames.size,
          unmatchedSchools: [...unmatchedSchoolNames].sort(),
        },
        null,
        2,
      ),
    );
    console.log("No deletes, resets, seeds, overwrites, or updates were performed.");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
