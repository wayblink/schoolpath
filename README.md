# 上海学区房数据工作台

把分散在市教委 / 各区教育局 / 各学校通告 / 链家 / 小红书的学区信息合并成一张可联动的视图。

**当前状态**: 九区产品版本。新版产品页面和 `/api/v2/*` 只展示黄浦、静安、长宁、虹口、杨浦、徐汇、闵行、浦东、普陀；当前 PostgreSQL 数据库是唯一运行数据版本，数据库快照保存在 `data/backups/current-house-20260911/`。学校、关系和政策仍按来源和审核状态持续补充，不能替代正式招生文件。

## 产品范围

产品查询层使用 canonical 区名：`黄浦`、`静安`、`长宁`、`虹口`、`杨浦`、`徐汇`、`闵行`、`浦东`、`普陀`。输入 `浦东新区`、带或不带“区”的名称会规范化，展示时使用“浦东新区”和其他“*区”形式。九区外的学校详情 ID 也会按未找到处理，不会通过详情链接绕过列表边界。

数据库只按当前版本运行，不再保留旧版兼容页面、SQLite 回迁和历史迁移工具。

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | Next.js 16 (App Router) + React 19 + TypeScript |
| 样式 | Tailwind v4 |
| 地图 | 高德地图学区边界、学校和小区视图 |
| 数据库 | PostgreSQL + Drizzle ORM |
| 数据获取 | TanStack Query |
| 状态 | Zustand |

## 快速启动

```bash
pnpm install
docker compose up -d postgres    # 启动 PostgreSQL，宿主机端口 15432
pnpm dev
```

打开 http://localhost:3000

正式数据更新直接使用当前 PostgreSQL 数据库和受审计的数据采集入口；不要运行历史 seed、迁移或重灌库流程。数据库恢复基线是 `data/backups/current-house-20260911/house-current.dump`。

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

## 数据采集配置：高德 REST Key

1. 去 https://console.amap.com/dev/key/app 申请 Web 服务 key
2. 把 key 填进 `.env.local`，仅在运行当前数据采集脚本时需要：

```bash
AMAP_REST_KEY=你的_key
```

不运行高德数据采集时无需配置该变量。

## 项目结构

```
app/
├── api/
│   ├── v2/                    # 当前产品 API
│   ├── districts/             # 地图区域边界 API
│   ├── schools/               # 地图学校 API
│   └── db/                    # 当前数据库浏览 API
├── layout.tsx                 # 根布局 + Providers
├── map/page.tsx               # 地图工作台
└── page.tsx                   # 产品首页

components/
├── Providers.tsx              # TanStack Query
├── map/                       # 高德地图工作台与图层
├── product/                   # 当前产品页面
└── db/                        # 数据库浏览组件

lib/
├── db/
│   ├── schema.ts              # Drizzle PostgreSQL schema
│   └── client.ts              # PostgreSQL 连接
├── store.ts                   # Zustand 选中状态
└── utils.ts                   # cn() 工具

data/backups/current-house-20260911/house-current.dump # 当前数据库快照
```

## 重要决策（来自 design doc）

- **形态**: Web 优先（H5 + PC 自适应），小程序作为 P1 而非 P0。研究行为需要大屏。
- **数据**: 第一版手工录入 + AI 辅助。**不爬链家房源**（法律灰区），仅提供搜索跳转链接。
- **产品范围**: 新版产品固定覆盖九区；新增区域需要先更新产品范围常量、测试和发布说明。
- **数据库**: PostgreSQL 是唯一运行数据版本，当前快照作为恢复基线保留。

## 后续工作

- [ ] 在确认数据、部署目标和回滚策略后接入线上环境

## 命令清单

```bash
pnpm dev              # 开发
pnpm build            # 生产构建
pnpm start            # 生产模式启动
pnpm lint             # ESLint
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
