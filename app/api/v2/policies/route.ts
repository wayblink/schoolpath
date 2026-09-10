import { NextResponse } from "next/server"; import { getPolicies } from "@/lib/product/queries";
export const runtime="nodejs";
export async function GET(){const policies=await getPolicies();return NextResponse.json({policies,total:policies.length})}
