/** Fill blank school_nature from unique explicit nature rows in the official JSON snapshot. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const apply = process.argv.includes("--apply");
const sourcePath = valueArg("--source") ?? path.join(process.cwd(), "data/audit/official-school-info/latest-with-attachments.json");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
const reportDir = path.join(process.cwd(), ".tmp", "official-json-nature-backfill", stamp);

type Source = { district: string; stage: "primary" | "middle" | "unknown"; name: string; nature: string; address?: string; sourceTitle: string; sourceUrl: string };
type School = { id: number; name: string; district: string; type: "primary" | "middle" | "nine_year"; school_nature: string | null };
type Nature = "公立" | "私立";

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

function normalize(value: string) {
  return value
    .replace(/[\s　·•\-—]/g, "")
    .replace(/[（）()]/g, "")
    .replace(/^上海市?/, "")
    .replace(/^民办|^私立/, "")
    .replace(/（小学部|初中部|中学部）|\(小学部\)|\(初中部\)|\(中学部\)/g, "")
    .replace(/小学部|初中部|中学部/g, "")
    .trim();
}

function schoolStage(type: School["type"]): Source["stage"] {
  return type === "primary" ? "primary" : type === "middle" ? "middle" : "unknown";
}

function nature(value: string): Nature | null {
  const isPrivate = /民办|私立/.test(value);
  const isPublic = /公办|公立/.test(value);
  if (isPrivate === isPublic) return null;
  if (isPrivate) return "私立";
  if (isPublic) return "公立";
  return null;
}

function sourceNature(row: Pick<Source, "nature" | "sourceTitle">): Nature | null {
  return nature(row.nature) ?? nature(row.sourceTitle);
}

async function main() {
  const parsed = JSON.parse(readFileSync(sourcePath, "utf8")) as { records: Source[] };
  const sources = parsed.records.filter((row) => row.name?.trim() && row.sourceUrl?.trim() && sourceNature(row));
  mkdirSync(reportDir, { recursive: true });
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    const schools = (await client.query<School>("SELECT id,name,district,type,school_nature FROM public.schools WHERE school_nature IS NULL ORDER BY district,id")).rows;
    const byKey = new Map<string, Source[]>();
    for (const source of sources) {
      const key = `${source.district}|${source.stage}|${normalize(source.name)}`;
      byKey.set(key, [...(byKey.get(key) ?? []), source]);
    }
    const actions: Array<Record<string, unknown>> = [];
    let updated = 0;
    for (const school of schools) {
      const candidates = byKey.get(`${school.district}|${schoolStage(school.type)}|${normalize(school.name)}`) ?? [];
      const distinct = [...new Map(candidates.map((row) => [`${row.sourceUrl}|${row.name}|${row.nature}`, row])).values()];
      const natures = new Set(distinct.map((row) => sourceNature(row)).filter((x): x is Nature => Boolean(x)));
      const source = natures.size === 1 && distinct.length === 1 ? distinct[0] : null;
      const normalizedNature = source ? sourceNature(source) : null;
      const action = source && normalizedNature ? (apply ? "update" : "dry-run") : distinct.length ? "skip-ambiguous" : "skip-no-source";
      const raw = source ? { migration: "official_json_nature", school_name: school.name, district: school.district, matched_name: source.name, nature: source.nature, nature_evidence: source.nature || source.sourceTitle, address: source.address ?? null, source_title: source.sourceTitle, source_url: source.sourceUrl } : null;
      if (apply && source && normalizedNature) {
        const result = await client.query(`UPDATE public.schools SET school_nature=$1::school_nature, attrs=jsonb_set(coalesce(attrs,'{}'::jsonb),'{official_json_nature}',$2::jsonb,true), updated_at=now() WHERE id=$3 AND school_nature IS NULL RETURNING id`, [normalizedNature, JSON.stringify(raw), school.id]);
        updated += result.rowCount ?? 0;
        if (result.rowCount) {
          await client.query(`INSERT INTO public.web_data_source(school_id,source_type,source_name,source_url,source_title,source_date,evidence,confidence,raw,fetched_at,created_at,updated_at) VALUES($1,'official_school_info','上海市各区教育局/政府公开信息',$2,$3,$4,$5,'high',$6::jsonb,now(),now(),now()) ON CONFLICT(school_id,source_url,source_type) DO UPDATE SET source_title=excluded.source_title,source_date=excluded.source_date,evidence=excluded.evidence,confidence=excluded.confidence,raw=excluded.raw,fetched_at=now(),updated_at=now()`, [school.id, source.sourceUrl, source.sourceTitle, source.sourceTitle.match(/20\d{2}/)?.[0] ?? null, `官方学校信息的性质字段或公民办分类标题明确标注${normalizedNature === "公立" ? "公办" : "民办"}，唯一匹配学校“${source.name}”。`, JSON.stringify(raw)]);
        }
      }
      actions.push({ schoolId: school.id, schoolName: school.name, district: school.district, normalizedNature, action, source: raw });
    }
    writeFileSync(path.join(reportDir, apply ? "backfill-applied.json" : "backfill-dry-run.json"), JSON.stringify({ mode: apply ? "apply" : "dry-run", sourceRows: sources.length, targets: schools.length, planned: actions.filter((x) => x.normalizedNature).length, updated, actions }, null, 2));
    if (apply) await client.query("COMMIT"); else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", sourceRows: sources.length, targets: schools.length, planned: actions.filter((x) => x.normalizedNature).length, updated, reportDir }, null, 2));
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { await client.end(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
