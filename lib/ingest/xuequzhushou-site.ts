import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import ts from "typescript";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type SiteDocument = { name: string; value: JsonValue; rawText: string };
export type SiteResource = {
  url: string;
  finalUrl: string;
  status: number | null;
  contentType: string | null;
  sha256: string | null;
  file: string | null;
  bytes: number;
  discoveredFrom: string[];
  error?: string;
  parseIssues?: string[];
  partial?: boolean;
};
export type SiteManifest = {
  version: 1;
  runId: string;
  source: "xuequzhushou.cn";
  provenance: "third-party";
  seedUrl: string;
  startedAt: string;
  finishedAt: string;
  complete: boolean;
  discovery: "same-origin static links, script literals and recursive JSON filenames";
  limits: { maxResources: number; maxBytes: number; maxTotalBytes: number; timeoutMs: number; delayMs: number };
  resources: SiteResource[];
};

function isJson(url: string, contentType: string) {
  return /json/i.test(contentType) || /\.(?:json|geojson|topojson)$/i.test(new URL(url).pathname);
}

function scriptsIn(text: string, url: string, contentType: string): string[] {
  if (/html/i.test(contentType) || /\.html?$/i.test(new URL(url).pathname) || /<html\b/i.test(text)) {
    return [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map((match) => match[1]);
  }
  return /javascript|ecmascript/i.test(contentType) || /\.[cm]?js$/i.test(new URL(url).pathname) ? [text] : [];
}

function literalValue(node: ts.Expression): JsonValue {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) {
    const value = Number(node.text);
    if (Number.isFinite(value)) return value;
  }
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
    const value = Number(node.operand.text);
    if (Number.isFinite(value)) return -value;
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literalValue);
  if (ts.isObjectLiteralExpression(node)) {
    return Object.fromEntries(node.properties.map((property) => {
      if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name))) {
        throw new Error("Not a literal property");
      }
      return [property.name.text, literalValue(property.initializer)];
    }));
  }
  throw new Error("Not a static literal");
}

/** Parse syntax only; no eval, VM, transpilation or execution of source scripts. */
export function parseXuequzhushouSiteResource(text: string, url: string, contentType = "") {
  const documents: SiteDocument[] = [];
  const issues: string[] = [];
  const parse = (name: string, rawText: string, literal?: ts.Expression) => {
    try {
      let value: JsonValue;
      try { value = JSON.parse(rawText) as JsonValue; }
      catch (error) {
        if (!literal) throw error;
        // Only literal syntax is admitted; calls, references, spreads and getters are rejected.
        value = literalValue(literal);
      }
      documents.push({ name, rawText, value });
    } catch { issues.push(`${name}: not a static JSON-compatible literal; retained in raw resource`); }
  };
  if (isJson(url, contentType)) {
    parse("$", text);
  } else {
    for (const script of scriptsIn(text, url, contentType)) {
      const source = ts.createSourceFile("source.js", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      for (const statement of source.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          const value = declaration.initializer;
          if (!value || !ts.isIdentifier(declaration.name)) continue;
          if (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value)) {
            parse(declaration.name.text, value.getText(source), value);
          }
        }
      }
    }
    for (const match of text.matchAll(/<script\b[^>]*type\s*=\s*["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
      parse(`json-script-${documents.length}`, match[1]);
    }
  }
  return { documents, issues };
}

/** Every node has a stable RFC 6901 pointer; equal rows retain distinct indices. */
export function* inventoryJsonRecords(value: JsonValue, pointer = ""): Generator<{
  pointer: string; kind: "object" | "array" | "value"; value: JsonValue;
}> {
  yield { pointer, kind: Array.isArray(value) ? "array" : value !== null && typeof value === "object" ? "object" : "value", value };
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      yield* inventoryJsonRecords(child, `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`);
    }
  }
}

function decodeEntities(value: string) {
  return value.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
}

function canonicalUrl(value: string, base: string, origin: string): string | null {
  try {
    const url = new URL(decodeEntities(value.trim()), base);
    if (url.origin !== origin || !/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    url.hash = "";
    if (!url.searchParams.size) url.search = "";
    return url.href;
  } catch { return null; }
}

function redirectLocation(value: string): string {
  // Fetch Headers exposes raw header bytes as Latin-1; this site's Location is UTF-8.
  if (/[\u0080-\u00ff]/.test(value) && [...value].every((char) => char.charCodeAt(0) <= 255)) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "latin1")); }
    catch { return value; }
  }
  return value;
}

const FILE_REFERENCE = /\.(?:html?|[cm]?js|css|json|geojson|topojson|jsonl|ndjson|csv|tsv|txt|xml|kml|kmz|zip|gz|xlsx?|pdf|pbf|png|jpe?g|webp|svg|gif|woff2?)(?:[?#][^\s<>"']*)?$/i;

export function discoverSiteReferences(text: string, resourceUrl: string, contentType = ""): string[] {
  const origin = new URL(resourceUrl).origin;
  const refs = new Set<string>();
  let base = resourceUrl;
  const add = (value: string, explicit = false) => {
    if (!value.trim() || value.startsWith("#") || /[\r\n<>]/.test(value)) return;
    if (!explicit && !FILE_REFERENCE.test(value)) return;
    const url = canonicalUrl(value, base, origin);
    if (url) refs.add(url);
  };
  if (isJson(resourceUrl, contentType)) {
    try {
      const visit = (value: unknown) => {
        if (typeof value === "string") add(value);
        else if (value && typeof value === "object") {
          for (const [key, child] of Object.entries(value)) { add(key); visit(child); }
        }
      };
      visit(JSON.parse(text));
    } catch { /* Parsing failures are exposed by parseXuequzhushouSiteResource. */ }
    return [...refs];
  }
  const baseMatch = text.match(/<base\b[^>]*href\s*=\s*["']([^"']+)["']/i);
  if (baseMatch) base = canonicalUrl(baseMatch[1], resourceUrl, origin) ?? resourceUrl;
  const linkText = text.replace(/<base\b[^>]*>/gi, "");
  for (const tag of linkText.matchAll(/<[a-z][^<>]*>/gi)) {
    for (const match of tag[0].matchAll(/\b(?:href|src|data-src)\s*=\s*["']([^"'<>]+)["']/gi)) add(match[1], true);
  }
  for (const match of text.matchAll(/\burl\(\s*["']?([^\s)"']+)["']?\s*\)/gi)) add(match[1], true);
  for (const script of scriptsIn(text, resourceUrl, contentType)) {
    const source = ts.createSourceFile("source.js", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const staticString = (node: ts.Node): string | undefined => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = staticString(node.left), right = staticString(node.right);
        if (left !== undefined && right !== undefined) return left + right;
      }
    };
    const visit = (node: ts.Node) => {
      const value = staticString(node);
      if (value !== undefined) {
        const parent = node.parent;
        const explicit = ts.isCallExpression(parent) && parent.arguments[0] === node &&
          ["fetch", "import"].includes(parent.expression.getText(source));
        add(value, explicit);
        // A complete literal concatenation is one path, not two filenames.
        if (ts.isBinaryExpression(node)) return;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...refs];
}

export type SiteCollectOptions = {
  outputRoot: string;
  runId?: string;
  seedUrl?: string;
  maxResources?: number;
  maxBytes?: number;
  maxTotalBytes?: number;
  timeoutMs?: number;
  delayMs?: number;
  fetchImpl?: typeof fetch;
  onResource?: (resource: SiteResource) => void;
};

export async function collectXuequzhushouSite(options: SiteCollectOptions) {
  const runId = options.runId ?? `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) throw new Error("Invalid runId: use a single directory name");
  const seedUrl = new URL(options.seedUrl ?? "https://xuequzhushou.cn/").href;
  const origin = new URL(seedUrl).origin;
  if (origin !== "https://xuequzhushou.cn" && origin !== "http://xuequzhushou.cn") throw new Error("seedUrl must belong to xuequzhushou.cn");
  const limits = {
    maxResources: options.maxResources ?? 512,
    maxBytes: options.maxBytes ?? 32 * 1024 * 1024,
    maxTotalBytes: options.maxTotalBytes ?? 256 * 1024 * 1024,
    timeoutMs: options.timeoutMs ?? 20_000,
    delayMs: options.delayMs ?? 300,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < (name === "delayMs" ? 0 : 1)) throw new Error(`Invalid ${name}`);
  }
  const startedAt = new Date().toISOString();
  await mkdir(path.resolve(options.outputRoot), { recursive: true });
  const directory = path.resolve(options.outputRoot, runId);
  await mkdir(directory); // Existing runs are never overwritten or resumed in place.
  await mkdir(path.join(directory, "raw"));
  const resources: SiteResource[] = [];
  const known = new Map<string, SiteResource>();
  const enqueue = (url: string, from: string) => {
    const previous = known.get(url);
    if (previous) {
      if (from && !previous.discoveredFrom.includes(from)) previous.discoveredFrom.push(from);
      return;
    }
    const resource: SiteResource = { url, finalUrl: url, status: null, contentType: null, sha256: null, file: null, bytes: 0, discoveredFrom: from ? [from] : [] };
    known.set(url, resource);
    resources.push(resource);
  };
  enqueue(seedUrl, "");
  let totalBytes = 0;
  let requests = 0;
  const fetchImpl = options.fetchImpl ?? fetch;
  for (let index = 0; index < resources.length; index++) {
    const resource = resources[index];
    if (requests >= limits.maxResources || totalBytes >= limits.maxTotalBytes) {
      resource.error = "Crawl limit reached; resource was discovered but not fetched";
      continue;
    }
    const chunks: Uint8Array[] = [];
    let gotResponse = false;
    try {
      if (requests) await pause(limits.delayMs);
      const signal = AbortSignal.timeout(limits.timeoutMs);
      let response: Response;
      let currentUrl = resource.url;
      const redirects = new Set<string>();
      while (true) {
        if (requests >= limits.maxResources) throw new Error("Request limit reached during redirect");
        requests++;
        response = await fetchImpl(currentUrl, { redirect: "manual", signal, headers: { "user-agent": "HouseSourceArchive/1.0 (bounded research crawl)", accept: "*/*" } });
        gotResponse = true;
        resource.finalUrl = currentUrl;
        resource.status = response.status;
        resource.contentType = response.headers.get("content-type");
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        const next = location && canonicalUrl(redirectLocation(location), currentUrl, origin);
        await response.body?.cancel();
        if (!next) throw new Error("Redirect has no same-origin target");
        if (redirects.has(next) || redirects.size >= 8) throw new Error("Redirect cycle or redirect limit reached");
        redirects.add(next);
        currentUrl = next;
        await pause(limits.delayMs);
      }
      const reader = response.body?.getReader();
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const available = Math.min(limits.maxBytes - resource.bytes, limits.maxTotalBytes - totalBytes);
            const accepted = value.subarray(0, Math.max(0, available));
            chunks.push(accepted);
            resource.bytes += accepted.byteLength;
            totalBytes += accepted.byteLength;
            if (accepted.byteLength < value.byteLength) {
              resource.partial = true;
              await reader.cancel();
              throw new Error("Response byte limit exceeded; archived body is partial");
            }
          }
        } catch (error) {
          resource.partial = true;
          await reader.cancel().catch(() => undefined);
          throw error;
        }
      }
      if (!response.ok) resource.error = `HTTP ${response.status}; data is unreachable in this run`;
    } catch (error) {
      resource.error = error instanceof Error ? error.message : String(error);
    }
    if (gotResponse) {
      const body = Buffer.concat(chunks);
      resource.sha256 = createHash("sha256").update(body).digest("hex");
      resource.file = `raw/${resource.sha256}.bin`;
      await writeFile(path.join(directory, resource.file), body, { flag: "wx", mode: 0o444 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      if (!resource.error) {
        if (!known.has(resource.finalUrl)) known.set(resource.finalUrl, resource);
        const text = body.toString("utf8");
        const parsed = parseXuequzhushouSiteResource(text, resource.finalUrl, resource.contentType ?? "");
        if (parsed.issues.length) resource.parseIssues = parsed.issues;
        for (const url of discoverSiteReferences(text, resource.finalUrl, resource.contentType ?? "")) enqueue(url, resource.finalUrl);
      }
    }
    options.onResource?.(resource);
  }
  const manifest: SiteManifest = {
    version: 1, runId, source: "xuequzhushou.cn", provenance: "third-party", seedUrl, startedAt,
    finishedAt: new Date().toISOString(), complete: resources.every((resource) => !resource.error),
    discovery: "same-origin static links, script literals and recursive JSON filenames", limits, resources,
  };
  await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o444 });
  return { directory, manifest };
}
