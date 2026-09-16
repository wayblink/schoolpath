# schoolpath · 上海学区决策助手

把分散在市教委、各区教育局与学校通告的学区信息合并成可联动的查询视图：学校梯队与详情、小学→初中的结构化升学路径、小区对口关系、区级政策公示与学区地图。

**当前状态**：单数据库产品版本。PostgreSQL 是唯一运行数据版本，全部业务表位于 `public` schema（共 10 张）。数据由外部采集项目通过固定接口直灌，人工维护在 `/ops` 数据控制台完成，无审核层、无发布层。

## 产品范围

产品层固定覆盖九个区：`黄浦`、`静安`、`长宁`、`虹口`、`杨浦`、`徐汇`、`闵行`、`浦东`、`普陀`。输入 `浦东新区`、带或不带"区"的名称会规范化；九区外的学校按未找到处理。区域范围由 `lib/product/districts.ts` 的常量统一控制，新增区域需先改常量、测试与本文档。

## 架构与数据流

```
外部采集项目（闭源，可独立演进）
        │ POST /api/ingest/records（x-ingest-token 鉴权）
        ▼
public.school_communities（幂等直灌，ON CONFLICT DO NOTHING）
        │
        ▼
产品查询页（/schools · /pathways · /map · /sources）   ←  lib/product/queries.ts
        ▲
        │
ops 数据控制台（/ops：10 张表查看/新增/编辑/删除）       ←  lib/db/crud.ts
```

设计要点：

- **采集外部化**：爬取、解析、实体匹配在外部项目完成，本仓库只提供受鉴权的固定写入契约，采集能力不作为开源承诺
- **无审核层无发布层**：导入即线上；幂等由 `uq_school_communities_pair(school_id, community_id)` 唯一索引保证；审计靠 `source_name / source_url / source_quote / source_date` 字段可追溯
- **人工补录**：`/ops` 控制台以动态列元数据（information_schema）驱动，对全部 10 张业务表提供统一的查看、搜索、分页、新增、编辑、删除；FK 列显示关联名称，删除遇 FK 依赖时给出友好提示
- **升学路径结构化**：`public.school_pathways` 表达"小学→初中"关系（含升学方式：对口/派位/直升/部分对口），替代历史上的 `schools.feeder_middle_school` 模糊文本字段（原值保留作原始凭证）

## 页面一览

| 路径 | 用途 |
|---|---|
| `/` | 产品首页与入口 |
| `/schools` | 学校查询：学校索引（列表/详情链接）与区域概览（分区聚合）两个视图 |
| `/pathways` | 升学组合：小学→初中结构化路径，按区县与升学方式筛选 |
| `/map` | 学区地图：高德底图上的学校、小区与学区边界 |
| `/sources` | 信息源：区级政策与学校招生记录（只读浏览） |
| `/ops` | 数据控制台：概览 + 数据完备度 + 10 张业务表 CRUD |
| `/db` | 旧版数据库浏览器（SQL 执行/表数据），逐步被 /ops 取代 |

## 数据表（public schema）

| 表 | 内容 |
|---|---|
| `schools` | 学校（约 2,044 所：校名、区县、梯队、类型、坐标、来源等） |
| `communities` | 小区（约 3.1 万个：名称、区县、街道/片区、价格等） |
| `school_communities` | 学校-小区对口关系（约 3.9 万条，含来源与年份） |
| `school_pathways` | 小学→初中升学路径（363 条，含升学方式） |
| `policy_documents` | 区级政策与学校招生记录（约 832 条） |
| `web_data_source` | 信息源登记（约 3,961 条） |
| `districts` | 区县目录（16 行，canonical 名） |
| `community_price_snapshots` | 小区价格快照 |
| `community_price_sources` | 小区价格来源登记 |
| `district_boundaries` | 学区边界 GeoJSON（211 行） |

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | Next.js 16（App Router）+ React 19 + TypeScript |
| 样式 | Tailwind CSS v4（`app/globals.css` 手写组件样式） |
| 数据库 | PostgreSQL 16，`pg` 驱动裸 SQL（`lib/db/crud.ts`、`lib/product/queries.ts` 动态生成 SQL） |
| 地图 | 高德 JS API（`@amap/amap-jsapi-loader`）+ Turf |
| 客户端状态 | TanStack Query（/db）、Zustand（选中状态） |
| 图标 | lucide-react |

## 快速启动

```bash
pnpm install

# 1. 起数据库（本地已有 localhost:15432 实例可跳过）
docker compose up -d postgres

# 2. 建表（10 张 public 业务表）
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/schema.sql

# 3. 灌入当前全量业务数据（2,044 学校 / 31,399 小区 / 39,384 对口关系 / 363 升学路径 / 832 政策 / 3,961 信息源）
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f data/seed.sql

# 4. 启动
pnpm dev            # http://localhost:3000
```

- `data/seed.sql`（约 50MB）是 2026-09-16 导出的在库全量数据快照，供开发者初始化本地环境；采集更新后重新导出覆盖即可
- `psql` 需要 PostgreSQL 客户端（macOS：`brew install libpq` 或 `docker run --rm -v "$PWD:/w" -w /w postgres:16 psql ...`）
- 环境变量：复制 `.env.example` 为 `.env.local` 并填写（`.env.example` 是唯一入库的 env 模板）
- CI 不使用 seed.sql，改用 `scripts/ci-seed.sql` 合成最小种子跑门禁

## 数据导入（外部采集项目契约）

```bash
curl -X POST http://localhost:3000/api/ingest/records \
  -H "content-type: application/json" \
  -H "x-ingest-token: $INGEST_TOKEN" \
  -d '{
    "sourceKey": "official-area-ocr",
    "sourceName": "区教委官网 OCR 采集",
    "records": [{
      "recordType": "school_community",
      "sourceKey": "official-area-ocr",
      "schoolId": 1234,
      "communityId": 5678,
      "committeeName": "某小区",
      "year": 2026,
      "sourceUrl": "https://...",
      "sourceQuote": "原文摘录"
    }]
  }'
```

- `schoolId` / `communityId` 必须是已存在的 `public.schools.id` / `public.communities.id`（外部项目负责先解析，可用 `/api/v2/schools`、`/api/v2/communities` 检索）
- 幂等：重复推送同一 `(school_id, community_id)` 被唯一索引吃掉，返回 `{received, added, unchanged, skipped}`
- 未配置 `INGEST_TOKEN` 时接口返回 503（视为未启用）

## 数据恢复

恢复基线：`data/seed.sql`（入库的全量数据 SQL，见快速启动第 3 步）；更早的 custom 格式快照 `data/backups/current-schoolpath-20260911/schoolpath-current.dump`（32MB，**本地文件不纳入 git**）仅作历史保留。

```bash
# 全量恢复到临时库再按需导入（参考 scripts/migration/ 的做法）
pg_restore -d <临时库> data/backups/current-schoolpath-20260911/schoolpath-current.dump
```

`scripts/migration/` 保留三段历史迁移脚本（catalog→public 收敛、school_communities 同构合并、schema 归位）与升学路径迁移脚本，作为数据演进记录，日常不需要运行。

## 目录结构

```
app/
├── api/
│   ├── v2/              # 产品 API（schools / communities / pathways / ops / ...）
│   ├── ingest/          # 固定导入接口（records）
│   ├── districts|schools|communities  # 地图与产品辅助 API
│   ├── completeness     # 数据完备度
│   └── db/              # 旧版数据库浏览 API
├── schools/[id]/        # 学校详情
├── pathways|map|sources|ops|db/   # 产品与管理页
└── page.tsx             # 首页

components/
├── product/             # 产品页组件（学校、路径、地图、信息源、详情）
├── ops/                 # 数据控制台（OpsConsole、OpsTableExplorer、CompletenessPanel）
├── map/                 # 高德地图工作台
└── db/                  # 旧数据库浏览器组件

lib/
├── db/                  # schema.ts（类型定义）、client.ts、crud.ts（ops 全表 CRUD 引擎）
├── product/             # queries.ts（产品查询）、districts.ts（九区常量）、parse 等
├── pathways/            # feeder 文本解析（纯函数 + 单测）
├── import/push.ts       # 固定导入接口落地逻辑
└── store.ts             # Zustand

scripts/
├── migration/           # 历史迁移与升学路径迁移/AI 匹配脚本
├── fetch-* / *-collect  # 数据采集器（高德社区/价格/边界、政策、xhs 梯队）
└── audit-* / verify-*   # 数据质量审计工具

data/backups/            # 恢复基线（dump 不进 git）
tests/                   # node:test 单测与路由冒烟
```

## 质量门禁与 CI/CD

```bash
pnpm lint
pnpm exec tsc --noEmit
pnpm test                # node:test，当前 49 个用例
pnpm build
```

`.github/workflows/ci.yml` 在 PR 与 `main` 变更时用 frozen lockfile、Node 25、PostgreSQL 16 执行 lint、类型检查、测试与生产构建；`.github/workflows/cd.yml` 在 `main` 通过门禁后构建推送 GHCR 镜像（`<commit-sha>` 与 `latest` 双标签）。镜像发布是 CD 的当前边界，未绑定生产主机与回滚目标。

## 常用命令

```bash
pnpm dev                        # 开发服务器
pnpm test                       # 全量测试（需本地 dev server 或 SCHOOLPATH_TEST_BASE_URL）
pnpm lint                       # ESLint
npx tsc --noEmit                # 类型检查

# 数据维护脚本（仅本地使用）
npx tsx scripts/audit-missing-data.ts                          # 全市缺失数据审计（只读）
npx tsx scripts/audit-school-district-sources.ts               # 学校区县来源审计
npx tsx scripts/verify-official-exact-community-links.ts       # 官方口径对口关系核验
npx tsx scripts/fetch-community-prices.ts                      # 小区价格快照抓取
npx tsx scripts/backfill-school-locations-baidu-browser.ts     # 学校坐标回填
npx tsx scripts/migration/pathways-from-feeder.ts              # feeder 文本→school_pathways（幂等）
npx tsx scripts/migration/pathways-ai-match.ts                 # 简称→初中 AI 语义匹配补丁（幂等）
```

## 明确不做

- ❌ 爬取链家/贝壳房源数据（法律灰区，产品侧只提供搜索跳转链接）
- ❌ 审核队列与批次发布（2026-09 已下线：导入即线上，来源字段可追溯）
- ❌ 小程序原生版（H5 自适应即可）
- ❌ 未经范围评审把九区之外区域加入产品层
- ❌ 大文件二进制进 git（数据库 dump 与数据快照一律本地保留，见 .gitignore）

## 版本库约定

- AI agent 工具链配置（`.claude`、`.agents`、`.codex`、`.pi`、`.trellis`、`.github/skills` 等）与 `AGENTS.md` 不进版本库，仅本地保留（见 `.gitignore`）
- 数据快照（`data/audit`、`data/ingest`）、数据库 dump 与临时产物（`tmp/`、`.tmp/`）一律本地保留
- `.env.example` 是唯一入库的 env 模板；本地变量写在 `.env.local`
