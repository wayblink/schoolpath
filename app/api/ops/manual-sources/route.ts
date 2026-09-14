import { NextResponse } from "next/server";
import pg from "pg";

export const runtime = "nodejs";

// 人工录入（R5）：Ops 管理员手动插入学校信息源，source_type='manual'。
// 与采集来源严格区分：第三方事实不标为官方；manual 的 evidence 必填。
export async function POST(request: Request) {
  let body: { schoolId?: number; title?: string; sourceUrl?: string | null; sourceDate?: string | null; evidence?: string; confidence?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "body must be valid JSON" }, { status: 400 });
  }
  const schoolId = Number(body.schoolId);
  if (!Number.isInteger(schoolId) || schoolId <= 0) return NextResponse.json({ error: "schoolId must be a positive integer" }, { status: 400 });
  if (!body.evidence || !body.evidence.trim()) return NextResponse.json({ error: "evidence is required (人工核验依据)" }, { status: 400 });
  const confidence = ["high", "medium", "low"].includes(body.confidence ?? "") ? (body.confidence as string) : "medium";

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const row = await pool.query(
      `insert into public.web_data_source(school_id,source_type,source_name,source_url,source_title,source_date,evidence,confidence,raw)
       select s.id,'manual','人工录入',$2,$3,$4,$5,$6,jsonb_build_object('entry','ops_manual')
       from public.schools s where s.id=$1
       returning id,school_id "schoolId",source_type "sourceType",source_name "sourceName",source_title "sourceTitle",confidence`,
      [schoolId, body.sourceUrl?.trim() || null, body.title?.trim() || "人工录入信息源", body.sourceDate?.trim() || null, body.evidence.trim(), confidence],
    );
    if (!row.rowCount) return NextResponse.json({ error: "school not found" }, { status: 404 });
    return NextResponse.json(row.rows[0], { status: 201 });
  } finally {
    await pool.end();
  }
}
