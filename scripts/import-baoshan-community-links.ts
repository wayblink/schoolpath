/**
 * Safely import Baoshan official school-area text into communities + school_communities.
 *
 * Safety rules:
 * - default mode is dry-run; pass --apply to insert
 * - only inserts missing rows; never deletes, truncates, resets, seeds, or overwrites
 * - snapshots current Baoshan communities/links and writes a detailed report under .tmp
 * - uses official boundary text already stored on Baoshan school rows
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

const { Client } = pg;

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const district = valueArg("--district") ?? "宝山";
const year = Number(valueArg("--year") ?? "2025");
if (!Number.isInteger(year)) throw new Error("--year must be an integer.");

type SchoolType = "primary" | "middle" | "nine_year";

type SchoolRow = {
  id: number;
  name: string;
  district: string;
  type: SchoolType;
  enrollment_note: string | null;
  attrs: Record<string, unknown> | null;
};

type CommunityRow = {
  id: number;
  name: string;
  district: string;
  source_committee: string | null;
};

type LinkRow = {
  id: number;
  school_id: number;
  community_id: number;
  year: number;
};

type ParsedArea = {
  schoolId: number;
  schoolName: string;
  schoolType: SchoolType;
  communityName: string;
  committeeName: string | null;
  sourceQuote: string;
  sourceUrl: string | null;
  sourceDate: string;
  areaKind: "residential_area" | "committee_scope" | "farm_or_unit";
};

type PlannedAction = {
  source: ParsedArea;
  action: "dry-run-insert" | "insert" | "skip-existing-link" | "skip-duplicate-source";
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
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "baoshan-community-link-import", stamp);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    schoolsSnapshot: path.join(dir, "baoshan-schools-source.json"),
    communitiesSnapshot: path.join(dir, "baoshan-communities-before.json"),
    linksSnapshot: path.join(dir, "baoshan-school-community-links-before.json"),
    parsed: path.join(dir, "parsed-baoshan-community-links.json"),
    report: path.join(dir, apply ? "import-applied.json" : "import-dry-run.json"),
  };
}

function normalizeName(value: string) {
  return value
    .replace(/[（）]/g, (char) => (char === "（" ? "(" : ")"))
    .replace(/\s+/g, "")
    .replace(/[,，;；、]+$/g, "")
    .trim();
}

function splitTopLevel(value: string) {
  const result: string[] = [];
  let buffer = "";
  let depth = 0;
  for (const char of value) {
    if (char === "（" || char === "(") depth += 1;
    if (char === "）" || char === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && /[、，,；;]/.test(char)) {
      const item = cleanItem(buffer);
      if (item) result.push(item);
      buffer = "";
      continue;
    }
    buffer += char;
  }
  const last = cleanItem(buffer);
  if (last) result.push(last);
  return result;
}

function splitNested(value: string) {
  return value
    .split(/[、，,；;]/)
    .map(cleanItem)
    .filter(Boolean);
}

function cleanItem(value: string) {
  return value
    .replace(/\s+/g, " ")
    .replace(/^及/, "")
    .replace(/^[-—]+/, "")
    .replace(/[,，;；、]+$/g, "")
    .trim();
}

function stripOuterParens(value: string) {
  return value.replace(/^[（(]\s*/, "").replace(/\s*[）)]$/, "").trim();
}

function isCommitteeLike(value: string) {
  return /居委|居委会|村委|村委会|社区|居民区/.test(value) || /[一二三四五六七八九十]居$/.test(value);
}

function isNonCommunityArea(value: string) {
  return /农场|部队|集体户口|校区|学区/.test(value);
}

function isLikelyAddressFragment(value: string) {
  return (
    /^\d+$/.test(value) ||
    /^\d+号(?:甲|乙|丙|丁)?$/.test(value) ||
    /^\d+-\d+号$/.test(value) ||
    /^\d+[-－—]\d+号$/.test(value) ||
    /^\d+[-－—]\d+$/.test(value) ||
    /^\d+弄$/.test(value) ||
    /^[\d、，,\-—至到号甲乙丙丁]+$/.test(value)
  );
}

function startsWithNegativeQualifier(value: string) {
  return /^(除|不含|附近|原则上|原|现|以|东至|南至|西至|北至)/.test(value);
}

function isPlanningQualifier(value: string) {
  return /^(筹|暂定|过渡|2025年暂定)$/.test(value) || /^(筹|暂定|过渡|2025年暂定)[）)]?$/.test(value);
}

function cleanPositiveDetail(value: string) {
  const detail = cleanItem(value)
    .replace(/^(包括|含)/, "")
    .replace(/[:：]+$/, "")
    .trim();
  if (!detail) return "";
  if (startsWithNegativeQualifier(detail)) return "";
  if (isPlanningQualifier(detail)) return "";
  return detail;
}

function appendDetailName(base: string, detail: string) {
  if (!detail || base.includes(detail)) return base;
  if (/^\d/.test(detail) || /路|弄|号/.test(detail)) return `${base}（${detail}）`;
  return detail;
}

function parentheticalParts(value: string) {
  const groups: string[] = [];
  let base = "";
  let buffer = "";
  let trailing = "";
  let depth = 0;
  for (const char of value) {
    if (char === "（" || char === "(") {
      if (depth === 0) {
        if (!base) base = buffer.trim();
        buffer = "";
      } else {
        buffer += char;
      }
      depth += 1;
      continue;
    }
    if (char === "）" || char === ")") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0) {
          groups.push(buffer.trim());
          buffer = "";
          continue;
        }
      }
    }
    buffer += char;
    if (base && depth === 0) trailing += char;
  }
  if (!base) return null;
  if (trailing.trim()) return null;
  if (buffer.trim()) groups.push(buffer.trim());
  return { base: cleanItem(base), groups };
}

function expandShortOrdinalItems(items: string[]) {
  const expanded: string[] = [];
  let prefix: string | null = null;
  for (const item of items) {
    const current = cleanItem(item);
    if (!current) continue;

    const shortOrdinal = current.match(/^(第?[一二三四五六七八九十]+居(?:委)?)$/);
    if (shortOrdinal && prefix) {
      expanded.push(`${prefix}${current}`);
      continue;
    }

    const fullOrdinal = current.match(/^(.+?)(第?[一二三四五六七八九十]+居(?:委)?)$/);
    if (fullOrdinal) {
      prefix = fullOrdinal[1] ?? null;
      expanded.push(current);
      continue;
    }

    const bareOrdinal = current.match(/^(.+?)(第?[一二三四五六七八九十]+)$/);
    if (bareOrdinal && /[村苑园庭邸城]$/.test(bareOrdinal[1] ?? "")) {
      prefix = bareOrdinal[1] ?? null;
      expanded.push(`${current}居委`);
      continue;
    }

    const shortSequence = current.match(/^第?[一二三四五六七八九十]+$/);
    if (shortSequence && prefix) {
      expanded.push(`${prefix}${current}居委`);
      continue;
    }

    expanded.push(current);
  }
  return expanded;
}

function expandBoundaryItems(enrollmentNote: string) {
  const output: Array<{ communityName: string; committeeName: string | null; kind: ParsedArea["areaKind"] }> = [];
  for (const rawItem of expandShortOrdinalItems(splitTopLevel(enrollmentNote))) {
    const item = cleanItem(rawItem);
    if (!item) continue;

    const parts = parentheticalParts(item);
    if (parts) {
      const base = parts.base;
      const committee = isCommitteeLike(base) ? base : null;

      if (parts.groups.some(startsWithNegativeQualifier)) {
        output.push({
          communityName: base,
          committeeName: committee,
          kind: isNonCommunityArea(base) ? "farm_or_unit" : committee ? "committee_scope" : "residential_area",
        });
        continue;
      }

      const details = parts.groups.flatMap((group) => splitNested(stripOuterParens(group)).map(cleanPositiveDetail)).filter(Boolean);
      if (committee && details.length > 0) {
        for (const detail of details) {
          if (isLikelyAddressFragment(detail) && !/[路弄号村花园公寓小区新村苑园庭邸城]/.test(base)) continue;
          const communityName = appendDetailName(base, detail);
          output.push({
            communityName,
            committeeName: committee,
            kind: isNonCommunityArea(communityName) ? "farm_or_unit" : "residential_area",
          });
        }
        continue;
      }

      const preservedName = details.length === 0 ? base : item;
      output.push({
        communityName: preservedName,
        committeeName: committee,
        kind: isNonCommunityArea(preservedName) ? "farm_or_unit" : committee ? "committee_scope" : "residential_area",
      });
      continue;
    }

    output.push({
      communityName: item,
      committeeName: isCommitteeLike(item) ? item : null,
      kind: isNonCommunityArea(item) ? "farm_or_unit" : isCommitteeLike(item) ? "committee_scope" : "residential_area",
    });
  }

  const seen = new Set<string>();
  return output.filter((row) => {
    const name = cleanCommunityName(row.communityName);
    if (!name) return false;
    if (isLikelyAddressFragment(name)) return false;
    const key = `${normalizeName(name)}::${normalizeName(row.committeeName ?? "")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    row.communityName = name;
    return true;
  });
}

function cleanCommunityName(value: string) {
  const cleaned = cleanItem(value)
    .replace(/^[（(]\s*除\s*/, "")
    .replace(/（\s*）/g, "")
    .trim();
  if (isPlanningQualifier(cleaned)) return "";
  if (/^全[市区]$/.test(cleaned)) return "";
  return cleaned;
}

function attrsString(attrs: Record<string, unknown> | null, key: string) {
  const value = attrs?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseAreas(schools: SchoolRow[]) {
  const rows: ParsedArea[] = [];
  for (const school of schools) {
    const note = school.enrollment_note?.trim();
    if (!note) continue;
    const sourceUrl = attrsString(school.attrs, "official_boundary_source") ?? attrsString(school.attrs, "policy_url");
    const sourceDate =
      typeof school.attrs?.official_school_info_source === "object" &&
      school.attrs.official_school_info_source != null &&
      "date" in school.attrs.official_school_info_source &&
      typeof school.attrs.official_school_info_source.date === "string"
        ? school.attrs.official_school_info_source.date
        : "2025-04-07";

    for (const area of expandBoundaryItems(note)) {
      rows.push({
        schoolId: school.id,
        schoolName: school.name,
        schoolType: school.type,
        communityName: area.communityName,
        committeeName: area.committeeName,
        sourceQuote: note,
        sourceUrl,
        sourceDate,
        areaKind: area.kind,
      });
    }
  }
  return rows;
}

function communityKey(name: string) {
  return `${district}::${normalizeName(name)}`;
}

function sourceKey(row: ParsedArea) {
  return `${row.schoolId}::${communityKey(row.communityName)}::${year}`;
}

async function ensureCommunity(client: pg.Client, existingByKey: Map<string, CommunityRow>, row: ParsedArea) {
  const key = communityKey(row.communityName);
  const existing = existingByKey.get(key);
  if (existing) return existing;
  if (!apply) return undefined;

  const result = await client.query<CommunityRow>(
    `
      INSERT INTO communities (
        name, district, source_committee, source_query, source_url, source_name, source_date,
        verified, notes, attrs
      )
      VALUES ($1, $2, $3, $4, $5, 'official_baoshan_boundary_text', $6, false, $7, $8::jsonb)
      ON CONFLICT (name, district) DO NOTHING
      RETURNING id, name, district, source_committee
    `,
    [
      row.communityName,
      district,
      row.committeeName,
      `${district} ${row.communityName}`,
      row.sourceUrl,
      row.sourceDate,
      "官方招生范围文本拆分导入；未补高德坐标，需后续核验。",
      JSON.stringify({ import_kind: row.areaKind, source_school_id: row.schoolId, source_school_name: row.schoolName }),
    ],
  );

  const inserted =
    result.rows[0] ??
    (
      await client.query<CommunityRow>(
        `
          SELECT id, name, district, source_committee
          FROM communities
          WHERE district = $1 AND name = $2
          LIMIT 1
        `,
        [district, row.communityName],
      )
    ).rows[0];
  if (!inserted) throw new Error(`Failed to insert/find community: ${row.communityName}`);
  existingByKey.set(key, inserted);
  return inserted;
}

async function main() {
  const paths = outputPaths();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const schools = await client.query<SchoolRow>(
      `
        SELECT id, name, district, type, enrollment_note, attrs
        FROM schools
        WHERE district = $1
        ORDER BY id
      `,
      [district],
    );
    writeFileSync(paths.schoolsSnapshot, JSON.stringify(schools.rows, null, 2), "utf8");

    const communities = await client.query<CommunityRow>(
      `
        SELECT id, name, district, source_committee
        FROM communities
        WHERE district = $1
        ORDER BY id
      `,
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

    const parsedRows = parseAreas(schools.rows);
    writeFileSync(paths.parsed, JSON.stringify(parsedRows, null, 2), "utf8");

    const existingCommunities = new Map(communities.rows.map((row) => [communityKey(row.name), row]));
    const existingLinks = new Set(links.rows.map((row) => `${row.school_id}::${row.community_id}::${row.year}`));
    const seenSource = new Set<string>();
    const report: PlannedAction[] = [];
    let insertedCommunities = 0;
    let reusedCommunities = 0;
    let insertedLinks = 0;
    let skippedExistingLinks = 0;
    let skippedDuplicateSource = 0;

    console.log(`Mode: ${apply ? "apply" : "dry-run"}`);
    console.log(`District: ${district}`);
    console.log(`Year: ${year}`);
    console.log(`Schools: ${schools.rows.length}`);
    console.log(`Existing ${district} communities: ${communities.rows.length}`);
    console.log(`Existing ${district} links: ${links.rows.length}`);
    console.log(`Parsed official area rows: ${parsedRows.length}`);
    console.log(`Output: ${paths.dir}`);

    await client.query("BEGIN");
    for (const row of parsedRows) {
      const dedupeKey = sourceKey(row);
      if (seenSource.has(dedupeKey)) {
        skippedDuplicateSource += 1;
        report.push({ source: row, action: "skip-duplicate-source" });
        continue;
      }
      seenSource.add(dedupeKey);

      const existedCommunity = existingCommunities.has(communityKey(row.communityName));
      const community = await ensureCommunity(client, existingCommunities, row);
      if (existedCommunity) reusedCommunities += 1;
      else if (apply) insertedCommunities += 1;

      const linkKey = community ? `${row.schoolId}::${community.id}::${year}` : dedupeKey;
      if (community && existingLinks.has(linkKey)) {
        skippedExistingLinks += 1;
        report.push({ source: row, action: "skip-existing-link", communityId: community.id });
        continue;
      }

      if (!apply) {
        report.push({ source: row, action: "dry-run-insert" });
        continue;
      }

      const result = await client.query<{ id: number }>(
        `
          INSERT INTO school_communities (
            school_id, community_id, committee_name, year, source_name, source_url, source_quote,
            source_date, verified, notes
          )
          VALUES ($1, $2, $3, $4, 'official_baoshan_boundary_text', $5, $6, $7, false, $8)
          ON CONFLICT (school_id, community_id, year) DO NOTHING
          RETURNING id
        `,
        [
          row.schoolId,
          community!.id,
          row.committeeName,
          year,
          row.sourceUrl,
          row.sourceQuote,
          row.sourceDate,
          "官方招生范围文本拆分导入；未补高德坐标，需后续核验。",
        ],
      );
      const insertedLinkId = result.rows[0]?.id;
      if (insertedLinkId) {
        existingLinks.add(linkKey);
        insertedLinks += 1;
        report.push({ source: row, action: "insert", communityId: community!.id, linkId: insertedLinkId });
      } else {
        skippedExistingLinks += 1;
        report.push({ source: row, action: "skip-existing-link", communityId: community!.id });
      }
    }

    writeFileSync(paths.report, JSON.stringify(report, null, 2), "utf8");
    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");

    console.log(`Report: ${paths.report}`);
    console.log(
      JSON.stringify(
        {
          mode: apply ? "apply" : "dry-run",
          parsed: parsedRows.length,
          wouldInsertLinks: report.filter((row) => row.action === "dry-run-insert").length,
          insertedCommunities,
          reusedCommunities,
          insertedLinks,
          skippedExistingLinks,
          skippedDuplicateSource,
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
