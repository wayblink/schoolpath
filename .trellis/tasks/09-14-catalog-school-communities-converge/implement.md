# Implement: catalog.school_communities 表收敛与伪小区治理

## 前置检查（task.py start 前）

- [ ] prd.md 三决策（D1-D3 已并入 Decisions 节）已获用户批准
- [ ] dev 服务在跑（localhost:3000），DATABASE_URL 可用（.env.local，psql CLI 不可用，SQL 一律走 node pg 脚本）
- [ ] 迁移前基线快照：`scripts/migration/export-baseline.ts` 补新表清单（public.communities 官方系 9,377 行 + 引用 sc 11,207 行）
- [ ] 分支策略：本任务在 feat/ops-console-release-batch 之上还是新开分支——**实施前与用户确认**（当前会话在 feat/ops-console-release-batch，该分支 10 commit 未合并 main）

## 执行顺序

### 阶段 1：迁移脚本（不动 DB，仅 dry-run）

1. [ ] 写 `scripts/migration/converge-school-communities.ts`（模式照抄 converge.ts：步骤表 + 逐步事务 + rollback.sql + --apply/--from/--to + 前置校验）
2. [ ] S1-S2（entity_kind 列 + 建表）dry-run 通过
3. [ ] S3（candidates 迁移）dry-run：验证列映射、school_id 全部可 join、committee_name_raw 与 community_name_raw 差异率抽样（决定 notes 策略）
4. [ ] S4（relations 迁移）dry-run：验证 682 镜像排除条件（source_record_id < 0）、legacy_id 转换成功率（263 行）
5. [ ] S5 对账 dry-run：新表 25,834 行、来源分布、抽样 20 条交叉核验 SQL 就绪
6. [ ] S6 治理 dry-run：175 对合并映射生成（含冲突对识别）、914 个标注清单生成（按 D6-a 正则分类）
7. [ ] S7-S8 dry-run

### 阶段 2：测试先行（用户 TDD 偏好）

8. [ ] 先跑现有全量测试记录基线（91 过）
9. [ ] 更新 relations/candidates 相关的测试断言为新表结构（先改测试看失败，再改实现——重点是 release.ts、pipeline.ts 的 mock/fixture 与新列名）

### 阶段 3：DB 迁移（--apply，按窗口执行）

10. [ ] S1-S5 --apply（建表+迁移+对账）
11. [ ] S6 --apply（治理三批；S6-a 的 sc 快照先落盘再执行）
12. [ ] S7-S8 --apply（归档 rename + 终对账 + 治理报告 CSV 输出）

### 阶段 4：代码改指

13. [ ] lib/product/queries.ts：4 处线上函数改读 public + relations 函数改指新表（getRelationReviewCandidates 列名适配、reviewRelationCandidate 的 accept 前置校验语义保持）
14. [ ] lib/product/release.ts：createReleaseBatch/publishReleaseBatch/rollbackReleaseBatch 改指新表 + join 简化（D5）
15. [ ] lib/product/pipeline.ts：4 处计数改指新表（七段文案语义同步）
16. [ ] lib/ingest/xuequzhushou-import.ts：INSERT 列适配 + **幂等路径验证**（loadRecords/reconcile 在新列结构上的行为——本任务最高代码风险点，先读透再改）
17. [ ] app/api/school-community-candidates/route.ts：表探测 + 聚合加官方口径过滤
18. [ ] lib/db/explorer.ts 白名单、lib/db/schema.ts 定义与注释
19. [ ] components/ops/CandidateReview.tsx 视返回结构变化适配（优先保持前端契约）
20. [ ] scripts/verify-official-exact-community-links.ts 读表路径确认/改指

### 阶段 5：验证

21. [ ] `pnpm test` 全过（预期 ≥91）、tsc 0 error、lint 通过
22. [ ] grep 门禁：无活跃代码引用 `catalog.official_enrollment_areas` / `catalog.relations`（_archived 与迁移脚本除外）
23. [ ] 页面回归：/map（district-audit=23,070 官方口径）、/ops（流水线各段计数合理、CandidateReview 可列可审）、/schools（详情页与列表页口径一致）、发布批次页可创建
24. [ ] 回滚演练：克隆库或 dev 按 rollback.sql 全量回滚，对账恢复基线

### 阶段 6：收尾

25. [ ] commit（DB 迁移 + 代码改指可分两个 commit：先代码（含测试）后数据，或按窗口策略一个 commit——**建议一个 commit**：代码与数据强耦合，分叉状态无意义）
26. [ ] umem write-log 记录迁移全过程（基线行数、对账结果、冲突计数、抽样核验）
27. [ ] Trellis check + 归档任务

## 风险文件与回滚点

| 风险 | 位置 | 缓解 |
|---|---|---|
| importer 幂等逻辑依赖 relations 现状列结构 | lib/ingest/xuequzhushou-import.ts | 阶段 4-16 先读透 loadRecords/reconcile；幂等键在新表上的唯一索引策略（source_record_id 部分索引？） |
| S6-a 合并的 uq 冲突顺序错误 | S6-a SQL | 先删冲突行（快照）后 update；冲突计数必须进对账 |
| 代码改指窗口内服务指向老表 | 整体 | 改造窗口安排在 dev 重启时段；代码 commit 与 DB apply 间隔最小化 |
| 2,303 行 raw 行 school_id=null 的 FK/展示 | 新表 school_id 可空设计 | 已按可空设计；CandidateReview 的"未关联学校"展示路径已存在（QualityQueue 同模式） |
| 测试 fixture 深度耦合 relations 列名 | 测试文件 | 阶段 2 先改测试定位全部耦合点 |
| 分支归属 | git | 阶段 0 与用户确认分支（feat/ops-console-release-batch 未合并 main，若本任务基于它，合并顺序需排期） |

## 验证命令速查

```bash
# 迁移 dry-run
DATABASE_URL=$(node -e "...") npx tsx scripts/migration/converge-school-communities.ts
# 迁移 apply
DATABASE_URL=$(node -e "...") npx tsx scripts/migration/converge-school-communities.ts --apply
# 静态检查
pnpm test && npx tsc --noEmit && pnpm lint
# grep 门禁
grep -rn "catalog\.relations\b\|official_enrollment_areas" --include="*.ts" --include="*.tsx" app lib components scripts | grep -v "_archived\|migration/"
# 页面回归（浏览器或 curl）
curl -s localhost:3000/api/school-community-candidates | python3 -m json.tool | head -20
```
