# catalog.school_communities 表收敛与伪小区治理

## Goal

把 catalog 层两张异构的待审表——`catalog.official_enrollment_areas`（原 candidates，23,070 行，官方公示系）与 `catalog.relations`（3,446 行 = 2,764 行学区助手系 + 682 行官方镜像冗余）——合并为**一张与 `public.school_communities` 同构的 `catalog.school_communities`**，以 `source_name` 列区分来源类别；同时按分层策略治理 `public.communities` 中的官方系实体。用户价值：catalog 层从两张语义重叠、结构各异的半成品表收敛为"public 表的审核阶段映射"；产品页口径统一（详情页/列表页/总览不再一个读 catalog 一个读 public）；发布通道（待审 → release_batches → public.school_communities）数据层可通（断点修复本身不在本次范围，见 Out of Scope）。

## Confirmed Facts（2026-09-14 链路实证，详见 memory log data-pipeline 条目与 MEMORY.md）

- **粒度**：candidates 一行 = 学校 + 从公示原文切出的一个片区名（抽取期正则切分），`source_quote` 共享原文段（23,070 行 / 10,617 段 = 2.17 行/段）；relations 一行 = 学校 + 居委/地段（学区助手系）。
- **解析复杂度低**：文本 → community_id 约 120 行有效代码，纯字符串归一化 + 精确等值匹配，无模糊评分/LLM/外部服务。
- **官方实体实测构成**（9,377 个去空名官方实体，引用它们的 sc 行 11,207 条 / 全量 39,402）：8,288 个小区级合规命名（官方口径覆盖、高德未抓到的真实小区，非脏数据）；914 个混合粒度或片段（467 街道+小区混写/居委级如"江桥镇高潮村"、"雪松苑第1-3居委"；447 片段/边界如"三墩社区三墩街道1组-5组"、"佳木斯路"）；175 个与真实小区重名（127 唯一匹配 + 48 歧义）。
- **官方链 96% 主力路径**（source_name=official_school_community_candidates:official_area_level*）是"原文片段当新小区实体直插 public.communities"，脚本在 e6388af（2026-06-18 删 131 个 scripts）时丢失，不可重跑、不可审计。
- **relations 构成**：2,764 行学区助手（真 ingest 产物，仅 263 行有 catalog_community_id）+ 682 行官方镜像（source_record_id=-candidate.id，从 candidates 反向发布的纯冗余）。
- **发布通道从未执行**：release_batches 0 行、sc 全部 release_batch_id IS NULL；当前代码无人写 relations.catalog_community_id，人工审核入口（queries.ts reviewRelationCandidate）要求 accept 必须学校+小区双匹配 → 断路。
- **同构方向已被 public 表验证**：public.school_communities 共存 12 种 source_name，自带 committee_name（地点文本列）与可空 community_id。
- **代码引用面**（grep 实证）：lib/product/queries.ts 14 处、lib/product/release.ts 8 处、lib/product/pipeline.ts 4 处、lib/ingest/xuequzhushou-import.ts 4 处（relations 生产者）、app/api/school-community-candidates/route.ts 2 处、lib/db/explorer.ts 1 处白名单；ops 页 CandidateReview 经 /api/v2/ops/relations 消费。
- **产品页口径不一致现状**：详情页 /schools/[id] 与总览 DistrictOverview 展示 relationCount（读 catalog.relations 待审池），列表页 SchoolExplorer 展示 communityCount（读 public 产品层）。

## Decisions（已定，用户拍板）

1. **合并**：candidates + relations 收敛为一张 `catalog.school_communities`；682 行官方镜像排除（信息在官方系行完整存在）；来源维度用 `source_name` 维护（官方系 / 学区助手系 / 未来来源）。
2. **结构同构 public.school_communities**：列命名对齐（school_id, community_id, committee_name, year, source_name, source_url, source_quote, source_date, verified, notes, release_batch_id），另加审核流转列（review_status 等）；唯一索引 (school_id, community_id) 同 public。
3. **伪小区分层治理（Q1）**：8,288 个小区级官方实体不动（合法化 = 不加标记，entity_kind 默认值天然表达）；175 个重名精确合并（sc.community_id 改指真实实体，uq 冲突处置见 design）；914 个混合粒度/片段实体标注为"官方划片单元"（public.communities 新增 entity_kind 列，值 official_area）。治理面约 1,089 个实体，脚本化执行 + 抽样 20 条核验 + 对账报告。
4. **线上函数改读 public（Q2）**：queries.ts 4 处 relationCount 子查询（getOverview/getFullOverview/getSchools/getSchoolById）改读 `public.school_communities`，产品页口径统一为产品层。
5. **范围止于数据结构收敛（Q3）**：发布通道断点修复（审核时回填 community_id 的 UI/importer 改造）不在本次；本次只保证 release.ts 等代码跟表改名不悬空、数据层结构就位。接缝：新表 community_id 列可空 + review_status 机已就位，通道修复可直接在其上实现（建议后续任务，或并入 ops-console-release-batch）。

## Requirements

- **R1 建表迁移**：新建 `catalog.school_communities`（DDL 见 design.md D1）；candidates 全量 23,070 行 + relations 学区助手 2,764 行按列映射迁入（见 design.md D2）；迁移脚本沿用 converge.ts 模式（逐步独立事务 + rollback.sql + 行数对账基线 + --apply/--from/--to 分段）。
- **R2 status 映射**：candidates.status: pending→review_status='pending'，promoted→'published'；relations.review_status: accepted→'accepted'（provisional 的 682 行官方镜像不迁）。
- **R3 伪小区治理**：按 D3 三批执行（175 合并 / 914 标 entity_kind='official_area' / 8,288 不动），输出治理对账报告（合并映射表、冲突处置计数、抽样核验记录）。
- **R4 代码改指**：以下全部改指新表或按 D4 指定改读：lib/product/queries.ts（4 处线上函数→public；reviewRelationCandidate→新表）、lib/product/release.ts（发布批次 SQL）、lib/product/pipeline.ts（七段统计）、lib/ingest/xuequzhushou-import.ts（生产者写入）、app/api/school-community-candidates/route.ts（聚合保持官方语义，WHERE source_name LIKE 'official%'）、lib/db/explorer.ts（/db 白名单）、lib/db/schema.ts（drizzle 定义替换 officialEnrollmentAreas）、app/api/v2/ops/relations/route.ts（CandidateReview 后端）。
- **R5 老表归档**：candidates 与 relations 迁移完成后归档（rename 带 _archived 后缀或快照 CSV + DROP，design 定），归档表保留供审计（脚本已丢、数据是唯一资产）；converge.ts 等历史迁移脚本不改（篡改历史）。
- **R6 FK 一致性**：新表 community_id 指向 `public.communities`（同构 public.school_communities 的 FK 指向；relations 的 catalog_community_id 迁移时经 legacy_id 转换）；relations 现状 263 行双匹配之外的行 community_id 保持可空。

## Acceptance Criteria

- [ ] `catalog.school_communities` 存在，行数 = 23,070 + 2,764 − 合并去重差异（脚本输出精确对账，含来源分布表）
- [ ] 唯一索引 (school_id, community_id) 建成；新表 community_id 非空值全部有效（FK 通过）
- [ ] 治理后：public.communities 官方系实体中重名 175 个合并完成（冲突行处置有计数）；914 个 entity_kind='official_area'；8,288 个保持 entity_kind='community'；对账报告含抽样 20 条人工核验记录
- [ ] 全仓库 grep 无活跃代码直读 catalog.official_enrollment_areas / catalog.relations（归档/迁移脚本除外）；pipeline.ts、queries.ts、release.ts、xuequzhushou-import.ts、ops/relations API 均改指新表或 public
- [ ] pnpm test 全过、tsc 0 error、lint 通过
- [ ] 手工回归：/map 的 district-audit 计数与迁移前同口径一致（官方系候选数 23,070）；/ops 流水线各段计数合理（source 段 = 新表官方系行数）、CandidateReview 可正常列出与审核；/schools 列表与详情页口径一致
- [ ] 回滚验证：rollback.sql 可在克隆库恢复改造前状态（新表 drop、归档表还原、sc.community_id 变更前快照可回放）

## Out of Scope

- 发布通道断点修复（Q3）：审核时解析/回填 community_id 的 UI 与 importer 改造、release_batches 首次实跑——留后续任务，接缝已由 D5 就位
- 高德系（amap_placesearch_via_committee 18,554 行）直灌 public 的管道化：新表先收官方+学区助手两系
- catalog.communities 与 public.communities 双实体空间的最终统一（本次只保证新表 FK 指向 public）

## Risks

- **175 合并的 uq 冲突**：(school_id, 真实community_id) 已存在高德系 sc 行时官方行删除——需先删冲突行再 update（D3-a），冲突计数进对账报告
- **无审计的主链**：官方链脚本已丢，本次迁移的列映射只能依据列名语义 + 抽样核验，source_quote/notes 归因必须在迁移中完整保留
- **school_name_raw 丢弃**：candidates 的 school_name_raw/district 迁移后 join catalog.schools 获得，迁移脚本需验证 school_id 全部有效可 join
