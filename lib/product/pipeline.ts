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
    crawlRuns: number;
    extracted: number;
    sources: number;
    sourceSchools: number;
    relations: number;
    pendingMatches: number;
    pendingConflicts: number;
    acceptedRelations: number;
    provisionalRelations: number;
    unreleasedRelations: number;
    batches: number;
    publishedBatches: number;
    productRows: number;
  }>(`
    select
      (select count(*)::int from ingest.crawl_runs) "crawlRuns",
      (select count(*)::int from ingest.extracted_records) extracted,
      (select count(*)::int from ingest.sources) sources,
      (select count(*)::int from catalog.source_schools) "sourceSchools",
      (select count(*)::int from catalog.school_communities) relations,
      (select count(*)::int from catalog.entity_match_candidates where status='pending') "pendingMatches",
      (select count(*)::int from catalog.field_conflicts where status='pending') "pendingConflicts",
      (select count(*)::int from catalog.school_communities where review_status='accepted') "acceptedRelations",
      (select count(*)::int from catalog.school_communities where review_status='pending') "provisionalRelations",
      (select count(*)::int from catalog.school_communities where review_status='accepted' and release_batch_id is null) "unreleasedRelations",
      (select count(*)::int from catalog.release_batches) batches,
      (select count(*)::int from catalog.release_batches where status='published') "publishedBatches",
      (select count(*)::int from public.school_communities) "productRows"
  `);
  const d = rows[0];
  const stages: PipelineStage[] = [
    {
      key: "collect",
      label: "采集",
      count: d.crawlRuns,
      status: "ok",
      hint: `${d.crawlRuns} 个采集批次 · ${d.sources} 个来源注册`,
    },
    {
      key: "import",
      label: "导入",
      count: d.extracted,
      status: "ok",
      hint: `${d.extracted.toLocaleString()} 条候选记录（固定接口或脚本写入）`,
    },
    {
      key: "source",
      label: "结构化",
      count: d.sourceSchools + d.relations,
      status: "ok",
      hint: `${d.sourceSchools} 条来源学校 · ${d.relations} 条来源关系`,
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
      key: "publish",
      label: "发布",
      count: d.batches,
      status: d.unreleasedRelations > 0 && d.batches === 0 ? "broken" : d.unreleasedRelations > 0 ? "pending" : "ok",
      hint:
        d.batches === 0
          ? `${d.unreleasedRelations} 条已审核关系等待发布（尚未创建任何批次）`
          : `${d.batches} 个批次（${d.publishedBatches} 已发布） · ${d.unreleasedRelations} 条待发布`,
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
