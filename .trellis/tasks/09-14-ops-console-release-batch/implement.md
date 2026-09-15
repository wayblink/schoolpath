# 执行计划 — Ops 控制台重构与发布批次能力

> 上下文顺序：jsonl → prd.md → design.md。每步完成后跑验证命令再进下一步。

## Phase A：迁移预备与勘察确认（先做，防盲删）

- [ ] A1. `grep -rn "backup" lib app scripts components --include="*.ts" --include="*.tsx"` 确认 44 张 backup 表零引用；输出留档。
- [ ] A2. 全库结构快照：`pg_dump --schema-only` 与关键表数据导出（relations / school_communities / assignments / policies / candidates / entity_match_candidates / field_conflicts / relation_candidates）到 `data/migrations/2026-09-14-converge/`。
- [ ] A3. 生成 `school_community_assignments` vs `public.school_communities` 的 diff 报告（交集 12,860 / 仅 assignments / 仅 school_communities），写 CSV + 摘要，**交用户过目后再执行 A7 删表**。
- [ ] A4. `pg_dump` 前记录各表精确行数基线（供迁移后对账）。

## Phase B：数据库迁移（顺序敏感，每步可回滚）

- [ ] B1. 加列：`ALTER TABLE catalog.school_district_relations ADD COLUMN release_batch_id bigint`；`ALTER TABLE public.school_communities ADD COLUMN release_batch_id bigint`。
- [ ] B2. school_communities 去重：保留每组 (school_id, community_id) 的 min(id)（并列时取 verified=true 优先），删 3,479 行；验证行数 = 39,402。
- [ ] B3. `CREATE UNIQUE INDEX uq_school_communities_pair ON public.school_communities(school_id, community_id)`。
- [ ] B4. 改名：`ALTER TABLE catalog.school_district_relations RENAME TO relations`；建兼容视图 `CREATE VIEW catalog.school_district_relations AS SELECT * FROM catalog.relations`（过渡，B 阶段末删）。
- [ ] B5. audit → catalog：`ALTER TABLE audit.entity_match_candidates SET SCHEMA catalog`（field_conflicts、release_batches 同）。
- [ ] B6. 官方候选池迁入：`ALTER TABLE public.school_community_candidates SET SCHEMA catalog` + `RENAME TO candidates`。
- [ ] B7. policies 收敛：改 lib/product/queries.ts:97,114 的 policyCount 子查询读 catalog.policy_documents（`where p.public_school_id=s.id`）；验证 /schools 页 policyCount 与迁移前一致；`DROP TABLE public.policies`。
- [ ] B8. assignments 处理（依赖 A3 用户确认）：按 diff 决策补录/留档后 `DROP TABLE catalog.school_community_assignments`。
- [ ] B9. audit 收尾：核对后 `DROP TABLE audit.school_community_relation_candidates`；删除兼容视图 school_district_relations；确认零引用后 `DROP SCHEMA audit`。
- [ ] B10. 删垃圾：44 张 backup 表、school_ratings、community_price_sources（各步前再 grep 一次引用）。
- [ ] B11. 每步回滚 SQL 同步写入 `data/migrations/2026-09-14-converge/rollback.sql`。

## Phase C：API 层

- [ ] C1. `POST /api/ingest/records`（token 校验 + 幂等写入 ingest.extracted_records/sources）。
- [ ] C2. `GET /api/v2/ops/pipeline`：七段计数（overview + completeness + relations 计数 + release_batches 计数）。
- [ ] C3. `POST /api/v2/ops/release-batches`（创建 draft + summary）。
- [ ] C4. `POST /api/v2/ops/release-batches/:id/publish`（D4 事务 upsert）。
- [ ] C5. `POST /api/v2/ops/release-batches/:id/rollback`。
- [ ] C6. 现有关系审核接口的查询改读 catalog.relations / catalog.candidates（迁移后表名变更适配）。

## Phase D：/ops 页面重构

- [ ] D1. 拆 components/product/OpsDashboard.tsx → components/ops/ 多组件（PipelineDiagram / CandidateReview / ReleaseBatches / ManualEntry / CompletenessPanel）。
- [ ] D2. PipelineDiagram 组件（七段 + 计数 + 状态 + 断点标注 + 锚点滚动）。
- [ ] D3. CandidateReview：区域筛选改 16 区（PRODUCT_DISTRICTS）。
- [ ] D4. ReleaseBatches 区块：批次列表 + 创建向导（筛选条件 + 预览条目数 + 发布/回滚按钮 + 状态展示）。
- [ ] D5. ManualEntry 表单（写 web_data_source，source_type=manual）。
- [ ] D6. app/ops/page.tsx 布局重排（design D6 结构图），样式沿用/扩展 ops-* class。

## Phase E：验证（每阶段后都跑）

- [ ] E1. `pnpm lint` + `pnpm build`（Turbopack，确认无编译错误）。
- [ ] E2. 冒烟：`/ /schools /pathways /map /sources /ops /db` 全部 200；/schools 的 communityCount 与 policyCount 与迁移前基线一致。
- [ ] E3. /ops 页面 Playwright 验证：流水线渲染、16 区筛选、创建→发布→回滚批次全流程、manual 插入后 /sources 可见。
- [ ] E4. 幂等验证：固定接口重复推送 added=0；同一发布批次重复执行无重复行。
- [ ] E5. 迁移后对账：各表行数 vs A4 基线（relations 3,446、school_communities 39,402、catalog 计数不变等）。

## 风险与回滚点

- **B3 唯一索引**：去重若误删（选错保留行）影响产品展示——B2 前再跑一次 diff 确认 min(id) 策略的保留行来源分布。
- **B7 policies 切换**：policyCount 口径变化（catalog.policy_documents.public_school_id 与 public.policies.school_id 对齐）——E2 逐区核对。
- **B8 删 assignments**：24,136 行非交集数据——A3 报告 + 用户确认才执行。
- **回滚**：每 B 步有 rollback.sql；迁移全程一个 feature 分支，出问题整分支丢弃重来。

## 环境备注

- dev 服务：`pnpm dev`（http://localhost:3000，Turbopack）；遇到页面无限重载闪烁先查 dev 日志 FATAL，清 `.next` 重启（2026-09-14 已处理过一次）。
- DATABASE_URL 在 .env.local；psql CLI 不可用，用 node pg 脚本执行 SQL。
