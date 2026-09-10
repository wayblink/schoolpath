/**
 * Backfill missing school addresses from Baidu Map public mobile detail pages.
 *
 * Safety rules:
 * - address-only: never updates lat/lng
 * - no truncate/delete/seed
 * - exports a JSON snapshot of target rows before any write
 * - default mode is dry-run; pass --apply to update
 * - supports --district=<name>, --limit=<n>, --min-score=<n>
 * - only fills blank/null address; existing nonblank address is not overwritten
 * - UPDATE is guarded by id + name + district + blank address
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

const { Client } = pg;

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
const apply = process.argv.includes("--apply");
const district = valueArg("--district");
const limit = numberArg("--limit");
const minScore = numberArg("--min-score") ?? 150;

if (!databaseUrl) throw new Error("DATABASE_URL is required.");

type SchoolRow = {
  id: number;
  name: string;
  district: string;
  type: "primary" | "middle" | "nine_year";
  address: string | null;
};

type BaiduSuggestion = {
  raw: string;
  city: string;
  district: string;
  name: string;
  cityId: string;
  uid: string;
};

type BaiduDetail = {
  uid: string;
  name: string;
  address: string;
  stdTag: string;
  phone?: string;
  cityName?: string;
};

type Match = {
  uid: string;
  poiName: string;
  poiType: string;
  address: string;
  score: number;
  suggestionName: string;
};

class SourceBlockedError extends Error {}

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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSchoolName(value: string) {
  return value
    .replace(/[\s　]+/g, "")
    .replace(/[（）()]/g, "")
    .replace(/^上海市/, "")
    .replace(/区/g, "")
    .replace(/学校名称/g, "")
    .replace(/学校|小学|中学|初级|初中|实验|附属|校区|总部|分部|公办|民办/g, "")
    .trim();
}

function addressHasOtherShanghaiDistrict(address: string, district: string) {
  const match = address.match(/上海市([^市县]+?区)/);
  return Boolean(match?.[1] && !match[1].includes(district));
}

function parseSuggestion(raw: string): BaiduSuggestion | null {
  const parts = raw.split("$");
  const name = parts[3]?.trim();
  const uid = parts[5]?.trim();
  if (!name || !uid) return null;
  return {
    raw,
    city: parts[0]?.trim() ?? "",
    district: (parts[1] || parts[7] || "").trim(),
    name,
    cityId: parts[4]?.trim() ?? "",
    uid,
  };
}

function extractEmbeddedData(html: string) {
  const marker = "var data = ";
  const start = html.indexOf(marker);
  if (start < 0) return null;

  let index = start + marker.length;
  while (/\s/.test(html[index] ?? "")) index++;
  if (html[index] !== "{") return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = index; i < html.length; i++) {
    const char = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }

    if (char === "\"") inString = true;
    else if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return html.slice(index, i + 1);
    }
  }

  return null;
}

async function fetchText(url: URL | string) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
      Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.text();
}

async function fetchSuggestions(query: string) {
  const url = new URL("https://map.baidu.com/su");
  url.searchParams.set("wd", query);
  url.searchParams.set("cid", "289");
  url.searchParams.set("type", "0");
  url.searchParams.set("newmap", "1");
  url.searchParams.set("pc_ver", "2");

  const text = await fetchText(url);
  const data = JSON.parse(text) as { s?: string[] };
  return (data.s ?? []).map(parseSuggestion).filter((item): item is BaiduSuggestion => Boolean(item));
}

async function fetchDetail(uid: string): Promise<BaiduDetail | null> {
  const url = `https://map.baidu.com/mobile/webapp/place/detail/qt=inf&uid=${encodeURIComponent(uid)}/vt=map`;
  const html = await fetchText(url);
  const raw = extractEmbeddedData(html);
  if (!raw) {
    if (/验证|安全校验|captcha/i.test(html)) throw new SourceBlockedError("Baidu mobile detail returned a verification page");
    return null;
  }

  const data = JSON.parse(raw) as {
    content?: {
      uid?: string;
      name?: string;
      addr?: string;
      std_tag?: string;
      phone?: string;
      city_name?: string;
    };
  };
  const content = data.content;
  const name = content?.name?.trim();
  const address = content?.addr?.trim();
  if (!name || !address) return null;

  return {
    uid: content?.uid ?? uid,
    name,
    address,
    stdTag: content?.std_tag ?? "",
    phone: content?.phone,
    cityName: content?.city_name,
  };
}

function ordinalAliasScore(schoolName: string, poiName: string) {
  const numeral = "一二三四五六七八九十";
  const middle = schoolName.match(new RegExp(`([${numeral}])中`));
  if (middle && poiName.includes(`第${middle[1]}`) && /中学/.test(poiName)) return 80;

  const center = schoolName.match(new RegExp(`([${numeral}])中心`));
  if (center && poiName.includes(`第${center[1]}中心`)) return 80;

  return 0;
}

function hasStrictOrdinalAliasMismatch(schoolName: string, poiName: string) {
  const numeral = "一二三四五六七八九十";
  const middle = schoolName.match(new RegExp(`([${numeral}])中`));
  if (middle) return !poiName.includes(`第${middle[1]}`) && !poiName.includes(`${middle[1]}中`);

  const center = schoolName.match(new RegExp(`([${numeral}])中心`));
  if (center) return !poiName.includes(`第${center[1]}中心`) && !poiName.includes(`${center[1]}中心`);

  return false;
}

function isMeaningfulSchoolPoi(school: SchoolRow, detail: BaiduDetail) {
  const name = detail.name;
  if (/实验室|研究中心|服务中心|活动中心|商业|商场|餐|店|医院/.test(name)) return false;
  if (/停车场|出入口|[东南西北]门|门卫|门岗|治安岗|警务|保安|教学楼|[0-9一二三四五六七八九十]+号楼/.test(name)) return false;

  if (school.type === "primary") return /小学|附小|学校/.test(name);
  if (school.type === "middle") return /中学|初中|初级|附中|学校/.test(name) && !/小学部|小学$/.test(name);
  return /学校|小学|中学|初中|初级|附小|附中/.test(name);
}

function scoreDetail(school: SchoolRow, suggestion: BaiduSuggestion, detail: BaiduDetail) {
  if (suggestion.city && suggestion.city !== "上海市") return -100;
  if (detail.cityName && detail.cityName !== "上海市") return -100;
  if (addressHasOtherShanghaiDistrict(detail.address, school.district)) return -100;

  const combined = `${suggestion.name}${detail.name}${detail.stdTag}`;
  const looksLikeSchool = /学校|小学|中学|教育培训/.test(combined);
  if (!looksLikeSchool) return -100;
  if (!isMeaningfulSchoolPoi(school, detail)) return -100;
  if (/幼儿园|培训中心|培训学校|驾校|大学|学院/.test(combined)) return -100;
  if (/停车场|出入口|[东南西北]门|门卫|公交站|地铁站/.test(combined)) return -100;
  if (school.type === "middle" && /小学/.test(detail.name) && !/中学|初级中学|九年|实验学校/.test(combined)) return -100;
  if (school.type === "primary" && /中学|初级中学|高中/.test(detail.name) && !/小学|九年|实验学校/.test(combined)) return -100;
  if (hasStrictOrdinalAliasMismatch(school.name, detail.name)) return -100;

  let score = 0;
  const districtHit =
    suggestion.district.includes(school.district) || detail.address.includes(school.district);
  if (districtHit) score += 25;
  else score -= 45;

  score += 20;

  const schoolName = normalizeSchoolName(school.name);
  const poiName = normalizeSchoolName(detail.name);
  const suggestionName = normalizeSchoolName(suggestion.name);

  if (detail.name === school.name || suggestion.name === school.name) score += 120;
  if (detail.name.includes(school.name) || school.name.includes(detail.name)) score += 85;
  if (suggestion.name.includes(school.name) || school.name.includes(suggestion.name)) score += 75;
  if (schoolName && poiName && (poiName.includes(schoolName) || schoolName.includes(poiName))) score += 75;
  if (schoolName && suggestionName && (suggestionName.includes(schoolName) || schoolName.includes(suggestionName))) score += 65;
  score += ordinalAliasScore(school.name, detail.name);

  const schoolChars = new Set(schoolName);
  for (const char of new Set(`${poiName}${suggestionName}`)) {
    if (schoolChars.has(char)) score += 1;
  }

  if (school.type === "primary" && /小学/.test(detail.name)) score += 10;
  if (school.type === "middle" && /中学|初级中学|初中/.test(`${detail.name}${detail.stdTag}`)) score += 10;
  if (school.type === "nine_year" && /学校/.test(detail.name)) score += 8;

  return score;
}

async function poiSearch(school: SchoolRow): Promise<Match | null> {
  const queries = [`上海 ${school.district} ${school.name}`, `上海 ${school.name}`];
  const suggestionsByUid = new Map<string, BaiduSuggestion>();

  for (const query of queries) {
    const suggestions = await fetchSuggestions(query);
    for (const suggestion of suggestions.slice(0, 10)) {
      if (!suggestionsByUid.has(suggestion.uid)) suggestionsByUid.set(suggestion.uid, suggestion);
    }
    await sleep(120);
  }

  const ranked: Array<{ suggestion: BaiduSuggestion; detail: BaiduDetail; score: number }> = [];
  for (const suggestion of suggestionsByUid.values()) {
    const detail = await fetchDetail(suggestion.uid);
    if (!detail) continue;
    ranked.push({ suggestion, detail, score: scoreDetail(school, suggestion, detail) });
    await sleep(180);
  }

  ranked.sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < minScore) return null;

  return {
    uid: best.detail.uid,
    poiName: best.detail.name,
    poiType: best.detail.stdTag,
    address: best.detail.address,
    score: best.score,
    suggestionName: best.suggestion.name,
  };
}

function outputPaths() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "school-address-baidu-mobile", stamp);
  mkdirSync(dir, { recursive: true });
  return {
    stamp,
    dir,
    snapshot: path.join(dir, "target-schools-before.json"),
    matches: path.join(dir, apply ? "matches-applied.json" : "matches-dry-run.json"),
  };
}

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const params: Array<string | number> = [];
    const where: string[] = ["(address IS NULL OR btrim(address) = '')"];

    if (district) {
      params.push(district);
      where.push(`district = $${params.length}`);
    }

    let limitSql = "";
    if (limit) {
      params.push(limit);
      limitSql = `LIMIT $${params.length}`;
    }

    const target = await client.query<SchoolRow>(
      `
        SELECT id, name, district, type, address
        FROM schools
        WHERE ${where.join(" AND ")}
        ORDER BY district, id
        ${limitSql}
      `,
      params,
    );

    const paths = outputPaths();
    writeFileSync(paths.snapshot, JSON.stringify(target.rows, null, 2), "utf8");
    console.log(`Target schools: ${target.rows.length}${district ? ` (district=${district})` : ""}`);
    console.log(`Snapshot: ${paths.snapshot}`);
    console.log(`Mode: ${apply ? "apply" : "dry-run"}, minScore=${minScore}`);

    const records: Array<{ school: SchoolRow; match: Match | null; action: string; updatedRows?: number }> = [];
    let matched = 0;
    let updated = 0;
    let backupTable: string | null = null;

    await client.query("BEGIN");
    if (apply) {
      backupTable = `schools_address_baidu_backup_${paths.stamp.replace(/-/g, "_")}`;
      await client.query(`CREATE TABLE ${backupTable} AS SELECT * FROM schools`);
      console.log(`Backup table: ${backupTable}`);
    }

    for (const school of target.rows) {
      if (/^(学校名称|初中学区|小学学区|公办\s*[（(])/.test(school.name.trim())) {
        console.log(`SKIP invalid placeholder id=${school.id} ${school.district} ${school.name}`);
        records.push({ school, match: null, action: "skip-placeholder-name" });
        continue;
      }

      let match: Match | null = null;
      try {
        match = await poiSearch(school);
      } catch (error) {
        if (error instanceof SourceBlockedError) {
          console.log(`STOP ${error.message}`);
          records.push({ school, match: null, action: "stop-source-blocked" });
          break;
        }
        throw error;
      }

      if (!match) {
        console.log(`MISS id=${school.id} ${school.district} ${school.name}`);
        records.push({ school, match: null, action: "miss" });
        continue;
      }

      matched++;
      console.log(
        `${apply ? "UPDATE" : "DRY"} id=${school.id} ${school.district} ${school.name} -> ${match.poiName} | ${match.address} | score=${match.score}`,
      );

      let updatedRows = 0;
      if (apply) {
        const update = await client.query(
          `
            UPDATE schools
            SET
              address = $1,
              attrs = jsonb_set(
                coalesce(attrs, '{}'::jsonb),
                '{baidu_mobile_school_address_match}',
                $2::jsonb,
                true
              ),
              updated_at = now()
            WHERE id = $3
              AND name = $4
              AND district = $5
              AND (address IS NULL OR btrim(address) = '')
          `,
          [
            match.address,
            JSON.stringify({
              provider: "baidu_mobile",
              uid: match.uid,
              poi_name: match.poiName,
              suggestion_name: match.suggestionName,
              poi_type: match.poiType,
              score: match.score,
              source: "baidu_mobile_detail_page",
              fetched_at: new Date().toISOString(),
              filled: { address: true, lat: false, lng: false },
            }),
            school.id,
            school.name,
            school.district,
          ],
        );
        updatedRows = update.rowCount ?? 0;
        updated += updatedRows;
      }

      records.push({ school, match, action: apply ? "updated-if-still-missing" : "dry-run", updatedRows });
    }

    writeFileSync(paths.matches, JSON.stringify({ backupTable, records }, null, 2), "utf8");

    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");

    console.log(`Matches: ${paths.matches}`);
    console.log(`Done. matched=${matched}, updated=${updated}, apply=${apply}`);
    console.log("No deletes, resets, seeds, or coordinate updates were performed.");
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
