# 上海学区房数据工作台

把分散在市教委 / 各区教育局 / 各学校通告 / 链家 / 小红书的学区信息合并成一张可联动的视图。

**当前状态**: 九区产品版本。新版产品页面和 `/api/v2/*` 只展示黄浦、静安、长宁、虹口、杨浦、徐汇、闵行、浦东、普陀；数据库中的其他区域数据保留，供 `/legacy`、`/ops`、`/db` 和旧版 API 的兼容、治理与审计使用。学校、关系和政策仍按来源和审核状态持续补充，不能替代正式招生文件。

## 产品范围

产品查询层使用 canonical 区名：`黄浦`、`静安`、`长宁`、`虹口`、`杨浦`、`徐汇`、`闵行`、`浦东`、`普陀`。输入 `浦东新区`、带或不带“区”的名称会规范化，展示时使用“浦东新区”和其他“*区”形式。九区外的学校详情 ID 也会按未找到处理，不会通过详情链接绕过列表边界。

数据库不会因为产品范围调整而删除九区外记录。内部数据治理入口继续保留全量视图。

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | Next.js 16 (App Router) + React 19 + TypeScript |
| 样式 | Tailwind v4 |
| 地图 | 高德地图 JS API 2.0 (`@amap/amap-jsapi-loader`) |
| 数据库 | PostgreSQL + Drizzle ORM |
| 数据获取 | TanStack Query |
| 状态 | Zustand |

## 快速启动

```bash
pnpm install
cp .env.example .env.local      # 填入高德 key（见下）
docker compose up -d postgres    # 启动 PostgreSQL，宿主机端口 15432
pnpm db:pg:init                  # 初始化 PostgreSQL schema
pnpm db:pg:import-sqlite         # 一次性从 data/house.sqlite 导入历史数据
pnpm dev
```

打开 http://localhost:3000

正式数据更新不要运行 seed/重灌库流程。`pnpm db:seed` 已被禁用，只会报错退出；补梯队、补小区、补地图边界都应该写专门的增量 SQL/脚本，并在写入前后核对行数和差异。

## Docker 部署

```bash
pnpm deploy:pg
```

`pnpm deploy:pg` 会启动 PostgreSQL，初始化空库 schema，只在目标核心表为空时从旧
SQLite 只读导入历史数据，并在启动 App 前检查核心表行数和外键是否存在 cascade delete。
如果目标库已有数据，它会跳过历史导入，避免覆盖已经恢复好的数据。

服务：

- App: http://localhost:3000
- PostgreSQL: `postgres://house:house_dev_password@localhost:15432/house`

如果本机已有 3000 端口服务，先停掉旧服务或调整 `docker-compose.yml` 里的 app 端口映射。

## 质量门禁与发布

本地质量门禁：

```bash
pnpm lint
pnpm exec tsc --noEmit
pnpm test
pnpm build
```

`.github/workflows/ci.yml` 在 pull request 和 `main` 分支变更时使用 frozen lockfile、Node 25、PostgreSQL 16，执行 lint、TypeScript 检查、测试和 production build。`.github/workflows/cd.yml` 只在 `main` 通过同等 CI 门禁后构建并推送 GHCR 镜像，发布 commit SHA 和 `latest` 两个标签。当前没有绑定生产主机、域名、部署凭据或回滚目标，因此 CD 的边界是镜像发布，不宣称已完成线上部署。

## 必备配置：高德地图 Key

1. 去 https://console.amap.com/dev/key/app 申请 Web 端 (JS API) key
2. JS API 2.0 同时需要"安全密钥 (securityJsCode)"
3. 把两个值填进 `.env.local`：

```bash
NEXT_PUBLIC_AMAP_KEY=你的_key
NEXT_PUBLIC_AMAP_SECURITY_CODE=你的_security_code
```

不填会在控制台报警告，地图不显示但表格仍可用。

## 项目结构

```
app/
├── api/
│   ├── schools/route.ts       # GET 学校列表
│   ├── districts/route.ts     # GET 学区 GeoJSON FeatureCollection
│   └── policies/route.ts      # GET 政策（按学校）
├── layout.tsx                 # 根布局 + Providers
└── page.tsx                   # 主页：左地图 + 右宽表

components/
├── Providers.tsx              # TanStack Query
├── map/AmapContainer.tsx      # 高德地图 + GeoJSON 图层 + 标记
└── table/SchoolTable.tsx      # 宽表（梯队/风险/入学/链家跳转）

lib/
├── db/
│   ├── schema.ts              # Drizzle PostgreSQL schema
│   ├── sqlite-schema.ts       # 旧 SQLite 只读迁移 schema
│   └── client.ts              # PostgreSQL 连接
├── store.ts                   # Zustand 选中状态
└── utils.ts                   # cn() 工具

data/
├── schools.json               # 学校种子数据（手工维护）
├── districts/xuhui.geojson    # 徐汇学区边界（手工维护）
└── house.sqlite               # 旧 SQLite 数据源，仅用于一次性迁移

scripts/migrate-sqlite-to-pg.ts # 从 SQLite 只读导入 PostgreSQL
scripts/seed.ts                # 破坏性历史 seed 源码存档；package 入口已禁用
drizzle.config.ts              # drizzle-kit 配置
```

## 重要决策（来自 design doc）

- **形态**: Web 优先（H5 + PC 自适应），小程序作为 P1 而非 P0。研究行为需要大屏。
- **地图**: 高德而非 MapBox。国内访问稳定，免费 100 万次/天，GeoJSON 支持好。
- **数据**: 第一版手工录入 + AI 辅助。**不爬链家房源**（法律灰区），仅提供搜索跳转链接。
- **产品范围**: 新版产品固定覆盖九区；新增区域需要先更新产品范围常量、测试和发布说明。
- **数据库**: 已从 SQLite 迁移到 PostgreSQL。SQLite 文件只作为历史导入源保留。

## 后续工作

- [ ] 持续用专门的增量脚本补充学校、关系、政策和地图数据，写入前后核对差异
- [ ] 完成移动端 H5 和地图交互验收
- [ ] 在确认数据、部署目标和回滚策略后接入线上环境

## 命令清单

```bash
pnpm dev              # 开发
pnpm build            # 生产构建
pnpm start            # 生产模式启动
pnpm lint             # ESLint
pnpm db:generate      # 改了 schema.ts 后生成迁移 SQL
pnpm db:migrate       # 应用 Drizzle 迁移
pnpm db:pg:init       # 初始化 PostgreSQL schema
pnpm db:pg:import-sqlite # 从旧 SQLite 导入到空 PostgreSQL
pnpm deploy:pg        # Docker 启动 PostgreSQL + App，并执行安全校验
pnpm db:seed          # 已禁用：直接报错，禁止重灌正式数据
pnpm db:studio        # Drizzle Studio (浏览数据)
```

## 不做（明确边界）

- ❌ 爬取链家/贝壳房源数据（法律灰区，提供跳转链接即可）
- ❌ 占坑风险数据（数据获取太难，等社区贡献）
- ❌ 自动化政策抓取（第一版人工 + AI 辅助足够；自动化等数据量起来再做）
- ❌ 未经范围评审直接把其他区域加入新版产品
- ❌ 小程序原生版（H5 内嵌即可，等 PMF 信号再投入）

## 设计文档

`~/.gstack/projects/house/wayblink-codex-using-memory-design-20260601-134445.md`

里面有 demand evidence 状态、premises、为什么选 B 而非 C、success criteria、本周作业（5 个家长访谈）等完整背景。
