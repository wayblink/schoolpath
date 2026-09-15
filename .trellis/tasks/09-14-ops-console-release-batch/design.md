# 技术设计 — Ops 控制台重构与发布批次能力

## 架构总览

三层数据流 + 两个控制面：

```
[外部采集/导入项目]  --POST /api/ingest/records (token)-->  ingest 候选池
                                                              │
[管理员 Ops 控制台]  <-- /api/v2/ops/* ------------------  catalog 来源层（候选管理、审核）
        │                                                      │
        └── 发布批次 (draft→published→rolled_back) ----------→  public 产品层（upsert）
```

命名语义（2026-09-14 确认，保留不改成名）：`catalog` 沿用数据工程中间层术语，指"经治理的权威实体目录"——`ingest` 是原始原料（raw + 溯源），`catalog` 是编目后的来源层事实（canonical 实体、别名、未发布/已审核关系），`public` 是上架产品（用户端直读）。catalog.schools / catalog.communities 通过 legacy_id ↔ public 实体映射（2,028/2,044、30,638/30,638）印证这层职责。

核心原则：**ingest 只进不出（外部推送的终点），产品层只由发布批次写（Ops 唯一写入通道）**。审计状态、审核状态、发布状态全部是 catalog/public 表上的列，不再有独立 audit schema 的半成品工作流表。

## 数据模型收敛

### D1 表结构目标态

| 层 | 表 | 行数(现状) | 收敛动作 |
|---|---|---|---|
| ingest | crawl_runs, extracted_records, sources | 810 / 38,438 / 2 | 保留不变，R2 固定接口写入处 |
| catalog | source_schools | 455 | 保留 |
| catalog | **relations**（由 school_district_relations 改名/重构） | 3,446 | **成为唯一来源层关系表**：带 source_record_id 溯源、review_status(accepted/provisional/rejected)、match_status(raw/school_matched/community_matched/matched)、release_batch_id(新增列)、published_at |
| catalog | schools, communities, districts, policy_documents, school_aliases, school_feeder_relations | 2,044 / 30,638 / 16 / 832 / 473 / 81 | 保留；policy_documents 定为 policies 唯一真源 |
| catalog | release_batches | 0 | **由 audit 提升**：发布批次记账唯一表 |
| catalog | entity_match_candidates, field_conflicts | 455 / 130 | **由 audit 迁入** |
| catalog | candidates（由 public.school_community_candidates 迁入） | 23,070 | 官方原始候选池，并入 catalog；MapWorkspace 查询改指 catalog.candidates |
| public | schools, communities | 2,028 / 31,399 | 保留（产品层实体） |
| public | **school_communities** | 42,881 | **产品层唯一关系表**：去重 3,479 行 + 补 (school_id, community_id) 唯一索引 + 加 release_batch_id 列（可选软删标记） |
| public | web_data_source | 3,961 | 保留；manual 写入处 |
| public | district_boundaries, school_info, community_price_snapshots | 211 / 0 / 31 | 保留（school_info 有 MapWorkspace category 引用） |
| 删除 | public.policies（832，内容与 catalog.policy_documents 100% 重复） | — | **删表，改读 catalog.policy_documents** |
| 删除 | audit.school_community_relation_candidates（2,764，与 relations 重复记账） | — | 数据核对后删除（审核结果已体现在 relations.review_status） |
| 删除 | catalog.school_community_assignments（36,996，与产品层 school_communities 职责重叠） | — | **决策见 D3**：diff 报告经用户确认后删，全量留档 CSV |
| 删除 | catalog.school_ratings（0 行，仅 audit-missing-data.ts 引用计数） | — | 空表，删（脚本引用同步处理） |
| 删除 | 44 张 public.*_backup_* 表 | 0（128.9MB） | 全删（A1 已 grep 确认代码零引用） |
| 保留 | public.community_price_sources | **37 行**（pg_stat 显示 0 是统计滞后，A4 精确计数 37） | **不删**——设计初稿误判为空表，实测有数据；保留待查消费方 |

**school_info 注意**：0 行但 MapWorkspace.tsx:202 有 category 标签引用（"官方校情"），保留表结构。

### D2 迁移顺序（可回滚，每步独立提交）

1. **预备**：`pg_dump` 全库结构 + 关键表数据快照到 `data/migrations/2026-09-14-converge/`。
2. **加列**：relations 加 release_batch_id；school_communities 加 release_batch_id（bigint null）。
3. **去重 + 唯一索引**：school_communities 按 (school_id, community_id) 去重，保留策略**官方/学区助手来源优先、年份降序、id 兜底**（实测：删除的 3,479 行全为 2025 及更早、0 行 2026 官方行误删；其中 3,212 行为被更新官方行取代的旧官方行、267 行为高德推断行）→ `CREATE UNIQUE INDEX uq_school_communities_pair ON school_communities(school_id, community_id)`。被删行完整留档于 data/migrations/2026-09-14-converge/data-public_school_communities.csv（42,881 行全量快照）。
4. **表改名/迁表**：school_district_relations → relations（保留 school_district_relations 为视图兼容一版，随后删）；audit.entity_match_candidates/field_conflicts/release_batches → catalog.*（ALTER ... SET SCHEMA）；public.school_community_candidates → catalog.candidates。
5. **policies 收敛**：queries.ts:97,114 policyCount 改读 catalog.policy_documents（count where p.public_school_id=s.id）；DROP public.policies。
6. **双写关系表核对**：school_community_assignments vs school_communities 逐条 diff 报告（交集/仅A/仅B），仅A 行按决策补录或留档；DROP assignments。
7. **audit 清理**：relation_candidates 核对后 DROP；确认无残留引用后 DROP SCHEMA audit（release 记账已在 catalog.release_batches）。
8. **删垃圾**：44 张 backup、school_ratings（community_price_sources 有 37 行数据，保留）。

每步提供对应 rollback SQL（DDL 反向操作；DML 用快照恢复）。

### D3 关键决策：assignments(36,996) 与 school_communities(42,881) 的处理

distinct (school_id, community_id) 口径（A3 实测，2026-09-14）：assignments 35,956 对、school_communities 39,402 对、**交集 12,780**、仅 assignments 23,176、仅 school_communities 26,622。

关键事实：
- school_communities 是**更新、维护更好的一侧**：它有 assignments 没有的 2026 官方来源（official_pudong_primary_2026 2,268、official_pudong_middle_2026 2,299），且有 `xuequzhushou_reviewed_accepted`（235）这类经审核标记的行；committee_name 与 communities 主表 source_committee 一致（assignments 侧 committee_name 是不同轮次归一化的旧文本，6,500 行不一致）。
- 交集行字段冲突：year 98 / verified 70 / source 98 / committee_name 6,500——committee_name 是冗余展示字段（可从 communities 主表重取），year/verified 冲突量小。
- assignments 独有 23,176 对的来源（official_area_level 11,088 / amap 7,643 / pudong_junior_2025 2,459 / baoshan 1,280 …）与 school_communities 独有对的来源高度重叠——判断为早期 ingest 轮次社区匹配结果不同（同一居委文本解析到不同 community_id），非新增事实。
- assignments 唯一消费方：queries.ts:52 的 overview 计数。

**决策**：school_communities 为产品层唯一关系表；assignments 全表数据已 CSV 快照（data/migrations/2026-09-14-converge/data-catalog_school_community_assignments.csv），**diff 报告（CSV + 本段摘要）经用户确认后 DROP**，queries.ts:52 改读 school_communities 或移除该计数。非交集 23,176 行留档即可，不补录（判定为旧匹配口径产物，补录反而引入陈旧数据）。

### D4 发布批次执行逻辑（R4）

```sql
-- 单事务
BEGIN;
-- 1) 批次状态机校验: release_batches.status='draft'
-- 2) upsert 产品层（幂等）:
INSERT INTO public.school_communities(school_id, community_id, committee_name, year, source_name, source_url, verified, release_batch_id)
SELECT ... FROM catalog.relations r
WHERE r.release_batch_id = $batchId
ON CONFLICT (school_id, community_id) DO NOTHING;
-- 3) 回写来源层:
UPDATE catalog.relations SET published_at = now()
WHERE release_batch_id = $batchId AND published_at IS NULL;
-- 4) 批次置 published:
UPDATE catalog.release_batches SET status='published', published_at=now() WHERE id=$batchId AND status='draft';
COMMIT;
```

回滚：`UPDATE release_batches SET status='rolled_back'` + `DELETE FROM school_communities WHERE release_batch_id=$batchId`（事务，仅删本批次写入的行——release_batch_id 列保证可追溯）。

### D5 API 契约

- `POST /api/ingest/records`：header `x-ingest-token`；body `{sourceKey, sourceName, sourceKind, records:[{recordType, sourceKey, district?, raw}]}`；幂等键 (source_key, recordType, sourceKey)；响应 `{added, unchanged}`。
- `POST /api/v2/ops/release-batches`：body `{name, filters:{district?, source?, year?}}` → 创建 draft 批次（summary 记录筛选 + 条目数）。
- `POST /api/v2/ops/release-batches/:id/publish`：执行发布（D4）。
- `POST /api/v2/ops/release-batches/:id/rollback`：回滚。
- `GET /api/v2/ops/pipeline`：七段流水线各段计数（新 API，供 R1 图示）。
- 复用现有 `GET /api/v2/ops`、`/api/completeness`、`GET/PATCH /api/v2/ops/relations`。

### D6 /ops 页面结构

```
┌─────────────────────────────────────────────┐
│ Header（返回 + 标题 + PostgreSQL 版本）          │
├─────────────────────────────────────────────┤
│ 七段流水线图示（R1）— 横向步骤条，段间箭头，       │
│ 每段：名称+计数+状态点；断点标红                    │
├──────────────────┬──────────────────────────┤
│ 运营概览（现有）    │ 数据完备度（现有 details）    │
├──────────────────┴──────────────────────────┤
│ 候选数据管理（R3）：关系候选审核(16区筛选) +        │
│   匹配候选/冲突计数 + 冲突详情入口                 │
├─────────────────────────────────────────────┤
│ 发布批次（R4）：批次列表 + 创建向导 + 发布/回滚     │
├─────────────────────────────────────────────┤
│ 人工录入（R5）：manual 表单                      │
└─────────────────────────────────────────────┘
```

组件拆分：OpsDashboard.tsx（109 行单文件）拆为 components/ops/ 下：PipelineDiagram.tsx、CandidateReview.tsx（现审核逻辑迁移）、ReleaseBatches.tsx、ManualEntry.tsx、CompletenessPanel.tsx 保留。样式沿用现有 ops-* class（app/globals.css）。

## 兼容与回滚

- 迁移每步独立事务 + 独立回滚 SQL；school_district_relations 改名后保留同名视图一版（`CREATE VIEW school_district_relations AS SELECT * FROM relations`），验证 /db、scripts 无引用后再删。
- /map 的 school_community_candidates 消费改为 catalog.candidates 时，先验证 MapWorkspace 查询返回结构一致。
- 用户端（/schools、/map、/sources）行为不回归为验收硬条件。

## 权衡记录

- **为什么删 audit.school_community_relation_candidates**：它与 catalog.relations 重复记账且无溯源字段，审核状态已在 relations.review_status；保留双份状态源是数据不一致的温床。
- **为什么发布落 public.school_communities 而非 assignments**：用户端直接读这张表，发布即生效；代价是需去重+补索引（一次性迁移，3,479 行可控）。
- **为什么 relations 保留在 catalog 而不是 public**：它带未发布/待发布状态，属候选管理面，不应直接暴露给产品查询。

## 待用户过目的运行期产出

- assignments vs school_communities 的 diff 报告（迁移前）
- 备份表引用 grep 结果（迁移前）
