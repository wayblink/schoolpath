import { NextResponse } from "next/server";
import { ingestRecords } from "@/lib/import/push";

export const runtime = "nodejs";

// 固定导入接口（R2）：外部采集/导入项目的唯一入口。
// 鉴权：x-ingest-token 头匹配 env INGEST_TOKEN（未配置时拒绝所有请求，防止误开）。
export async function POST(request: Request) {
  const expected = process.env.INGEST_TOKEN;
  if (!expected) {
    return NextResponse.json({ error: "ingest endpoint is not configured (INGEST_TOKEN missing)" }, { status: 503 });
  }
  const token = request.headers.get("x-ingest-token");
  if (!token || token !== expected) {
    return NextResponse.json({ error: "invalid or missing x-ingest-token" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "body must be valid JSON" }, { status: 400 });
  }
  try {
    return NextResponse.json(await ingestRecords(body));
  } catch (err) {
    const message = err instanceof Error ? err.message : "ingest failed";
    const status = message.includes("must") || message.includes("exceeds") || message.includes("not JSON") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
