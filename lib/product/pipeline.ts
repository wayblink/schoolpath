// 七段流水线统计（R1）：/ops 图示数据源。
// 采集→导入→结构化→匹配→审核→发布→产品，每段计数 + 健康状态。
import { query } from "./queries";

export type PipelineStage = {
  key: string;
  label: string;
  count: number;
  status: "ok" | "pending" | "broken";
  hint: string;
};

export async function getPipelineStats() {
  const rows = await query<{
    pendingMatches: number;
    pendingConflicts: number;
    productRows: number;
  }>(`
    select
      (select count(*)::int from public.entity_match_candidates where status='pending') "pendingMatches",
      (select count(*)::int from public.field_conflicts where status='pending') "pendingConflicts",
      (select count(*)::int from public.school_communities) "productRows"
  `);
  const d = rows[0];
  const stages: PipelineStage[] = [
    {
      key: "match",
      label: "匹配",
      count: d.pendingMatches + d.pendingConflicts,
      status: d.pendingMatches + d.pendingConflicts > 0 ? "pending" : "ok",
      hint:
        d.pendingMatches + d.pendingConflicts > 0
          ? `${d.pendingMatches} 待匹配学校 · ${d.pendingConflicts} 待处理冲突`
          : "无待处理匹配与冲突",
    },
    {
      key: "visible",
      label: "产品",
      count: d.productRows,
      status: "ok",
      hint: `${d.productRows.toLocaleString()} 条对口小区（用户端 /schools 直读）`,
    },
  ];
  return { stages, generatedAt: new Date().toISOString() };
}
