import { NextRequest, NextResponse } from "next/server";
import { deleteRow, updateRow, OPS_TABLES } from "@/lib/db/crud";

export const runtime = "nodejs";

type Params = { params: Promise<{ table: string; id: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  const { table, id } = await params;
  if (!OPS_TABLES.some((t) => t.key === table)) return NextResponse.json({ error: "unknown table" }, { status: 404 });
  const rowId = Number(id);
  if (!Number.isInteger(rowId) || rowId <= 0) return NextResponse.json({ error: "invalid id" }, { status: 400 });
  try {
    const body = await request.json();
    const row = await updateRow(table, rowId, body);
    return NextResponse.json({ row });
  } catch (err) {
    const message = (err as Error).message;
    const status = /foreign key|not-null|invalid input|必须是|没有可|not found/.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const { table, id } = await params;
  if (!OPS_TABLES.some((t) => t.key === table)) return NextResponse.json({ error: "unknown table" }, { status: 404 });
  const rowId = Number(id);
  if (!Number.isInteger(rowId) || rowId <= 0) return NextResponse.json({ error: "invalid id" }, { status: 400 });
  try {
    return NextResponse.json(await deleteRow(table, rowId));
  } catch (err) {
    const message = (err as Error).message;
    // FK 依赖（如学校被对口关系引用）时给友好提示
    const status = /foreign key|violates/.test(message) ? 409 : /not found/.test(message) ? 404 : 500;
    return NextResponse.json({ error: /foreign key|violates/.test(message) ? "该行被其他数据引用，无法删除（先清理引用方）" : message }, { status });
  }
}
