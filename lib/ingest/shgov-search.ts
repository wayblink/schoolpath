import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const SHGOV_BASE_URL = "https://search.sh.gov.cn";
export const SHGOV_DEFAULT_KEYWORDS = ["学校", "义务教育", "招生入学", "学区", "对口入学"];
export const SHGOV_FORM_FIELDS = ["text", "pageNo", "newsPageNo", "pageSize", "resourceType", "channel", "category1", "category2", "category3", "category4", "category6", "category7", "sortMode", "searchMode", "timeRange", "accurateMode", "district", "street", "stealthy", "showItemAgency"] as const;
export const SHGOV_PARSER_VERSION = 1;
export type ShgovResource = { kind: "bootstrap" | "result"; keyword: string; pageNo: number; url: string; finalUrl: string; status: number | null; fetchedAt: string; file: string | null; bytes: number; sha256: string | null; totalSize: number | null; total: number | null; fetchKey: string | null; error?: string };
export type ShgovManifest = { version: 1; source: "search.sh.gov.cn"; sourceKind: "official_search_index"; runId: string; startedAt: string; finishedAt: string; complete: boolean; keywords: string[]; limits: { pageSize: number; maxPages: number; timeoutMs: number; delayMs: number }; resources: ShgovResource[] };
export type ShgovResult = { token: string | null; detailUrl: string | null; title: string; summary: string | null; channel: string | null; category: string | null; date: string | null; sourceSite: string | null; targetUrl: string | null; rawHtml: string; index: number };

const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const decode = (value: string) => value.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const attr = (html: string, name: string) => html.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1] ?? null;
const textOf = (html: string) => decode(html);
const hidden = (html: string, name: string) => attr(html.match(new RegExp(`<input[^>]+\\bname=["']${name}["'][^>]*>`, "i"))?.[0] ?? "", "value");

export function parseShgovSearchHtml(html: string, baseUrl = SHGOV_BASE_URL): { meta: Pick<ShgovResource, "totalSize" | "total" | "fetchKey">; results: ShgovResult[] } {
  const meta = { totalSize: Number(hidden(html, "totalSize")) || null, total: Number(hidden(html, "total")) || null, fetchKey: hidden(html, "fetchKey") };
  const results: ShgovResult[] = [];
  const blocks: string[] = [];
  for (const start of [...html.matchAll(/<div\b[^>]*class=["'][^"']*result-elm[^"']*["'][^>]*>/gi)].map((match) => match.index ?? 0)) {
    let depth = 0; let end = start;
    for (const token of html.slice(start).matchAll(/<\/?div\b[^>]*>/gi)) {
      depth += token[0].startsWith("</") ? -1 : 1;
      end = start + (token.index ?? 0) + token[0].length;
      if (depth === 0) break;
    }
    if (depth === 0) blocks.push(html.slice(start, end));
  }
  for (const [index, rawHtml] of blocks.entries()) {
    const link = rawHtml.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/i);
    let detailUrl: string | null = null;
    try { if (link) detailUrl = new URL(link[1], baseUrl).href; } catch { detailUrl = null; }
    let token: string | null = null;
    try { if (detailUrl) token = new URL(detailUrl).searchParams.get("token"); } catch { token = null; }
    const titleMatch = rawHtml.match(/<a\b[^>]*class=["'][^"']*(?:restitle|focusResult|wl-link)[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
    const title = titleMatch ? textOf(titleMatch[1]) : textOf(attr(rawHtml, "title") ?? "");
    const summaryMatch = rawHtml.match(/<div\b[^>]*class=["'][^"']*search-result-summary[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const target = rawHtml.match(/<a\b[^>]*class=["'][^"']*url[^"']*["'][^>]*href=["']([^"']+)["']/i);
    const date = rawHtml.match(/(?:mobile-result-date|desktop-result-date)[^>]*>\s*(?:<[^>]+>)?([^<\s]+\s*[-/]\s*[^<\s]+\s*[-/]\s*[^<\s]+)/i)?.[1]?.replace(/\s/g, "") ?? null;
    const tag = rawHtml.match(/<span\b[^>]*class=["'][^"']*tag[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1];
    // Search results can point at relative government-site URLs as well as absolute URLs.
    // Preserve the raw href while normalizing only the host field defensively.
    let site: string | null = null;
    if (target) {
      try { site = new URL(target[1], baseUrl).hostname; } catch { site = null; }
    }
    results.push({ token, detailUrl, title, summary: summaryMatch ? textOf(summaryMatch[1]) : null, channel: tag ? textOf(tag) : null, category: tag ? textOf(tag) : null, date, sourceSite: site, targetUrl: target?.[1] ?? null, rawHtml, index });
  }
  return { meta, results };
}

function formData(keyword: string, pageNo: number, pageSize: number, fetchKey?: string) {
  const form = new URLSearchParams({ text: keyword, pageNo: String(pageNo), newsPageNo: String(pageNo), pageSize: String(pageSize), resourceType: "", channel: "", category1: "", category2: "", category3: "", category4: "", category6: "", category7: "", sortMode: "", searchMode: "", timeRange: "", accurateMode: "", district: "", street: "", stealthy: "0", showItemAgency: "true" });
  if (fetchKey) form.set("fetchKey", fetchKey);
  return form;
}

async function fetchText(url: string, body: URLSearchParams, timeoutMs: number, cookie = "", fetchImpl: typeof fetch = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: "POST", body, signal: controller.signal, headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", accept: "text/html, */*", ...(cookie ? { cookie } : {}) } });
    const text = await response.text();
    const cookies = response.headers.getSetCookie?.().map((value) => value.split(";", 1)[0]) ?? [];
    return { response, text, cookies };
  } finally { clearTimeout(timer); }
}

export async function collectShgovSearch(options: { keywords?: string[]; outputDir?: string; pageSize?: number; maxPages?: number; timeoutMs?: number; delayMs?: number; fetchImpl?: typeof fetch } = {}) {
  const keywords = options.keywords?.length ? options.keywords : SHGOV_DEFAULT_KEYWORDS;
  const pageSize = Math.min(Math.max(options.pageSize ?? 20, 1), 100);
  const maxPages = Math.max(options.maxPages ?? 50, 1);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const delayMs = options.delayMs ?? 500;
  const startedAt = new Date().toISOString();
  const root = path.resolve(options.outputDir ?? path.join("data/ingest/shgov-search", `${startedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`));
  await mkdir(path.join(root, "raw"), { recursive: true });
  const resources: ShgovResource[] = [];
  let complete = true;
  for (const keyword of keywords) {
    let cookie = ""; let fetchKey: string | undefined; let totalSize: number | null = null; let total: number | null = null;
    let stoppedAtPageBoundary = true;
    for (let pageNo = 0; pageNo <= maxPages; pageNo++) {
      if (delayMs && resources.length) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const kind = pageNo === 0 ? "bootstrap" : "result";
      const requestPage = pageNo === 0 ? 1 : pageNo;
      const url = `${SHGOV_BASE_URL}/${kind === "bootstrap" ? "search" : "searchResult"}`;
      const fetchedAt = new Date().toISOString();
      try {
        const response = await fetchText(url, formData(keyword, requestPage, pageSize, fetchKey), timeoutMs, cookie, options.fetchImpl);
        if (response.cookies.length) cookie = [...cookie.split("; ").filter(Boolean), ...response.cookies].filter((v, i, a) => a.findIndex((x) => x.split("=", 1)[0] === v.split("=", 1)[0]) === i).join("; ");
        const bytes = Buffer.from(response.text);
        const parsed = parseShgovSearchHtml(response.text);
        if (kind === "bootstrap" || parsed.meta.totalSize !== null) { totalSize = parsed.meta.totalSize ?? totalSize; total = parsed.meta.total ?? total; fetchKey = parsed.meta.fetchKey ?? fetchKey; }
        const file = path.join("raw", `${encodeURIComponent(keyword)}-page-${pageNo}-${kind}.html`);
        await writeFile(path.join(root, file), bytes);
        resources.push({ kind, keyword, pageNo: requestPage, url, finalUrl: response.response.url, status: response.response.status, fetchedAt, file, bytes: bytes.length, sha256: sha(bytes), totalSize, total, fetchKey: fetchKey ?? null });
        if (!response.response.ok) { complete = false; stoppedAtPageBoundary = false; break; }
        if (kind === "bootstrap") continue;
        const pageCount = totalSize ? Math.ceil(totalSize / pageSize) : null;
        if ((pageCount !== null && pageNo >= pageCount) || parsed.results.length === 0) { stoppedAtPageBoundary = false; break; }
      } catch (error) {
        complete = false;
        stoppedAtPageBoundary = false;
        resources.push({ kind, keyword, pageNo: requestPage, url, finalUrl: url, status: null, fetchedAt, file: null, bytes: 0, sha256: null, totalSize, total, fetchKey: fetchKey ?? null, error: String(error) });
        break;
      }
    }
    if (stoppedAtPageBoundary && (totalSize === null || Math.ceil(totalSize / pageSize) > maxPages)) complete = false;
  }
  const manifest: ShgovManifest = { version: 1, source: "search.sh.gov.cn", sourceKind: "official_search_index", runId: randomUUID(), startedAt, finishedAt: new Date().toISOString(), complete, keywords, limits: { pageSize, maxPages, timeoutMs, delayMs }, resources };
  await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { root, manifest };
}

export function occurrenceKey(keyword: string, pageNo: number, index: number) { return `shgov-search-v1:${encodeURIComponent(keyword)}:p${pageNo}:r${index}`; }
