import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectXuequzhushouSite,
  discoverSiteReferences,
  inventoryJsonRecords,
  parseXuequzhushouSiteResource,
} from "../lib/ingest/xuequzhushou-site";

const origin = "https://xuequzhushou.cn";

test("discovers actual homepage/map patterns and recursive config filenames", () => {
  const html = `<a href="上海学区信息.html">Back</a><script src="./map.js"></script>
    <script>fetch('学区数据/上海居委会边界_简化版.json?v=20260624i');
    fetch('学区数据/学区匹配_地图版.json?v=20260628a');
    fetch('学区数据/上海环线_GCJ02.json');
    fetch('学区数据/学区居委索引.json?v=20260624f');
    fetch('学区数据/居委名到GeoJSON映射.json?v=20260624f');
    fetch('学区数据/学区街道映射.json');
    fetch('学区数据/district_config.json');
    fetch('学区数据/初中梯队_cleaned.json?v=20260624m');
    return '<a href="school-district-map.html?' + q + '">map</a>';</script>`;
  const refs = discoverSiteReferences(html, `${origin}/school-district-map.html`, "text/html");
  assert.equal(refs.length, 11);
  assert.ok(refs.includes(`${origin}/school-district-map.html`));
  const configUrl = `${origin}/学区数据/district_config.json`;
  const config = { disabled: { enabled: false, nested: [{ file: "sub/more.json" }, "地图.geojson"] } };
  assert.deepEqual(discoverSiteReferences(JSON.stringify(config), configUrl, "application/json"), [
    new URL("sub/more.json", configUrl).href, new URL("地图.geojson", configUrl).href,
  ]);
});

test("resolves base URLs, escapes and data references while excluding external APIs", () => {
  const html = `<base href="/assets/"><a href="../school.html#top">school</a>
    <script src="m.js"></script><a href="rows.csv?a=1&amp;b=2">csv</a>
    <script>var src='addr'; buildLianjiaAddrUrl(addr); fetch("data\\u002fgeo.json"); fetch('https://external.example/data.json');</script>`;
  assert.deepEqual(discoverSiteReferences(html, `${origin}/pages/index.html`, "text/html"), [
    `${origin}/school.html`, `${origin}/assets/m.js`, `${origin}/assets/rows.csv?a=1&b=2`,
    `${origin}/assets/data/geo.json`,
  ]);
});

test("extracts every static data global including MS_TIER without executing scripts", () => {
  const source = `<script>var ALL_DATA = {"区":{"小学":[{"名称":"a } [ \\\"","unknown":null}]}};
    var DISTRICTS=["区"];var JUWOVERLAP={};var JUWOVERLAP_MS={};
    var MS_TIER={"区":{"学校":3}};var OTHER={"extra":[false,0]};
    var unsafe={"x":(()=>{throw new Error("must not execute")})()};</script>`;
  const parsed = parseXuequzhushouSiteResource(source, `${origin}/map.html`, "text/html");
  assert.deepEqual(parsed.documents.map((item) => item.name), [
    "ALL_DATA", "DISTRICTS", "JUWOVERLAP", "JUWOVERLAP_MS", "MS_TIER", "OTHER",
  ]);
  assert.ok(parsed.issues.some((issue) => issue.includes("unsafe")));
  assert.deepEqual(parsed.documents.find((item) => item.name === "MS_TIER")?.value, { 区: { 学校: 3 } });
});

test("inventory preserves nested objects, duplicate rows, primitives and pointer escaping", () => {
  const source = '{"districts":{"区":[{"c":[{"n":"same"},{"n":"same"}]}]},"a/b":{"~key":null},"empty":[]}';
  const parsed = parseXuequzhushouSiteResource(source, `${origin}/rows.json`, "application/json");
  assert.equal(parsed.documents[0].rawText, source);
  const rows = [...inventoryJsonRecords(parsed.documents[0].value)];
  assert.ok(rows.some((row) => row.pointer === "/a~1b/~0key" && row.value === null));
  assert.equal(rows.filter((row) => row.value === "same").length, 2);
  assert.deepEqual(rows[0].value, JSON.parse(source));
  assert.ok(rows.some((row) => row.pointer === "/empty" && row.kind === "array"));
  assert.equal(parseXuequzhushouSiteResource("invalid", `${origin}/bad.json`, "application/json").issues.length, 1);
});

test("preserves literal configurations with JS keys and rejects computed executable values", () => {
  const parsed = parseXuequzhushouSiteResource(`var TLB={1:'tier one',2:'tier two'};
    var HIDDEN={disabled:true,places:['a'],unknown:null,negative:-1};
    var BAD={value:readSecret()};`, `${origin}/config.js`, "text/javascript");
  assert.deepEqual(parsed.documents.map((item) => item.name), ["TLB", "HIDDEN"]);
  assert.deepEqual(parsed.documents[1].value, { disabled: true, places: ["a"], unknown: null, negative: -1 });
  assert.equal(parsed.documents[0].rawText, "{1:'tier one',2:'tier two'}");
  assert.ok(parsed.issues.some((issue) => issue.includes("BAD")));
});

test("crawl archives redirects, cycles, shared provenance, failures and immutable files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xuequ-site-"));
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    const pathname = new URL(url).pathname;
    if (pathname === "/") return new Response(null, { status: 302, headers: { location: "/index.html" } });
    if (pathname === "/index.html") return new Response('<script>fetch("data/config.json");</script><a href="map.html">map</a>', { headers: { "content-type": "text/html" } });
    if (pathname === "/map.html") return new Response('<script>fetch("data/shared.json"); fetch("broken.json"); fetch("offline.json"); fetch("escape.json");</script>', { headers: { "content-type": "text/html" } });
    if (pathname === "/data/config.json") return Response.json({ file: "nested/more.json", data: "shared.json" });
    if (pathname === "/data/nested/more.json") return Response.json({ back: "../config.json", data: "../shared.json" });
    if (pathname === "/data/shared.json") return Response.json([{ n: "a" }, { n: "a" }]);
    if (pathname === "/offline.json") throw new Error("network unavailable");
    if (pathname === "/escape.json") return new Response(null, { status: 302, headers: { location: "https://external.example/private.json" } });
    return new Response("missing data", { status: 404 });
  };
  try {
    const { directory, manifest } = await collectXuequzhushouSite({ outputRoot: root, runId: "fixture", fetchImpl: fetcher, delayMs: 0 });
    assert.equal(manifest.complete, false);
    assert.equal(calls.filter((url) => url.endsWith("shared.json")).length, 1);
    assert.equal(calls.filter((url) => url.endsWith("config.json")).length, 1);
    assert.ok(calls.every((url) => new URL(url).origin === origin));
    const shared = manifest.resources.find((item) => item.url.endsWith("shared.json"))!;
    assert.equal(shared.discoveredFrom.length, 3);
    const missing = manifest.resources.find((item) => item.url.endsWith("broken.json"))!;
    assert.equal(missing.status, 404);
    assert.ok(missing.error);
    assert.equal(await readFile(path.join(directory, missing.file!), "utf8"), "missing data");
    for (const resource of manifest.resources.filter((item) => item.file)) {
      const raw = await readFile(path.join(directory, resource.file!));
      assert.equal(createHash("sha256").update(raw).digest("hex"), resource.sha256);
      assert.equal(raw.length, resource.bytes);
    }
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")), manifest);
    await assert.rejects(collectXuequzhushouSite({ outputRoot: root, runId: "fixture", fetchImpl: fetcher }), /EEXIST/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("crawl limits record pending resources and reject unsafe run paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xuequ-site-"));
  try {
    const result = await collectXuequzhushouSite({ outputRoot: root, runId: "limited", maxResources: 1, delayMs: 0,
      fetchImpl: async () => new Response('<a href="next.html">next</a>', { headers: { "content-type": "text/html" } }),
    });
    assert.equal(result.manifest.complete, false);
    assert.match(result.manifest.resources[1].error!, /limit/i);
    await assert.rejects(collectXuequzhushouSite({ outputRoot: root, runId: "../escape" }), /runId/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("follows real site's raw UTF-8 Location header without double encoding", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xuequ-site-"));
  const target = new URL("/上海学区信息.html", origin).href;
  const calls: string[] = [];
  try {
    const { manifest } = await collectXuequzhushouSite({ outputRoot: root, delayMs: 0,
      fetchImpl: async (input) => {
        calls.push(String(input));
        return calls.length === 1
          ? new Response(null, { status: 307, headers: { location: Buffer.from("/上海学区信息.html", "utf8").toString("latin1") } })
          : new Response("<html></html>", { headers: { "content-type": "text/html" } });
      },
    });
    assert.deepEqual(calls, [`${origin}/`, target]);
    assert.equal(manifest.resources[0].finalUrl, target);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("byte limits and interrupted bodies remain explicit partial archives", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xuequ-site-"));
  try {
    const limited = await collectXuequzhushouSite({ outputRoot: root, runId: "bytes", maxBytes: 4, delayMs: 0,
      fetchImpl: async () => new Response("abcdefgh", { headers: { "content-type": "application/json" } }),
    });
    const resource = limited.manifest.resources[0];
    assert.equal(resource.partial, true);
    assert.equal(resource.bytes, 4);
    assert.equal(limited.manifest.complete, false);
    assert.equal(await readFile(path.join(limited.directory, resource.file!), "utf8"), "abcd");
    const broken = await collectXuequzhushouSite({ outputRoot: root, runId: "stream", delayMs: 0,
      fetchImpl: async () => new Response(new ReadableStream({ pull(controller) { controller.error(new Error("connection closed")); } })),
    });
    assert.equal(broken.manifest.resources[0].partial, true);
    assert.match(broken.manifest.resources[0].error!, /connection closed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("request deadline archives timeout without claiming a missing dataset", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xuequ-site-"));
  try {
    const { manifest } = await collectXuequzhushouSite({ outputRoot: root, timeoutMs: 5, delayMs: 0,
      fetchImpl: async (_input, init) => new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("deadline not applied")), 500);
        init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
      }),
    });
    assert.match(manifest.resources[0].error!, /timeout/i);
    assert.equal(manifest.resources[0].status, null);
    assert.equal(manifest.resources[0].file, null);
    assert.equal(manifest.complete, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
