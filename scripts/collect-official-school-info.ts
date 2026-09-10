/**
 * Collect official school address/nature records from Shanghai government pages.
 *
 * This script only writes review artifacts under .tmp. It does not mutate the DB.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

type DistrictSource = {
  district: string;
  slug: string;
};

type Link = {
  district: string;
  title: string;
  url: string;
};

type SourceRecord = {
  district: string;
  stage: "primary" | "middle" | "unknown";
  name: string;
  campus: string;
  nature: string;
  address: string;
  sourceTitle: string;
  sourceUrl: string;
};

const baseUrl = "https://www.shanghai.gov.cn";
const outputDir = path.join(process.cwd(), ".tmp", "official-school-info");
const districts: DistrictSource[] = [
  { district: "黄浦", slug: "hpqywjy" },
  { district: "徐汇", slug: "xhqywjy" },
  { district: "长宁", slug: "cnqywjy" },
  { district: "静安", slug: "jaqywjy" },
  { district: "普陀", slug: "ptqywjy" },
  { district: "虹口", slug: "hkqywjy" },
  { district: "杨浦", slug: "ypqywjy" },
  { district: "浦东", slug: "pdxqywjy" },
  { district: "闵行", slug: "mhqywjy" },
  { district: "宝山", slug: "bsqywjy" },
  { district: "嘉定", slug: "jdqywjy" },
  { district: "金山", slug: "jsqywjy" },
  { district: "松江", slug: "sjqywjy" },
  { district: "青浦", slug: "qpqywjy" },
  { district: "奉贤", slug: "fxqywjy" },
  { district: "崇明", slug: "cmqywjy" },
];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeHtml(value: string) {
  return value
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number.parseInt(num, 10)));
}

function cleanText(html: string) {
  return decodeHtml(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>|<\/div>|<\/li>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/[ \t\r\f\v　]+/g, " ")
      .replace(/\n\s+/g, "\n")
      .replace(/\s+\n/g, "\n")
      .replace(/\n{2,}/g, "\n"),
  ).trim();
}

function cleanCell(value: string) {
  return value.replace(/\s+/g, " ").replace(/^[-—]+$/, "").trim();
}

function attrNumber(attrs: string, name: string) {
  const match = attrs.match(new RegExp(`${name}\\s*=\\s*["']?(\\d+)`, "i"));
  return match ? Number(match[1]) : 1;
}

function extractLinks(html: string, source: DistrictSource) {
  const links: Link[] = [];
  const linkRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(html))) {
    const attrs = match[1] ?? "";
    const hrefMatch = attrs.match(/href\s*=\s*['"]([^'"]+)['"]/i);
    if (!hrefMatch) continue;
    const titleMatch = attrs.match(/title\s*=\s*['"]([^'"]+)['"]/i);
    const title = cleanText(titleMatch?.[1] ?? match[2] ?? "");
    if (!/2025年|2025 /.test(title)) continue;
    if (
      !/学校基本情况|公办小学基本情况|公办初中基本情况|民办中小学基本情况|基本情况公示|办学基本情况|招生入学信息公示|办学规模.*公示汇总表|教育教学.*师资配置|校舍.*设施.*师资配置|校区范围与招生计划|公办学校规模/.test(
        title,
      )
    ) continue;
    if (/特殊教育|特教班|辅读|民办中小学招生相关信息|分类计划/.test(title)) continue;

    const href = hrefMatch[1]!;
    const url = href.startsWith("http") ? href : new URL(href, baseUrl).toString();
    links.push({ district: source.district, title, url });
  }
  return links;
}

type GridCell = {
  text: string;
  rowspan: number;
  colspan: number;
};

function parseTable(tableHtml: string) {
  const rows: string[][] = [];
  const spans = new Map<number, { text: string; remaining: number }>();
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr: RegExpExecArray | null;
  while ((tr = trRe.exec(tableHtml))) {
    const row: string[] = [];
    let col = 0;
    const tdRe = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    let td: RegExpExecArray | null;

    function flushSpans() {
      while (spans.has(col)) {
        const span = spans.get(col)!;
        row[col] = span.text;
        span.remaining -= 1;
        if (span.remaining <= 0) spans.delete(col);
        col += 1;
      }
    }

    flushSpans();
    while ((td = tdRe.exec(tr[1] ?? ""))) {
      flushSpans();
      const cell: GridCell = {
        text: cleanCell(cleanText(td[3] ?? "")),
        rowspan: attrNumber(td[2] ?? "", "rowspan"),
        colspan: attrNumber(td[2] ?? "", "colspan"),
      };
      for (let i = 0; i < cell.colspan; i += 1) {
        row[col + i] = cell.text;
        if (cell.rowspan > 1) {
          spans.set(col + i, { text: cell.text, remaining: cell.rowspan - 1 });
        }
      }
      col += cell.colspan;
    }
    flushSpans();
    if (row.some(Boolean)) rows.push(row);
  }
  return rows;
}

function articleTitle(html: string) {
  const meta = html.match(/<meta\s+name=["']ArticleTitle["']\s+content=["']([^"']+)["']/i);
  const title = meta?.[1] ?? html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  return cleanText(title).replace(/_上海市人民政府$/, "");
}

function inferStage(title: string, row: string[]) {
  const text = `${title} ${row.join(" ")}`;
  if (/小学|一年级/.test(text)) return "primary";
  if (/初中|六年级|中学/.test(text)) return "middle";
  return "unknown";
}

function looksLikeAddress(value: string) {
  return /[路街道弄号村镇巷]/.test(value) && value.length >= 3 && !/学校名称|学校地址|办学规模/.test(value);
}

function parseArticle(html: string, link: Link) {
  const title = articleTitle(html) || link.title;
  const records: SourceRecord[] = [];
  const tableRe = /<table\b[\s\S]*?<\/table>/gi;
  let table: RegExpExecArray | null;
  while ((table = tableRe.exec(html))) {
    const rows = parseTable(table[0]);
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!.map(cleanCell);
      const next = rows[i + 1]?.map(cleanCell) ?? [];
      const next2 = rows[i + 2]?.map(cleanCell) ?? [];
      const headerText = [...row, ...next, ...next2].join(" ");
      if (!/学校/.test(headerText) || !/学校地址/.test(headerText)) continue;

      const nameIndex = findColumn([row, next, next2], /学校名称|^名称$/);
      const campusIndex = findColumn([row, next, next2], /^校区$/);
      const addressIndex = findColumn([row, next, next2], /学校地址/);
      const natureIndex = findColumn([row, next, next2], /学校性质|办学性质|性质/);
      if (nameIndex < 0 || addressIndex < 0) continue;

      for (let j = i + 1; j < rows.length; j += 1) {
        const dataRow = rows[j]!.map(cleanCell);
        const baseName = dataRow[nameIndex] ?? "";
        const campus = campusIndex >= 0 ? normalizeCampus(dataRow[campusIndex] ?? "") : "";
        const name = campus && !baseName.includes(campus) ? `${baseName}（${campus}校区）` : baseName;
        const address = dataRow[addressIndex] ?? "";
        if (!name || !looksLikeAddress(address)) continue;
        if (/学校名称|合计|备注|说明/.test(name)) continue;

        records.push({
          district: link.district,
          stage: inferStage(title, dataRow),
          name,
          campus,
          nature: natureIndex >= 0 ? (dataRow[natureIndex] ?? "") : "",
          address,
          sourceTitle: title,
          sourceUrl: link.url,
        });
      }
      break;
    }
  }
  return records;
}

function findColumn(headerRows: string[][], pattern: RegExp) {
  const max = Math.max(...headerRows.map((row) => row.length));
  for (let col = 0; col < max; col += 1) {
    const stack = headerRows.map((row) => row[col] ?? "");
    if (stack.some((cell) => pattern.test(cell))) return col;
  }
  return -1;
}

function normalizeCampus(value: string) {
  return value
    .replace(/\s+/g, "")
    .replace(/^[-—/]+$/, "")
    .replace(/^(无|本部|总部|总校区?)$/, "")
    .replace(/校区$/, "")
    .trim();
}

async function fetchText(url: string) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 school-info-collector/1.0",
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return await res.text();
}

async function main() {
  mkdirSync(outputDir, { recursive: true });
  const links: Link[] = [];
  const records: SourceRecord[] = [];
  const errors: Array<{ url: string; title: string; error: string }> = [];

  for (const source of districts) {
    let sourceLinkCount = 0;
    for (let page = 0; page <= 9; page += 1) {
      const indexUrl = `${baseUrl}/${source.slug}/${page === 0 ? "index.html" : `index_${page}.html`}`;
      try {
        const html = await fetchText(indexUrl);
        const found = extractLinks(html, source);
        sourceLinkCount += found.length;
        links.push(...found);
      } catch (error) {
        const message = String(error);
        if (!message.includes("404")) {
          errors.push({ url: indexUrl, title: `${source.district} index page ${page}`, error: message });
        }
      }
      await sleep(80);
    }
    console.log(`${source.district}: source links=${sourceLinkCount}`);
  }

  const dedupedLinks = [...new Map(links.map((link) => [`${link.district}:${link.url}`, link])).values()];
  for (const link of dedupedLinks) {
    try {
      const html = await fetchText(link.url);
      const parsed = parseArticle(html, link);
      records.push(...parsed);
      console.log(`${link.district}: ${link.title} -> records=${parsed.length}`);
    } catch (error) {
      errors.push({ url: link.url, title: link.title, error: String(error) });
    }
    await sleep(160);
  }

  const uniqueRecords = [
    ...new Map(
      records.map((record) => [
        `${record.district}:${record.stage}:${record.name}:${record.address}:${record.sourceUrl}`,
        record,
      ]),
    ).values(),
  ];
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const out = {
    generatedAt: new Date().toISOString(),
    source: "www.shanghai.gov.cn district义务教育招生栏目",
    linkCount: dedupedLinks.length,
    recordCount: uniqueRecords.length,
    links: dedupedLinks,
    records: uniqueRecords,
    errors,
  };
  const file = path.join(outputDir, `official-school-info-${stamp}.json`);
  const latest = path.join(outputDir, "latest.json");
  writeFileSync(file, JSON.stringify(out, null, 2), "utf8");
  writeFileSync(latest, JSON.stringify(out, null, 2), "utf8");
  console.log(`Output: ${file}`);
  console.log(`Latest: ${latest}`);
  console.log(`Done. links=${dedupedLinks.length}, records=${uniqueRecords.length}, errors=${errors.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
