/**
 * Register existing third-party tier evidence stored in school attrs.
 *
 * Dry-run is the default; pass --apply to commit. This migration only adds
 * provenance rows and never changes school fields or school-community links.
 */
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const apply = process.argv.includes("--apply");

type XhsVotes = {
  source_url?: unknown;
  source_name?: unknown;
  top_tier?: unknown;
  ingestion_note?: unknown;
  note_ids?: unknown;
};

type SchoolRow = {
  id: number;
  name: string;
  district: string;
  xhs_votes: XhsVotes | null;
  xhs_first_note: string | null;
  xhs_last_note: string | null;
  xhs_first_query: string | null;
  xhs_last_query: string | null;
};

type SourcePlan = {
  schoolId: number;
  schoolName: string;
  district: string;
  url: string;
  sourceName: string;
  sourceTitle: string;
  confidence: "low" | "medium";
  evidence: string;
  raw: Record<string, unknown>;
};

export function httpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function classifyThirdPartyUrl(url: string) {
  const host = new URL(url).hostname.toLowerCase();
  if (host === "www.xiaohongshu.com" || host.endsWith(".xiaohongshu.com")) {
    return { sourceName: "小红书 XHS", confidence: "medium" as const };
  }
  if (host === "mp.weixin.qq.com" || host.endsWith(".weixin.qq.com")) {
    return { sourceName: "微信文章（第三方）", confidence: "low" as const };
  }
  if (host === "www.sogou.com" || host.endsWith(".sogou.com")) {
    return { sourceName: "搜狗检索跳转（第三方）", confidence: "low" as const };
  }
  return { sourceName: "历史第三方检索来源", confidence: "low" as const };
}

export function buildSourcePlans(row: SchoolRow): SourcePlan[] {
  const plans = new Map<string, SourcePlan>();
  const votes = row.xhs_votes ?? {};
  const voteUrl = typeof votes.source_url === "string" ? votes.source_url.trim() : "";
  const noteValues = [
    ["attrs.xhs_first_note", row.xhs_first_note, row.xhs_first_query],
    ["attrs.xhs_last_note", row.xhs_last_note, row.xhs_last_query],
  ] as const;

  const add = (url: string, provenance: string, query: string | null, raw: Record<string, unknown>) => {
    if (!httpUrl(url) || plans.has(url)) return;
    const classification = classifyThirdPartyUrl(url);
    const tier = typeof votes.top_tier === "string" ? votes.top_tier : "未标注梯队";
    const sourceTitle = classification.sourceName === "小红书 XHS"
      ? `小红书梯队投票聚合（${tier}）`
      : `${row.district}区第三方梯队检索资料`;
    plans.set(url, {
      schoolId: row.id,
      schoolName: row.name,
      district: row.district,
      url,
      sourceName: classification.sourceName,
      sourceTitle,
      confidence: classification.confidence,
      evidence: `从${provenance}登记；仅作第三方梯队参考，不代表官方招生或学区结论。`,
      raw: {
        migration: "third_party_tier_source",
        provenance,
        query,
        school_name: row.name,
        district: row.district,
        xhs_votes: votes,
        original_value: raw.original_value,
      },
    });
  };

  if (httpUrl(voteUrl)) {
    add(voteUrl, "attrs.xhs_votes.source_url", null, { original_value: voteUrl });
  }
  for (const [provenance, value, query] of noteValues) {
    if (typeof value === "string") add(value.trim(), provenance, query, { original_value: value });
  }
  return [...plans.values()];
}

async function main() {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<SchoolRow>(`
      SELECT id, name, district,
             attrs->'xhs_votes' AS xhs_votes,
             nullif(trim(attrs->>'xhs_first_note'), '') AS xhs_first_note,
             nullif(trim(attrs->>'xhs_last_note'), '') AS xhs_last_note,
             nullif(trim(attrs->>'xhs_first_query'), '') AS xhs_first_query,
             nullif(trim(attrs->>'xhs_last_query'), '') AS xhs_last_query
      FROM public.schools
      WHERE attrs ? 'xhs_votes' OR attrs ? 'xhs_first_note' OR attrs ? 'xhs_last_note'
      ORDER BY district, id
    `);
    const plans = result.rows.flatMap(buildSourcePlans);
    let inserted = 0;
    for (const plan of plans) {
      const insertedRow = await client.query(
        `
          INSERT INTO public.web_data_source(
            school_id, source_type, source_name, source_url, source_title,
            evidence, confidence, raw, fetched_at, created_at, updated_at
          )
          VALUES ($1, 'third_party_tier', $2, $3, $4, $5, $6, $7::jsonb, now(), now(), now())
          ON CONFLICT (school_id, source_url, source_type) DO NOTHING
          RETURNING id
        `,
        [
          plan.schoolId,
          plan.sourceName,
          plan.url,
          plan.sourceTitle,
          plan.evidence,
          plan.confidence,
          JSON.stringify(plan.raw),
        ],
      );
      inserted += insertedRow.rowCount ?? 0;
    }
    const total = Number((await client.query("SELECT count(*)::int AS count FROM public.web_data_source")).rows[0].count);
    if (apply) await client.query("COMMIT"); else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", schools: result.rowCount, candidates: plans.length, inserted, sourcesTotal: total }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
