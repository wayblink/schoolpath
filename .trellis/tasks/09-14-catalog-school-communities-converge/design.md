# Design: catalog.school_communities 表收敛与伪小区治理

## D1 新表结构（catalog.school_communities）

设计原则：**共享列与 public.school_communities 同名同义（同构映射）**，审核原料属性作为额外科保留（待审态比产品态多几列是合理的）。school_id/community_id 均可空（待审池允许未匹配学校和未解析小区；PG 唯一索引天然允许 NULL 多行）。

```sql
create table catalog.school_communities (
  id serial primary key,
  school_id int references catalog.schools(id),        -- 可空：raw 行未匹配学校（2,303 行）
  school_name_raw text,                                -- 未匹配学校的公示原文名（审核原料）
  district text,                                       -- 区县（CandidateReview 按区筛选依赖）
  community_id int references public.communities(id),  -- 可空：解析回填；直指 public 实体空间
  committee_name text,                                 -- 地点原文：居委/片区/小区名
  year int,
  source_name text not null,                           -- 来源类别：official_*（官方系）/ 学区助手 / 未来来源
  source_record_id bigint,                             -- ingest 溯源（学区助手系；官方系 null）
  source_url text,
  source_quote text,                                   -- 官方公示原文摘录
  source_date text,
  confidence text,                                     -- high/medium/low（官方系；其余 null）
  review_status text not null default 'pending',       -- pending/accepted/rejected/published
  verified boolean not null default false,
  notes text,
  release_batch_id bigint,                             -- 发布批次归属（现状全 null）
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index uq_catalog_school_communities_pair on catalog.school_communities(school_id, community_id);
```

与 public.school_communities 的列对照：school_id / community_id / committee_name / year / source_name / source_url / source_quote / source_date / verified / notes / release_batch_id 同名同义；public 无的额外科为审核原料（school_name_raw, district, source_record_id, confidence, review_status）。**community_id 指向 public.communities**（区别于 relations 的 catalog_community_id→catalog.communities，迁移时经 legacy_id 转换；发布链路 join 因此简化，见 D5）。

review_status 枚举与映射：

| 源 | 值 | 行数 | → 新表 review_status | 理由 |
|---|---|---|---|---|
| candidates.status | pending | 9,027 | pending | 待审 |
| candidates.status | promoted | 14,043 | published | 已产生 sc 行 = 已进产品层 |
| relations.review_status | accepted | 2,764 | accepted | 已审核接受、待发布 |
| relations.review_status | provisional | 682 | **不迁** | 官方镜像冗余，信息在官方系行完整存在 |

（relations 实际 review_status 分布以迁移前查询为准；出现 accepted/provisional 之外的值时逐值决策并在对账报告记录。）

## D2 列映射（candidates / relations → 新表）

**candidates（official_enrollment_areas，23,070 行全量迁入）**：

| candidates 列 | → 新表列 | 说明 |
|---|---|---|
| school_id | school_id | 迁移前验证全部非空可 join catalog.schools（candidates 无 raw 行） |
| school_name_raw | school_name_raw | 保留（公示原文校名，与 catalog.schools 现行名可能有差异） |
| district | district | 保留 |
| community_id | community_id | 直指 public.communities（798 行非空为官方实体 id，R3 治理会改指部分） |
| community_name_raw | committee_name | 主体地点文本 |
| committee_name_raw | notes | 与 community_name_raw 有差异时进 notes（抽样核验差异率后定是否合并丢弃） |
| year | year | 直传 |
| status | review_status | 按 D1 映射表 |
| confidence | confidence | 直传 |
| source_url / source_date / source_quote | 同名 | 直传 |
| source_title | notes | 官方文件标题，拼入 notes |
| review_notes | notes | 追加到 notes |
| raw | 丢弃 | 抽取过程数据；原文已由 source_quote 保留 |
| created_at / updated_at | 同名 | 保留原时间戳 |

**relations（仅 2,764 行学区助手系迁入；source_record_id 为负数的 682 行官方镜像排除）**：

| relations 列 | → 新表列 | 说明 |
|---|---|---|
| school_id | school_id | 可空（2,303 raw 行为 null） |
| school_name | school_name_raw | 原文校名 |
| district | district | 保留 |
| catalog_community_id | community_id | **经 catalog.communities.legacy_id → public.communities.id 转换**（263 行非空；转换失败的置 null 并计数进对账） |
| committee_name | committee_name | 主体地点文本 |
| area / street | notes | 学校片区/街道归属，拼入 notes（描述学校而非关系，且 raw 行唯一保留途径） |
| source_year | year | 直传 |
| source_name | source_name | 直传（值"学区助手"） |
| source_record_id | source_record_id | ingest 溯源键，保留 |
| source_url | source_url | 直传 |
| source_quote | source_quote | relations 无此列 → null |
| source_date | source_date | relations 无此列 → null |
| review_status | review_status | 按 D1 映射表 |
| verified | verified | 直传 |
| match_status / school_match_score / community_match_score | 丢弃 | 临时匹配状态，review_status 已取代；审计靠归档表 |
| school_type | notes | 拼入 notes（学校属性，raw 行识别用） |
| attrs | 丢弃 | 溯源信息由 source_record_id 覆盖 |
| published_at | 丢弃 | 发布归属由 release_batch_id 表达 |
| release_batch_id | release_batch_id | 直传（现状全 null） |

## D3 迁移与治理执行顺序（脚本 scripts/migration/converge-school-communities.ts）

沿用 converge.ts 模式：每步独立事务、--apply 执行、rollback.sql 随执行写入、行数对账前置校验。步骤：

| 步 | 动作 | 前置校验 | 回滚 |
|---|---|---|---|
| S1 | `alter table public.communities add column entity_kind text not null default 'community'` | 列不存在 | drop column |
| S2 | 建 catalog.school_communities（DDL 见 D1）+ 唯一索引 | 表不存在 | drop table |
| S3 | 迁 candidates 全量（列映射 D2-candidates） | candidates 行数 = 23,070；新表官方系行数校验；school_id 全部可 join | delete from 新表 where source_name like 'official%' |
| S4 | 迁 relations 学区助手系（排除 source_record_id < 0） | relations 总行 3,446；迁入 2,764；legacy_id 转换失败计数 = 预期 | delete from 新表 where source_name = '学区助手' |
| S5 | 对账：新表行数 = 25,834；来源分布表；抽样 20 条三源交叉核验 | 与预期不符即停 | — |
| S6-a | **重名合并（175 对）**：先删 uq 冲突官方 sc 行（快照）→ update sc.community_id → 真实 id → 删伪实体 | 合并对数 = 175；冲突行数进报告 | 从快照恢复 sc 行 + 恢复伪实体 |
| S6-b | **混合粒度标注（914 个）**：按正则分类（街道+小区混写/居委级 467 + 片段/边界 447）update entity_kind='official_area' | 标注数 = 914 | update 回 'community' |
| S6-c | **8,288 个不动**：entity_kind 默认 'community' 天然合法化 | 计数核验 | — |
| S7 | 归档：`alter table catalog.official_enrollment_areas rename to official_enrollment_areas_archived`；`catalog.relations rename to relations_archived` | 迁移对账全过 | rename 还原 |
| S8 | 终对账 + 治理报告输出（合并映射表 CSV、冲突计数、抽样核验记录） | — | — |

S6-a 冲突处置细节：官方行 (school_id, pseudo_id) 合并为 (school_id, real_id) 时若真实行已存在，**删官方行**（真实行已表达同一关系，来源信息归档在 sc.notes/归档表）；先 delete 后 update 避免 uq 违反。

## D4 代码改指清单

| 文件 | 改动 | 类型 |
|---|---|---|
| lib/product/queries.ts | 4 处线上函数 relationCount 子查询改读 `public.school_communities`（getOverview/getFullOverview/getSchools/getSchoolById）；relations 相关函数（getRelationReviewCandidates/reviewRelationCandidate/listMatchCandidates 中引用 relations 的部分）改读新表，列名适配（catalog_community_id→community_id 等） | 读改指 |
| lib/product/release.ts | createReleaseBatch 从新表读 accepted；publishReleaseBatch 的 join **简化**：relations.catalog_community_id→catalog.communities→legacy_id→public 的双跳 join 变为新表 community_id 直 join public.communities；rollback 按 release_batch_id 不变 | 读改指+简化 |
| lib/product/pipeline.ts | 4 处 relations 计数改读新表（review_status 过滤值适配：accepted→accepted，provisional→pending 语义变化需同步七段文案） | 读改指 |
| lib/ingest/xuequzhushou-import.ts | INSERT 列适配新表（丢弃列见 D2；school_id/school_name_raw/district/committee_name/review_status/source_record_id/source_url/year/verified 保留）。**幂等键分析是风险点**：现有 insert 无 ON CONFLICT，幂等靠前置 reconcile——改造后幂等路径需在新列结构上验证（implement 阶段细查 loadRecords/reconcile 逻辑） | 生产者改造 |
| app/api/school-community-candidates/route.ts | to_regclass 探测 + FROM 改新表；聚合加 `where source_name like 'official%'`（/map 展示官方候选口径，学区助手行进表后不应混入该统计） | 读改指+口径 |
| app/api/v2/ops/relations/route.ts | **不改**（后端 getRelationReviewCandidates 在 queries.ts 内改指） | — |
| lib/db/explorer.ts | /db 白名单 catalog 集合：relations/official_enrollment_areas → school_communities | 白名单 |
| lib/db/schema.ts | officialEnrollmentAreas 定义替换为 catalogSchoolCommunities（drizzle 定义与裸 SQL 并存，定义保持同步）；注释更新 | 定义 |
| components/ops/CandidateReview.tsx | 视 queries.ts 返回结构变化决定是否适配（district 筛选/列展示），优先保持前端契约不变 | 视情况 |
| scripts/verify-official-exact-community-links.ts | 读 relations 的部分改指新表（该脚本当前读 relations？grep 未见直接引用——implement 时确认其读表路径） | 视情况 |

## D5 发布通道接缝（Q3：断点修复不在本次，但结构就位）

release.ts 的发布 SQL 改造后形态：

```sql
-- 改造前（双跳 join）
join catalog.communities cc on cc.id = r.catalog_community_id
join public.communities pc on pc.id = cc.legacy_id
-- 改造后（一跳，community_id 直指 public）
join public.communities pc on pc.id = r.community_id
```

断点本身（无人写 community_id、人工审核入口要求双匹配、publishable 过滤）**原样保留**——本次只保证代码跟表走不悬空。后续通道修复（审核时回填 community_id 的 UI/importer）直接在新表结构上实现：community_id 列已就位、review_status 机已就位、（school_id, community_id）唯一索引与 public 一致。

## D6 回滚设计

- **数据层**：rollback.sql 按 S1→S8 逆序（rename 还原 → sc.community_id 快照回放 → 伪实体恢复 → delete 迁移行 → drop 新表 → drop entity_kind 列）。S6-a 的 sc 行删除/update 前必须快照（CSV）。
- **代码层**：代码改指一个独立 commit，回滚 = git revert；数据库回滚后代码改指必须同步 revert（顺序：先 revert 代码再回滚 DB，或反之——DB 回滚后老表名回来，旧代码指向老表可正常运行）。
- **顺序约束**：DB 迁移与代码改指之间有时间窗（代码改指 commit 前 DB 必须已迁移），该窗口内线上服务指向老表——改造窗口安排在服务重启/低峰期，dev 环境先行。

## D7 验证方案

1. **脚本自校验**：每步前置行数校验不符即停；S5 对账输出来源分布 + 抽样 20 条人工核验记录。
2. **静态**：tsc 0 error、lint 通过、pnpm test 全过（91+ 测试；relations 相关 mock/断言按新表适配）。
3. **grep 门禁**：全仓库无活跃代码引用 catalog.official_enrollment_areas / catalog.relations（归档脚本/迁移脚本/_archived 除外）。
4. **页面手工回归**：/map district-audit 计数 = 23,070（官方口径）；/ops 流水线 source 段 = 新表官方系行数、CandidateReview 列出可审；/schools 详情页 relationCount 与列表页 communityCount 口径一致（同读 public）；发布批次页可创建（dry 状态）。
5. **回滚演练**：克隆库（或 dev）按 rollback.sql 全量回滚 + 对账恢复基线。
