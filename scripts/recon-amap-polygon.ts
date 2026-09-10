/**
 * 侦察 amap.com 小区详情页 polygon 数据来源
 *
 * 1. 打开 https://www.amap.com/place/{poi_id}
 * 2. 拦截所有 network 请求
 * 3. 提取所有 JSON 响应里看似含 polygon 的字段
 * 4. 也尝试从 window 全局变量里抓 polygon-shape 数据
 *
 * 用法: pnpm tsx scripts/recon-amap-polygon.ts [poi_id]
 *      默认 B00154DNIE = 长桥五村
 */
import { chromium, type Request, type Response } from "playwright";
import { writeFileSync } from "node:fs";

const POI_ID = process.argv[2] ?? "B00154DNIE";
const URL = `https://www.amap.com/place/${POI_ID}`;
const OUT = `recon-${POI_ID}.json`;

type ReqLog = {
  url: string;
  method: string;
  type: string;
  status: number;
  responseSize: number;
  hasJSON: boolean;
  contentType: string;
  jsonKeys?: string[];
  jsonPreview?: string;
  polygonCandidates?: Array<{ path: string; sample: string }>;
};

function findPolygonCandidates(obj: unknown, path = ""): Array<{ path: string; sample: string }> {
  const out: Array<{ path: string; sample: string }> = [];
  if (obj == null) return out;
  if (typeof obj === "string") {
    // 寻找数字串 (lng,lat) 模式
    if (obj.length > 60 && /[\d.]+[,;|][\d.]+/.test(obj)) {
      out.push({ path, sample: obj.slice(0, 120) });
    }
    return out;
  }
  if (Array.isArray(obj)) {
    // 数组里可能是坐标对
    if (
      obj.length >= 3 &&
      Array.isArray(obj[0]) &&
      obj[0].length === 2 &&
      typeof obj[0][0] === "number"
    ) {
      out.push({ path, sample: JSON.stringify(obj.slice(0, 3)) });
    }
    // 嵌套：递归前几个元素
    for (let i = 0; i < Math.min(obj.length, 5); i++) {
      out.push(...findPolygonCandidates(obj[i], `${path}[${i}]`));
    }
    return out;
  }
  if (typeof obj === "object") {
    const o = obj as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) {
      // 关键字 hint
      if (
        /polyline|polygon|boundary|coordinates|points|shape|geom|geometry|outline|border|fence/i.test(
          k,
        )
      ) {
        const s = typeof v === "string" ? v : JSON.stringify(v);
        if (s && s.length > 0) {
          out.push({ path: `${path}.${k}`, sample: s.slice(0, 200) });
        }
      }
      out.push(...findPolygonCandidates(v, `${path}.${k}`));
    }
  }
  return out;
}

async function main() {
  console.log(`侦察 amap.com polygon 数据来源`);
  console.log(`POI: ${POI_ID}  URL: ${URL}\n`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();

  const reqs: ReqLog[] = [];
  const respMap = new Map<Request, Response>();

  page.on("response", (resp) => respMap.set(resp.request(), resp));

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  // 给地图渲染时间
  await page.waitForTimeout(8_000);

  // 收集所有请求
  for (const req of page.context().pages()[0]?.frames()[0]?.parentFrame?.()
    ?.page()
    ?.context()
    ?.pages()
    ?.flatMap((p) => p.frames())
    ?.flatMap(() => []) ?? []) {
    // ignore
  }

  // 用 routing 监听: 已经过了；改用 cdp session 或 request log
  // 实际上 page.on("requestfinished") 早就触发了，我们错过了。改用 perf API
  const perfEntries = (await page.evaluate(() =>
    performance.getEntriesByType("resource").map((e) => ({
      name: e.name,
      type: (e as PerformanceResourceTiming).initiatorType,
      size: (e as PerformanceResourceTiming).transferSize,
      duration: (e as PerformanceResourceTiming).duration,
    })),
  )) as Array<{ name: string; type: string; size: number; duration: number }>;
  console.log(`Performance entries: ${perfEntries.length}`);

  // 过滤出可能含 polygon 数据的 JSON / XHR endpoint
  const candidates = perfEntries
    .filter((e) => e.type === "xmlhttprequest" || e.type === "fetch")
    .filter((e) => !/\.png$|\.jpg$|\.webp$|\.css$|\.js$|\.svg$/.test(e.name));
  console.log(`\n候选 XHR/fetch 请求 (${candidates.length}):`);
  for (const c of candidates) {
    console.log(`  - [${c.type}] ${c.name}`);
  }

  // 尝试 fetch 这些 URL 拿到 body，看里面有没有 polygon
  console.log(`\n抓取每个候选的响应内容...`);
  const results: ReqLog[] = [];
  for (const c of candidates) {
    try {
      const r = await page.request.get(c.name, { timeout: 10_000 });
      const ct = r.headers()["content-type"] ?? "";
      const txt = await r.text();
      const sz = txt.length;
      let hasJSON = false;
      let jsonKeys: string[] | undefined;
      let polygonCandidates: Array<{ path: string; sample: string }> | undefined;
      let jsonPreview: string | undefined;
      try {
        const j = JSON.parse(txt);
        hasJSON = true;
        jsonKeys = Object.keys(j).slice(0, 30);
        polygonCandidates = findPolygonCandidates(j).slice(0, 10);
        jsonPreview = JSON.stringify(j).slice(0, 300);
      } catch {
        // 不是 JSON
      }
      results.push({
        url: c.name,
        method: "GET",
        type: c.type,
        status: r.status(),
        responseSize: sz,
        hasJSON,
        contentType: ct,
        jsonKeys,
        jsonPreview,
        polygonCandidates,
      });
    } catch (err) {
      console.log(`  ✗ ${c.name.slice(0, 80)}: ${(err as Error).message}`);
    }
  }

  // 也提取 window 上的关键全局变量
  const windowDump = (await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const keys: Array<{ key: string; type: string; sampleStr?: string }> = [];
    for (const k of Object.keys(w)) {
      if (k.startsWith("webkit") || k.startsWith("chrome")) continue;
      const v = w[k];
      const t = typeof v;
      if (t === "function" || t === "undefined") continue;
      if (
        /detail|poi|place|map|aliyun|aMap|AMap|page|state|store/i.test(k) ||
        (t === "object" && v !== null)
      ) {
        let sample: string | undefined;
        try {
          sample = JSON.stringify(v)?.slice(0, 300);
        } catch {
          sample = String(v).slice(0, 200);
        }
        keys.push({ key: k, type: t, sampleStr: sample });
      }
    }
    return keys.slice(0, 60);
  })) as Array<{ key: string; type: string; sampleStr?: string }>;

  // 输出汇总
  const summary = {
    poi_id: POI_ID,
    url: URL,
    candidates_count: candidates.length,
    candidate_urls: candidates.map((c) => c.name),
    json_responses: results.filter((r) => r.hasJSON),
    non_json_xhr: results.filter((r) => !r.hasJSON).map((r) => ({ url: r.url, ct: r.contentType, sz: r.responseSize })),
    window_globals: windowDump,
  };
  writeFileSync(OUT, JSON.stringify(summary, null, 2), "utf-8");
  console.log(`\n✓ 写入 ${OUT}`);
  console.log(`  XHR 总数: ${candidates.length}`);
  console.log(`  其中 JSON 响应: ${results.filter((r) => r.hasJSON).length}`);
  console.log(`  含 polygon 候选字段的 JSON: ${results.filter((r) => r.hasJSON && r.polygonCandidates && r.polygonCandidates.length > 0).length}`);

  // 高亮含 polygon 候选的请求
  for (const r of results) {
    if (r.hasJSON && r.polygonCandidates && r.polygonCandidates.length > 0) {
      console.log(`\n  🎯 ${r.url}`);
      for (const pc of r.polygonCandidates.slice(0, 3)) {
        console.log(`     [${pc.path}] ${pc.sample.slice(0, 100)}`);
      }
    }
  }

  await browser.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("✗ FAILED:", (err as Error).message);
  console.error((err as Error).stack);
  process.exit(1);
});
