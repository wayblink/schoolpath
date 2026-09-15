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
    relations: number;
    pendingMatches: number;
    pendingConflicts: number;
    acceptedRelations: number;
    provisionalRelations: number;
    productRows: number;
  }>(`
    select
      (select count(*)::int from public.pending_school_communities) relations,
      (select count(*)::int from public.entity_match_candidates where status='pending') "pendingMatches",
      (select count(*)::int from public.field_conflicts where status='pending') "pendingConflicts",
      (select count(*)::int from public.pending_school_communities where review_status='accepted') "acceptedRelations",
      (select count(*)::int from public.pending_school_communities where review_status='pending') "provisionalRelations",
      (select count(*)::int from public.school_communities) "productRows"
  `);
  const d = rows[0];
  const stages: PipelineStage[] = [
    {
      key: "source",
      label: "结构化",
      count: d.relations,
      status: "ok",
      hint: `${d.relations.toLocaleString()} 条待审关系（官方+第三方来源）`,
    },
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
      key: "review",
      label: "审核",
      count: d.acceptedRelations + d.provisionalRelations,
      status: "ok",
      hint: `${d.acceptedRelations} 已接受 · ${d.provisionalRelations} 待审核`,
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
