/**
 * Extract official school-community candidates from audited enrollment sources.
 *
 * Dry-run by default: writes JSON reports under .tmp and does not touch DB.
 * Pass --apply after creating school_community_candidates to upsert candidates.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();

const { Client } = pg;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

type AuditSource = {
  year: number;
  district: string;
  title: string;
  url: string | null;
  category: string;
  sourceName: string;
};

type AuditFile = {
  rows: Array<{
    year: number;
    district: string;
    sources: AuditSource[];
  }>;
};

type SchoolRow = {
  id: number;
  name: string;
  aliases: string[] | null;
  district: string;
  type: string;
};

type Candidate = {
  year: number;
  district: string;
  schoolId: number | null;
  schoolNameRaw: string;
  communityNameRaw: string;
  committeeNameRaw: string | null;
  sourceUrl: string | null;
  sourceTitle: string;
  sourceDate: string | null;
  sourceQuote: string;
  confidence: "high" | "medium" | "low";
  status: "pending";
  raw: Record<string, unknown>;
};

type FetchResult = {
  html: string;
  text: string;
  contentType: string;
};

type ScopeLink = {
  url: string;
  label: string;
  score: number;
};

type TableCell = {
  text: string;
  colspan: number;
  rowspan: number;
};

const DEFAULT_AUDIT_PATH = path.join(process.cwd(), "data", "school-district-sources-audit.json");
const years = valueArg("--years")
  ?.split(",")
  .map((item) => Number(item.trim()))
  .filter((item) => Number.isFinite(item) && item > 2000);
const districts = new Set(
  (valueArg("--districts") ?? "")
    .split(",")
    .map((item) => item.trim().replace(/区$/, ""))
    .filter(Boolean),
);
const auditPath = valueArg("--audit") ?? DEFAULT_AUDIT_PATH;
const cacheDir = valueArg("--cache-dir") ?? path.join(process.cwd(), ".tmp", "official-policy-cache");
const localFile = valueArg("--local-file");
const localTitle = valueArg("--local-title");
const localDistrict = valueArg("--local-district")?.replace(/区$/, "");
const localYear = Number(valueArg("--local-year") ?? 2025);
const limit = Number(valueArg("--limit") ?? 0);
const apply = process.argv.includes("--apply");

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1]?.trim();
  return undefined;
}

function normalizeText(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtml(value: string) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&ldquo;|&rdquo;|&quot;/g, "\"")
    .replace(/&lsquo;|&rsquo;/g, "'")
    .replace(/&mdash;|&#8212;|&#x2014;/gi, "-")
    .replace(/&ndash;|&#8211;|&#x2013;/gi, "-");
}

function decodeXmlText(value: string) {
  return decodeHtml(value)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function htmlToText(value: string) {
  return decodeHtml(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>|<\/div>|<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function splitSentences(text: string) {
  return text
    .replace(/[；;]/g, "。\n")
    .replace(/[。!?！？]/g, "。\n")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 8);
}

function normalizeName(value: string) {
  return value
    .replace(/^上海市/, "")
    .replace(/（.*?）|\(.*?\)/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function sourceYear(source: AuditSource) {
  const match = source.title.match(/20\d{2}/);
  return match ? match[0] : String(source.year);
}

function sourceDate(source: AuditSource) {
  return sourceYear(source);
}

function isScopeSource(source: AuditSource) {
  return source.category === "primary-scope" || source.category === "middle-scope";
}

function sourceTextSignals(title: string) {
  return /划片|范围|地段|对口|入学方式|学区划分|招生方案/.test(title);
}

function cachePathForUrl(url: string) {
  const safeName = url
    .replace(/^https?:\/\//, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .slice(0, 180);
  return path.join(cacheDir, `${safeName}.html`);
}

function resolveUrl(href: string, baseUrl: string | null) {
  try {
    return new URL(decodeHtml(href).trim(), baseUrl ?? undefined).toString();
  } catch {
    return null;
  }
}

function isFollowableScopeUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!parsed.hostname.endsWith(".gov.cn") && parsed.hostname !== "shrxbm.edu.sh.gov.cn") return false;
  if (parsed.pathname === "/" || parsed.pathname === "") return false;
  if (/\.(?:png|jpe?g|gif|webp|bmp|svg|zip|rar|docx?|xlsx?|pptx?)($|\?)/i.test(parsed.pathname)) return false;
  return /\.(?:s?html?|php)($|\?)/i.test(parsed.pathname) || !/\.[a-z0-9]{2,5}$/i.test(parsed.pathname);
}

function isXlsxUrl(url: string) {
  try {
    return new URL(url).pathname.endsWith(".xlsx");
  } catch {
    return false;
  }
}

function scopeLinkScore(source: AuditSource, url: string, label: string) {
  const linkText = `${label} ${url}`;
  if (!/20\d{2}|小学|初中|一年级|六年级|招生|划片|地段|范围|对口|入学/.test(linkText)) return 0;
  const text = `${source.title} ${linkText}`;
  let score = 0;
  if (/20\d{2}/.test(text)) score += 3;
  if (/小学|初中|一年级|六年级/.test(text)) score += 2;
  if (/招生|划片|地段|范围|对口|入学/.test(text)) score += 4;
  if (source.category === "primary-scope" && /小学|一年级/.test(text)) score += 2;
  if (source.category === "middle-scope" && /初中|六年级|小升初/.test(text)) score += 2;
  return score;
}

function extractFollowableScopeLinks(source: AuditSource, fetched: FetchResult) {
  const links = new Map<string, ScopeLink>();
  if (!source.url) return [];

  for (const match of fetched.html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const resolved = resolveUrl(match[1], source.url);
    if (!resolved || !isFollowableScopeUrl(resolved)) continue;
    const label = htmlToText(match[2]);
    const score = scopeLinkScore(source, resolved, label);
    if (score >= 5) links.set(resolved, { url: resolved, label, score });
  }

  for (const match of `${fetched.text} ${fetched.html}`.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
    const resolved = resolveUrl(match[0].replace(/[，。；;、)）]+$/, ""), source.url);
    if (!resolved || !isFollowableScopeUrl(resolved)) continue;
    const score = scopeLinkScore(source, resolved, resolved);
    if (score >= 5 && !links.has(resolved)) links.set(resolved, { url: resolved, label: resolved, score });
  }

  return [...links.values()].sort((a, b) => b.score - a.score);
}

function extractXlsxAttachmentLinks(source: AuditSource, fetched: FetchResult) {
  if (!source.url) return [];
  const links = new Map<string, ScopeLink>();
  for (const match of fetched.html.matchAll(/<a\b[^>]*href=["']([^"']+\.xlsx(?:\?[^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const resolved = resolveUrl(match[1], source.url);
    if (!resolved || !isXlsxUrl(resolved)) continue;
    const label = htmlToText(match[2]);
    const score = scopeLinkScore(source, resolved, label);
    if (score >= 5) links.set(resolved, { url: resolved, label, score });
  }
  return [...links.values()].sort((a, b) => b.score - a.score);
}

function candidateSignals(text: string) {
  return /小区|居委|村委|街道|路|弄|号|招生范围|对口|地段|学区|范围/.test(text);
}

function compactQuote(text: string, max = 420) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function attrNumber(tag: string, name: string) {
  const match = tag.match(new RegExp(`${name}=["']?(\\d+)`, "i"));
  return match ? Number(match[1]) : 1;
}

function extractTables(html: string) {
  const tables: string[][][] = [];
  const tableMatches = html.match(/<table\b[\s\S]*?<\/table>/gi) ?? [];
  for (const tableHtml of tableMatches) {
    const rawRows = tableHtml.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? [];
    const rows: string[][] = [];
    const rowspans: Array<{ text: string; remaining: number }> = [];

    for (const rowHtml of rawRows) {
      const cells: string[] = [];
      let colIndex = 0;
      const cellMatches = rowHtml.match(/<(?:td|th)\b[\s\S]*?<\/(?:td|th)>/gi) ?? [];
      for (const cellHtml of cellMatches) {
        while (rowspans[colIndex]?.remaining > 0) {
          cells[colIndex] = rowspans[colIndex].text;
          rowspans[colIndex].remaining -= 1;
          colIndex += 1;
        }

        const openTag = cellHtml.match(/^<[^>]+>/)?.[0] ?? "";
        const cell: TableCell = {
          text: htmlToText(cellHtml),
          colspan: attrNumber(openTag, "colspan"),
          rowspan: attrNumber(openTag, "rowspan"),
        };
        for (let offset = 0; offset < cell.colspan; offset += 1) {
          cells[colIndex + offset] = cell.text;
          if (cell.rowspan > 1) {
            rowspans[colIndex + offset] = { text: cell.text, remaining: cell.rowspan - 1 };
          }
        }
        colIndex += cell.colspan;
      }

      while (rowspans[colIndex]?.remaining > 0) {
        cells[colIndex] = rowspans[colIndex].text;
        rowspans[colIndex].remaining -= 1;
        colIndex += 1;
      }
      if (cells.some((cell) => cell.trim())) rows.push(cells.map((cell) => cell.trim()));
    }
    if (rows.length > 0) tables.push(rows);
  }
  return tables;
}

function headerKind(value: string) {
  const text = value.replace(/\s+/g, "");
  if (/学校名称|校名|学校$/.test(text)) return "school";
  if (/划片范围|对口区域范围|户籍对口.*范围|招生地块|相对就近对口居委|对口居委|对口路牌|招生范围|校区范围|地段|学区/.test(text)) {
    return "area";
  }
  if (/所属街道|对口街镇|镇区|街镇/.test(text)) return "committee";
  if (/学校地址|地址/.test(text)) return "address";
  if (/备注|说明/.test(text)) return "notes";
  if (/招生计划|计划招生|班数/.test(text)) return "plan";
  return null;
}

function inferStage(source: AuditSource): "primary" | "middle" | "unknown" {
  if (/小学|幼升小|一年级/.test(source.title) || source.category === "primary-scope") return "primary";
  if (/初中|小升初|六年级/.test(source.title) || source.category === "middle-scope") return "middle";
  return "unknown";
}

function findBestSchool(rawName: string, districtSchools: SchoolRow[]) {
  const normalized = normalizeName(rawName);
  if (!normalized) return null;
  let best: SchoolRow | null = null;
  let bestScore = 0;
  for (const school of districtSchools) {
    for (const alias of schoolAliases(school)) {
      const score =
        normalized === alias.normalized
          ? 100
          : normalized.includes(alias.normalized) || alias.normalized.includes(normalized)
            ? Math.min(normalized.length, alias.normalized.length)
            : 0;
      if (score > bestScore) {
        best = school;
        bestScore = score;
      }
    }
  }
  return bestScore >= 4 ? best : null;
}

function extractTableCandidates(source: AuditSource, html: string, schools: SchoolRow[]) {
  const candidates: Candidate[] = [];
  const tables = extractTables(html);
  for (const [tableIndex, rows] of tables.entries()) {
    if (rows.length < 2) continue;
    const headerRows = rows.slice(0, Math.min(3, rows.length));
    let headerIndex = -1;
    let columns: Record<string, number> = {};

    for (const [index, row] of headerRows.entries()) {
      const mapped: Record<string, number> = {};
      for (const [cellIndex, cell] of row.entries()) {
        const kind = headerKind(cell);
        if (kind && mapped[kind] === undefined) mapped[kind] = cellIndex;
      }
      if (mapped.school !== undefined && (mapped.area !== undefined || mapped.committee !== undefined)) {
        headerIndex = index;
        columns = mapped;
        break;
      }
    }
    if (headerIndex < 0) continue;

    const dataRows = rows.slice(headerIndex + 1);
    for (const [rowOffset, row] of dataRows.entries()) {
      const schoolNameRaw = row[columns.school]?.trim();
      const areaText = [
        columns.area === undefined ? "" : row[columns.area],
        columns.committee === undefined ? "" : row[columns.committee],
      ]
        .filter(Boolean)
        .join("；")
        .trim();
      if (!schoolNameRaw || !areaText || /学校名称|校名|班级总数|合计|总计/.test(schoolNameRaw)) continue;

      const matchedSchool = findBestSchool(schoolNameRaw, schools);
      const communityItems = extractCommunityItems(areaText);
      const items = communityItems.length > 0 ? communityItems : [compactQuote(areaText, 120)];
      for (const communityName of items) {
        const boundaryOnly = communityItems.length === 0;
        candidates.push({
          year: source.year,
          district: source.district,
          schoolId: matchedSchool?.id ?? null,
          schoolNameRaw,
          communityNameRaw: communityName,
          committeeNameRaw: /居委|村委|街道|镇/.test(communityName) ? communityName : (columns.committee === undefined ? null : row[columns.committee] ?? null),
          sourceUrl: source.url,
          sourceTitle: source.title,
          sourceDate: sourceDate(source),
          sourceQuote: compactQuote(areaText),
          confidence: boundaryOnly ? "low" : matchedSchool ? "high" : "medium",
          status: "pending",
          raw: {
            extraction: "html-table-v1",
            sourceCategory: source.category,
            stage: inferStage(source),
            tableIndex,
            rowIndex: headerIndex + 1 + rowOffset,
            schoolAddress: columns.address === undefined ? null : row[columns.address] ?? null,
            notes: columns.notes === undefined ? null : row[columns.notes] ?? null,
            plannedClasses: columns.plan === undefined ? null : row[columns.plan] ?? null,
            areaTextRaw: areaText,
            boundaryOnly,
          },
        });
      }
    }
  }
  return dedupeCandidates(candidates);
}

function cleanupItem(value: string) {
  return decodeHtml(value)
    .replace(/^[：:、,，\s]+/, "")
    .replace(/[。；;、,，\s]+$/, "")
    .replace(/[-—–]+$/g, "")
    .replace(/^(招生范围|对口范围|地段范围|学区范围|范围|对口|地段)[:：]?/, "")
    .replace(/^(?:以及|包括|含)(?=[\u4e00-\u9fa5A-Za-z0-9·])/, "")
    .replace(/[（(].*$/, "")
    .replace(/^.*?以[东南西北]的(?=[\u4e00-\u9fa5A-Za-z0-9·（）()]{1,22}(?:小区|公寓|苑|园|花园|新村|社区|家园|里|坊|城|府|湾|邸|庭|都|舍|广场|中心|居委|村委|村宅|村)(?:区域|地区)?$)/, "")
    .replace(/^.*?[）)]/, "")
    .replace(/(?:区域|地区)$/, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function looksLikeCommunity(value: string) {
  if (value.length < 2 || value.length > 42) return false;
  if (/^(小学|初中|学校|校区|招生|范围|对口|地段|方式|登记|报名|学生|本区|外区)/.test(value)) return false;
  if (/^(居委|村委|村宅)/.test(value)) return false;
  if (/[&<>]|(?:东|南|西|北)至|北起|南起|西起|东起|一线|镇界|省界|市界|交界|边界/.test(value)) return false;
  if (/^(?:[\u4e00-\u9fa5A-Za-z0-9·]+)?(?:路|街|道|河|高速|公路|大道|线|桥|港|浜|塘|路牌)$/.test(value)) return false;
  if (/(?:路|街|道|河|高速|公路|大道|线|桥|港|浜|路牌).{0,12}以[东南西北]|以[东南西北]$/.test(value)) return false;
  if (/^(?:东|南|西|北|中)?(?:至|到)|(?:以东|以南|以西|以北)$/.test(value)) return false;
  return /小区|公寓|苑|园|花园|新村|社区|村委|村|居委|家园|里|坊|城|府|湾|邸|庭|都|舍|广场|中心|弄/.test(value);
}

function communitySuffixCount(value: string) {
  return value.match(/居委|村委|村宅/g)?.length ?? 0;
}

function normalizeCommunityListText(value: string) {
  return value
    .replace(/\s+(?=居委|村委|村宅|居民委员会)/g, "")
    .replace(/(居委|村委|村宅|居民委员会)([（(][^）)]*[）)])?\s+(?=[\u4e00-\u9fa5A-Za-z0-9·])/g, (_, suffix, note = "") => `${suffix}${note}、`);
}

function extractCommunityItems(text: string) {
  const candidates = new Set<string>();
  const afterColon = text.match(/(?:招生范围|对口范围|地段范围|学区范围|范围|对口|地段)[:：]?\s*([^。]+)/);
  const seed = normalizeCommunityListText(
    decodeHtml(afterColon?.[1] ?? text).replace(/从\s*20\d{2}年开始[\s\S]*$/, ""),
  );
  for (const rawItem of seed.split(/[、,，；;。\n]+/)) {
    const item = cleanupItem(rawItem);
    if (communitySuffixCount(item) <= 1 && looksLikeCommunity(item)) candidates.add(item);
  }
  for (const match of seed.matchAll(/(?:^|[、,，；;。\n\s])([\u4e00-\u9fa5A-Za-z0-9·（）()\s]{2,28}?(?:居委|村委|村宅|村))/g)) {
    const item = cleanupItem(match[1]);
    if (looksLikeCommunity(item)) candidates.add(item);
  }
  for (const match of seed.matchAll(/(?:^|[、,，；;。\n\s])([\u4e00-\u9fa5A-Za-z0-9·（）()\s]{2,28}?(?:小区|公寓|苑|园|花园|新村(?!\s*居委)|社区|家园|里|坊|城|府|湾|邸|庭|都|舍|广场|中心))/g)) {
    const item = cleanupItem(match[1]);
    if (looksLikeCommunity(item)) candidates.add(item);
  }
  const items = [...candidates];
  return items
    .filter((item) => !items.some((other) => other !== item && other.startsWith(item) && /(?:居委|村委|村宅)$/.test(other)))
    .slice(0, 80);
}

function schoolAliases(school: SchoolRow) {
  return [school.name, ...(school.aliases ?? [])]
    .map((name) => ({ raw: name, normalized: normalizeName(name) }))
    .filter((item) => item.normalized.length >= 3)
    .sort((a, b) => b.normalized.length - a.normalized.length);
}

function matchSchool(sentence: string, schools: SchoolRow[]) {
  const normalized = normalizeName(sentence);
  for (const school of schools) {
    for (const alias of schoolAliases(school)) {
      if (normalized.includes(alias.normalized)) return school;
    }
  }
  return null;
}

function extractCandidatesFromText(source: AuditSource, text: string, schools: SchoolRow[]) {
  const sentences = splitSentences(text);
  const candidates: Candidate[] = [];
  let currentSchool: SchoolRow | null = null;

  for (const sentence of sentences) {
    const matchedSchool = matchSchool(sentence, schools);
    if (matchedSchool) currentSchool = matchedSchool;
    if (!currentSchool || !candidateSignals(sentence)) continue;

    const communityItems = extractCommunityItems(sentence);
    if (communityItems.length === 0) continue;

    for (const communityName of communityItems) {
      const confidence = matchedSchool && /招生范围|对口|地段|学区|范围/.test(sentence) ? "high" : "medium";
      candidates.push({
        year: source.year,
        district: source.district,
        schoolId: currentSchool.id,
        schoolNameRaw: currentSchool.name,
        communityNameRaw: communityName,
        committeeNameRaw: /居委|村委|街道|镇/.test(communityName) ? communityName : null,
        sourceUrl: source.url,
        sourceTitle: source.title,
        sourceDate: sourceDate(source),
        sourceQuote: compactQuote(sentence),
        confidence,
        status: "pending",
        raw: {
          extraction: "sentence-scope-v1",
          matchedSchoolName: matchedSchool?.name ?? currentSchool.name,
          sourceCategory: source.category,
        },
      });
    }
  }

  return dedupeCandidates(candidates);
}

function dedupeCandidates(candidates: Candidate[]) {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = [
      candidate.year,
      candidate.district,
      candidate.schoolNameRaw,
      candidate.communityNameRaw,
      candidate.sourceUrl ?? "",
    ].join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchSource(source: AuditSource): Promise<FetchResult> {
  if (!source.url) return { html: "", text: "", contentType: "" };
  if (isXlsxUrl(source.url)) return fetchXlsxSource(source);
  const cachePath = cachePathForUrl(source.url);
  try {
    const cached = readFileSync(cachePath, "utf8");
    return { html: cached, text: normalizeText(cached), contentType: "text/html; cache=hit" };
  } catch {
    // Cache miss; fetch below.
  }
  const response = await fetch(source.url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
      referer: "https://shrxbm.edu.sh.gov.cn/zszc/zcsm.html",
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cachePath, body, "utf8");
  return {
    html: body,
    text: /html|xml|text|json|javascript/.test(contentType) || body.includes("<")
      ? normalizeText(body)
      : normalizeText(body),
    contentType,
  };
}

async function fetchBinary(url: string) {
  const cachePath = cachePathForUrl(url);
  try {
    return { path: cachePath, body: readFileSync(cachePath) };
  } catch {
    // Cache miss; fetch below.
  }
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cachePath, body);
  return { path: cachePath, body };
}

function unzipEntry(zipPath: string, entry: string) {
  try {
    return execFileSync("unzip", ["-p", zipPath, entry], {
      encoding: "utf8",
      maxBuffer: 80 * 1024 * 1024,
    });
  } catch {
    return "";
  }
}

function unzipList(zipPath: string) {
  try {
    return execFileSync("unzip", ["-Z1", zipPath], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    })
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function columnIndex(cellRef: string) {
  const letters = cellRef.match(/^[A-Z]+/i)?.[0].toUpperCase() ?? "A";
  let index = 0;
  for (const char of letters) index = index * 26 + char.charCodeAt(0) - 64;
  return index - 1;
}

function parseSharedStrings(zipPath: string) {
  const xml = unzipEntry(zipPath, "xl/sharedStrings.xml");
  const strings: string[] = [];
  for (const match of xml.matchAll(/<si\b[\s\S]*?<\/si>/g)) {
    const text = [...match[0].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
      .map((part) => decodeXmlText(part[1]))
      .join("");
    strings.push(text);
  }
  return strings;
}

function worksheetToRows(xml: string, sharedStrings: string[]) {
  const rows: string[][] = [];
  for (const rowMatch of xml.matchAll(/<row\b[\s\S]*?<\/row>/g)) {
    const row: string[] = [];
    for (const cellMatch of rowMatch[0].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2];
      const ref = attrs.match(/\br=["']([^"']+)["']/)?.[1] ?? "";
      const type = attrs.match(/\bt=["']([^"']+)["']/)?.[1] ?? "";
      const col = ref ? columnIndex(ref) : row.length;
      const rawValue =
        body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ??
        body.match(/<t\b[^>]*>([\s\S]*?)<\/t>/)?.[1] ??
        "";
      row[col] = type === "s" ? (sharedStrings[Number(rawValue)] ?? "") : decodeXmlText(rawValue);
    }
    if (row.some((cell) => cell?.trim())) rows.push(row.map((cell) => cell?.trim() ?? ""));
  }
  return rows;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function fetchXlsxSource(source: AuditSource): Promise<FetchResult> {
  if (!source.url) return { html: "", text: "", contentType: "" };
  const { path: zipPath } = await fetchBinary(source.url);
  const sharedStrings = parseSharedStrings(zipPath);
  const sheets = unzipList(zipPath).filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry));
  const tableHtml = sheets
    .map((sheet) => worksheetToRows(unzipEntry(zipPath, sheet), sharedStrings))
    .filter((rows) => rows.length > 0)
    .map((rows) => {
      const body = rows
        .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
        .join("");
      return `<table>${body}</table>`;
    })
    .join("\n");
  return {
    html: tableHtml,
    text: htmlToText(tableHtml),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; cache=parsed",
  };
}

async function insertCandidates(client: pg.Client, candidates: Candidate[]) {
  for (const candidate of candidates) {
    await client.query(
      `INSERT INTO school_community_candidates (
         school_id, school_name_raw, district, year, community_name_raw, committee_name_raw,
         source_url, source_title, source_date, source_quote, confidence, status, raw, updated_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,now())
       ON CONFLICT (year, district, school_name_raw, community_name_raw, source_url)
       DO UPDATE SET
         school_id = excluded.school_id,
         committee_name_raw = excluded.committee_name_raw,
         source_title = excluded.source_title,
         source_date = excluded.source_date,
         source_quote = excluded.source_quote,
         confidence = excluded.confidence,
         raw = excluded.raw,
         updated_at = now()`,
      [
        candidate.schoolId,
        candidate.schoolNameRaw,
        candidate.district,
        candidate.year,
        candidate.communityNameRaw,
        candidate.committeeNameRaw,
        candidate.sourceUrl,
        candidate.sourceTitle,
        candidate.sourceDate,
        candidate.sourceQuote,
        candidate.confidence,
        candidate.status,
        JSON.stringify(candidate.raw),
      ],
    );
  }
}

async function main() {
  const audit = JSON.parse(readFileSync(auditPath, "utf8")) as AuditFile;
  const selectedYears = years?.length ? years : [2026];
  const sources = localFile
    ? [
        {
          year: localYear,
          district: localDistrict ?? "黄浦",
          title: localTitle ?? path.basename(localFile),
          url: `file://${path.resolve(localFile)}`,
          category: "primary-scope",
          sourceName: "local-file",
        },
      ]
    : audit.rows
        .flatMap((row) => row.sources)
        .filter((source) => selectedYears.includes(source.year))
        .filter((source) => districts.size === 0 || districts.has(source.district))
        .filter((source) => source.url && isScopeSource(source) && sourceTextSignals(source.title));

  const selectedSources = limit > 0 ? sources.slice(0, limit) : sources;
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  const schools = (
    await client.query<SchoolRow>(
      `SELECT id, name, aliases, district, type
       FROM schools
       WHERE district = ANY($1)
       ORDER BY district, length(name) DESC`,
      [[...new Set(selectedSources.map((source) => source.district))]],
    )
  ).rows;

  const schoolsByDistrict = new Map<string, SchoolRow[]>();
  for (const school of schools) {
    schoolsByDistrict.set(school.district, [...(schoolsByDistrict.get(school.district) ?? []), school]);
  }

  const allCandidates: Candidate[] = [];
  const sourceReports: Array<Record<string, unknown>> = [];

  for (const [index, source] of selectedSources.entries()) {
    try {
      console.log(`[${index + 1}/${selectedSources.length}] ${source.year} ${source.district} ${source.title}`);
      const fetched = localFile
        ? {
            html: readFileSync(localFile, "utf8"),
            text: normalizeText(readFileSync(localFile, "utf8")),
            contentType: "text/html; local-file",
          }
        : await fetchSource(source);
      const followableLinks =
        !localFile && fetched.text.length < 1200 && extractTables(fetched.html).length === 0
          ? extractFollowableScopeLinks(source, fetched)
          : [];
      const followedLink = followableLinks[0] ?? null;
      const effectiveSource = followedLink
        ? {
            ...source,
            url: followedLink.url,
            title: `${source.title}（外链）`,
          }
        : source;
      const effectiveFetched = followedLink ? await fetchSource(effectiveSource) : fetched;
      const attachmentLinks =
        !localFile && effectiveFetched.text.length < 2000
          ? extractXlsxAttachmentLinks(effectiveSource, effectiveFetched)
          : [];
      const attachmentLink = attachmentLinks[0] ?? null;
      const parseSource = attachmentLink
        ? {
            ...effectiveSource,
            url: attachmentLink.url,
            title: `${source.title}（附件）`,
          }
        : effectiveSource;
      const parseFetched = attachmentLink ? await fetchSource(parseSource) : effectiveFetched;
      const districtSchools = schoolsByDistrict.get(source.district) ?? [];
      const tableCandidates = extractTableCandidates(parseSource, parseFetched.html, districtSchools);
      const candidates =
        tableCandidates.length > 0
          ? tableCandidates
          : extractCandidatesFromText(parseSource, parseFetched.text, districtSchools);
      allCandidates.push(...candidates);
      sourceReports.push({
        year: source.year,
        district: source.district,
        title: source.title,
        url: source.url,
        followedUrl: followedLink?.url ?? null,
        followedLabel: followedLink?.label ?? null,
        attachmentUrl: attachmentLink?.url ?? null,
        attachmentLabel: attachmentLink?.label ?? null,
        contentType: parseFetched.contentType,
        textLength: parseFetched.text.length,
        extraction: tableCandidates.length > 0 ? "html-table-v1" : "sentence-scope-v1",
        candidates: candidates.length,
      });
      console.log(
        `  text=${parseFetched.text.length} follow=${followedLink ? "yes" : "no"} attachment=${attachmentLink ? "yes" : "no"} extraction=${tableCandidates.length > 0 ? "table" : "sentence"} candidates=${candidates.length}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sourceReports.push({
        year: source.year,
        district: source.district,
        title: source.title,
        url: source.url,
        error: message,
      });
      console.log(`  ERROR ${message}`);
    }
  }

  const dedupedCandidates = dedupeCandidates(allCandidates);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportDir = path.join(process.cwd(), ".tmp", "official-school-community-candidates", stamp);
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(path.join(reportDir, "candidates.json"), JSON.stringify(dedupedCandidates, null, 2), "utf8");
  writeFileSync(path.join(reportDir, "sources.json"), JSON.stringify(sourceReports, null, 2), "utf8");

  if (apply) {
    await client.query("BEGIN");
    try {
      await insertCandidates(client, dedupedCandidates);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  const byYearDistrict = new Map<string, number>();
  for (const candidate of dedupedCandidates) {
    const key = `${candidate.year}:${candidate.district}`;
    byYearDistrict.set(key, (byYearDistrict.get(key) ?? 0) + 1);
  }

  console.log("");
  console.log(`# official school-community candidate extraction`);
  console.log(`mode: ${apply ? "APPLY" : "dry-run"}`);
  console.log(`report: ${reportDir}`);
  console.log(`sources: ${selectedSources.length}`);
  console.log(`candidates: ${dedupedCandidates.length}`);
  for (const [key, count] of [...byYearDistrict.entries()].sort()) {
    console.log(`${key} candidates=${count}`);
  }

  await client.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
