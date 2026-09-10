import { NextResponse } from "next/server";
import { DatabaseExplorerError, getTableRows } from "@/lib/db/explorer";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const schema = params.get("schema");
  const name = params.get("name");
  if (!schema || !name) {
    return NextResponse.json({ error: "schema and name are required" }, { status: 400 });
  }
  try {
    const filtersRaw = params.get("filters");
    let filters: Record<string, string> | undefined;
    if (filtersRaw) {
      try {
        const parsed = JSON.parse(filtersRaw);
        if (parsed && typeof parsed === "object") {
          filters = {};
          for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof v === "string") filters[k] = v;
          }
        }
      } catch {
        return NextResponse.json({ error: "invalid filters param" }, { status: 400 });
      }
    }

    const result = await getTableRows(schema, name, {
      page: params.get("page") ? Number(params.get("page")) : undefined,
      pageSize: params.get("pageSize") ? Number(params.get("pageSize")) : undefined,
      search: params.get("search"),
      orderBy: params.get("orderBy"),
      orderDir: params.get("orderDir") ?? undefined,
      filters,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof DatabaseExplorerError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
