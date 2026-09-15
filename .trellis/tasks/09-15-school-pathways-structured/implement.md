# Implement — school_pathways 升学路径结构化

## 执行顺序

1. **建表**：执行 DDL（scripts/migration/pathways-from-feeder.ts 内置 `create table if not exists`，或独立步骤）
2. **写迁移脚本** `scripts/migration/pathways-from-feeder.ts`：
   - TDD 先行：`tests/pathways-parse.test.ts` 覆盖解析函数（清洗/分割/mode 识别/后缀匹配）——先写测试再实现
   - 脚本输出报告：matched / unmatched 计数 + unmatched 初中名清单
3. **跑迁移**：npx tsx 执行，核对 363 行（172+191）；重跑一次验证幂等
4. **抽查**：抽 20 条 matched 行核对 primary/middle 连接正确性（脚本输出或手工 SQL）
5. **改造 queries.ts**：getPathways 重写（R3）+ 学校详情页下游查询
6. **改造页面**：PathwayExplorer（R4）+ 学校详情页对口初中区
7. **ops 接入**：crud.ts OPS_TABLES + FK_DISPLAY 加 school_pathways（R5）
8. **全量验证**：tsc / lint / pnpm test；Playwright 冒烟 /pathways（筛选、标签、unmatched 展示）+ /ops 第 10 表（新增/编辑/删除一条 pathway）

## 验证命令

```bash
npx tsx scripts/migration/pathways-from-feeder.ts          # 迁移（幂等）
npx tsx scripts/migration/pathways-from-feeder.ts          # 重跑验证
npx tsc --noEmit && pnpm lint && pnpm test
node .tmp/xxx/smoke.mjs                                    # Playwright 冒烟（启动 dev 后）
```

## 风险点

- `tests/pathways-parse.test.ts` 解析单测是本任务的主要回归护栏（解析规则易错）
- 唯一约束对 NULL middle_school_id 不去重 → 依赖应用层去重 + on conflict do nothing
- 学校详情页组件（XuequReplica.tsx 或详情页）当前用 school.feederMiddleSchool 展示，改造时确保多初中列表不破坏现有布局

## 回滚点

- 每步独立可回滚：表未建→无影响；迁移跑了→`drop table school_pathways`；查询改造→git revert；页面/ops 接入→git revert
