# Ops 控制台重构与发布批次能力

## Goal

把 /ops 从"只读监控板"升级为完整的数据运维控制台，并顺带完成一次数据库表结构收敛：

1. **页面**：/ops 顶部以图示呈现七段流水线（采集 → 导入 → 结构化 → 匹配 → 审核 → 发布 → 产品可见），每段显示计数与健康状态，断点有明确标注；页面重构为"流水线 + 候选管理 + 发布批次 + 人工录入"的完整控制台布局。
2. **契约**：外部采集/导入项目通过固定 HTTP 接口（`POST /api/ingest/records`，token 鉴权）推送数据进候选池，不直接落产品层——这是后续把采集/导入拆为独立闭源项目的契约边界（本次不拆仓库）。
3. **发布**：管理员在 Ops 把已审核的候选组成发布批次，幂等 upsert 到产品层 `public.school_communities`，可回滚，全程 `audit.release_batches` 记账。
4. **收敛**：audit 层合并进 catalog、三张关系表合一、policies 双写治理、44 张 backup 表清理。

## Background / Confirmed Facts

全部事实经代码与数据库勘察确认（2026-09-14）：

**数据流与分层**：ingest（原始候选池：crawl_runs 810、extracted_records 38,438、sources 2）→ catalog（来源层：source_schools 455、school_district_relations 3,446、schools 2,044、communities 30,638、policy_documents 832、school_community_assignments 36,996、aliases 473、feeder 81、ratings 0、districts 16）→ audit（审核层：entity_match_candidates 455/389 pending、field_conflicts 130 pending、school_community_relation_candidates 2,764 全 accepted、release_batches 0 行）→ public（产品层：schools 2,028、communities 31,399、school_communities 42,881、school_community_candidates 23,070、web_data_source 3,961、policies 832、district_boundaries 211）。

**收敛依据（全部有数据支撑）**：

- `audit.release_batches` 表已存在（`id, name, status, summary jsonb, created_at, published_at, rolled_back_at`）但全库 0 行、无代码引用——发布记账容器现成，缺消费方。
- **四张表记同一类"学校↔小区关系"**：`public.school_communities`（42,881，用户端 /schools、/map 读）、`public.school_community_candidates`（23,070，官方原始候选，/map MapWorkspace 实时消费，community_id 多为 null）、`catalog.school_community_assignments`（36,996，带 year 与 (school_id, community_id, year) 唯一键）、`catalog.school_district_relations`（3,446，学区助手来源层，带 source_record_id 溯源、review_status ∈ accepted/provisional、match_status ∈ raw/school_matched/community_matched/matched）。另 `audit.school_community_relation_candidates`（2,764）与 school_district_relations 重复记账（前者无溯源字段）。
- **policies 双写确认**：`public.policies`（832）与 `catalog.policy_documents`（832）按 title+source_url 100% 匹配；代码读两处——`/sources` 页 getPolicies 读 catalog.policy_documents（lib/product/queries.ts:219），`/schools` 的 policyCount 子查询读 public.policies（queries.ts:97,114）。
- **catalog ↔ public 映射健全**：catalog.schools.legacy_id → public.schools.id 映射 2,028/2,044（99%）；catalog.communities.legacy_id → public.communities.id 映射 30,638/30,638（100%）；school_communities ∩ assignments 经 public_school_id 映射后交集 12,860。
- **public.school_communities 有 3,479 行重复**（42,881 行 / 39,402 个不同 (school_id, community_id) 对，全部 n=2 的简单重复），且无 (school_id, community_id) 唯一索引——发布 upsert 前必须去重 + 补唯一索引。
- `public.school_info`（0 行）与 `catalog.school_ratings`（0 行）、`public.community_price_sources`（0 行）是空表但被 schema.ts 定义、被 MapWorkspace（school_info 的 category 标签）和 fetch-community-prices 脚本引用。
- **public schema 有 44 张 2026-06-17/18 的 backup 表**（*_backup_*），合计 128.9MB，全部 0 行——历史迁移遗留垃圾。
- 关系匹配完成度低：3,183/3,446 条 school_district_relations 的 catalog_community_id 为 null（只匹配到学校没匹配到小区）——候选管理要解决的正是这类。
- 当前 /ops 实现：`app/ops/page.tsx`（极简 shell）+ `components/product/OpsDashboard.tsx`（109 行，useEffect 拉 /api/v2/ops、/api/completeness、/api/v2/ops/relations，PATCH 审核）；关系审核 `PATCH /api/v2/ops/relations/:id` 调 lib/product/queries.ts:273 reviewRelationCandidate（事务 + FOR UPDATE + 状态机校验）。
- /ops 区域筛选硬编码 8 区（OpsDashboard.tsx:77），产品范围实际 16 区（lib/product/districts.ts）。
- 现有导入是脚本直连 pg（lib/ingest/xuequzhushou-import.ts、scripts/import-*.ts），dry-run/apply + sha256 对账，幂等靠读-比-写。

## Requirements

### R1 流水线图示（P1）

- /ops 顶部新增七段流程图：采集 collect → 导入 import → 结构化 source → 匹配 match → 审核 review → 发布 publish → 产品 visible。
- 每段卡片显示名称、当前计数（来自 /api/v2/ops overview + completeness + 新增的 pipeline stats API）、健康状态（正常/待处理/断点）。
- 明确标注两个断点：审核→发布之间（release_batches=0，本任务修好）、以及修复后若仍有未发布 accepted 关系。
- 点击某段滚动到页面中对应区块。

### R2 固定导入接口（P1）

- `POST /api/ingest/records`，请求体：`{ sourceKey, sourceName, sourceKind, records: [{ recordType, sourceKey, district?, raw }] }`，写入 `ingest.extracted_records` + 幂等登记 `ingest.sources`（按 source_key）。
- 校验：sourceKey/records 必填、raw 必须可 JSON 序列化；重复推送（相同 source + recordType + sourceKey）幂等，第二次返回 added=0。
- 鉴权：`x-ingest-token` 头匹配 env `INGEST_TOKEN`，错误/缺失返回 401。
- 接口只写 ingest 候选池，绝不写产品层——进产品必须走 R4 发布批次。

### R3 候选集管理（P1）

- /ops「候选数据管理」区块：展示候选池状态——未处理实体匹配候选（389）、字段冲突（130）、关系候选（2,764 accepted）、未发布来源层关系。
- 关系候选审核：区域筛选从硬编码 8 区改为读 PRODUCT_DISTRICTS 全 16 区；保持现有 accept/reject 行为（事务 + 状态机校验）。
- 字段冲突详情入口（可见、可查看，操作可先只读）。

### R4 批次审核发布（P1，核心）

- 模型：复用 `audit.release_batches`，status 流转 `draft → published → rolled_back`。
- 创建批次：管理员按条件（区域/来源/年份）筛选 `catalog.school_district_relations` 中 `review_status='accepted'` 的条目，组成 draft 批次，summary jsonb 记录筛选条件与条目数。
- 执行发布：事务内（a）把批次条目按 (school_id, community_id) upsert 到 `public.school_communities`（先补唯一索引、先去重 3,479 行）；（b）逐条更新来源层 `published_at=now()` 并回写 `release_batch_id`（需给 school_district_relations 加该列）；（c）批次 status=published、published_at=now()。
- 幂等：重复执行同一批次无重复行（靠唯一索引 ON CONFLICT DO NOTHING + published_at 已存在的跳过）。
- 回滚：`rolled_back` 状态 + 按 release_batch_id 删除/标记产品层条目（软删或标记，design 定）。
- /ops「发布批次」区块：批次列表（状态/条目数/时间）、创建向导（筛选 + 预览条目数 + 执行）、回滚操作。

### R5 Manual 人工编辑（P2）

- /ops「人工录入」区块：表单写 `public.web_data_source`，`source_type='manual'`、source_name 默认"人工录入"、evidence 必填。
- 字段对齐 web_data_source：关联学校（搜索 public.schools）、标题、URL、日期、证据、置信度、raw jsonb。
- 插入后 /sources 页面可见。

### R6 数据库收敛（P1，迁移）

- **audit → catalog 合并**：entity_match_candidates、field_conflicts、school_community_relation_candidates 三张表迁入 catalog（schema 改名 + 视图兼容期），代码读写方改 catalog.*；audit.release_batches 提升为 `catalog.release_batches`（或保留 audit 但立为唯一审计 schema——design 定，倾向并入 catalog 后 audit schema 只留 release 记账）。
- **四张关系表收敛为一张**：以 `catalog.school_district_relations` 为唯一来源层关系表（带溯源 + review_status + match_status）；`public.school_community_candidates`（23,070 官方原始候选，MapWorkspace 消费）作为"官方候选池"并入该表的候选态（靠 review_status 区分）或保留为独立候选池表——design 定，需保证 /map 消费不回归；`catalog.school_community_assignments`（36,996，带 year）与 public.school_communities（42,881）的产品层合并——设计定唯一产品表。
- **policies 双写治理**：定 catalog.policy_documents 为唯一真源，public.policies 改为视图或删除，queries.ts:97,114 的 policyCount 改读 catalog.policy_documents。
- **清理**：44 张 backup 表全删（128.9MB，0 行，先确认无引用）；空表 school_ratings 与 public.community_price_sources 评估删除；school_info 保留（MapWorkspace 有 category 标签引用）但标 0 行。
- 迁移必须可回滚：每步先备份 DDL/数据（迁移脚本自带 dry-run + 回滚 SQL）。

## Non-Goals（本次明确不做）

- **不实际拆分采集/导入为独立闭源项目**：本次只定契约（固定接口 + token + ingest 层边界），拆仓库是后续独立动作。
- 不重构现有 ingest 脚本（与固定接口并存，逐步迁移）。
- 不做用户端功能改动（除 R6 收敛中 /map、/schools 的查询改指向外，行为不回归）。
- 不做 RBAC/多用户（单管理员假设）。
- 不做新采集源（价格、政策自动采集等）。

## Acceptance Criteria

- [ ] /ops 顶部七段流水线图示渲染正常，各段计数与 DB 实际一致，断点有视觉标注。
- [ ] `POST /api/ingest/records`：正确 token → 写入 ingest.extracted_records；错误 token → 401；重复推送 added=0。
- [ ] 关系候选审核区域筛选覆盖 16 区；accept/reject 行为与现状一致（含事务/状态机校验）。
- [ ] 创建发布批次（draft）→ 执行发布 → public.school_communities 出现对应条目、来源层 published_at 与 release_batch_id 回写、release_batches 有 published 记录；重复执行无重复行。
- [ ] 发布后回滚，产品层对应条目按 release_batch_id 可追溯删除/标记。
- [ ] 人工插入 manual 来源信息源后，/sources 页面可见该条。
- [ ] 收敛完成：audit schema 仅存 release 记账（或并入 catalog）；四张关系表按设计收敛；policies 单一真源；44 张 backup 表删除；/schools、/map、/sources、/db 全部功能无回归（现有冒烟用例全过）。
- [ ] 迁移脚本可重复执行（幂等）且提供回滚 SQL。

## Open Questions

（已收敛至 design.md 决策清单，无阻塞性未决项）
