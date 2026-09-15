import { NextResponse } from "next/server"; import { getPathways } from "@/lib/product/queries";
export const runtime="nodejs"; export async function GET(request:Request){const u=new URL(request.url);return NextResponse.json({pathways:await getPathways({district:u.searchParams.get("district")||undefined,mode:u.searchParams.get("mode")||undefined,limit:Number(u.searchParams.get("limit")||300)})})}
