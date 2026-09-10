# 技术设计

## 1. 设计目标与边界

本任务把“产品覆盖范围”定义为产品查询层的发布边界，而不是数据库物理边界。所有用于新版产品页面的查询在共享查询模块中应用同一个允许区域集合；数据采集、分层目录、审计和旧版兼容入口继续读取全量数据。

允许区域使用内部 canonical 名称：

```ts
const PRODUCT_DISTRICTS = [
  "黄浦",
  "静安",
  "长宁",
  "虹口",
  "杨浦",
  "徐汇",
  "闵行",
  "浦东",
  "普陀",
] as const;
```

输入区名先规范化：去掉末尾“区”，将“浦东新区”归一为“浦东”。输出继续使用现有的展示规则，即浦东显示为“浦东新区”，其他区域显示为“<区名>区”。

## 2. 产品数据边界

### 2.1 共享查询层

在 `lib/product/queries.ts` 增加产品范围常量和 SQL 参数构造辅助函数，避免每个查询重复编写不一致的区域列表。下列函数必须使用同一范围：

- `getOverview`
- `getSchools`
- `getSchoolById`
- `getSchoolDistrictSummary`
- `getSchoolDistrictRelations`
- `getSchoolDistrictRelationFacets`
- `getPathways`
- `getPolicies`

推荐使用 PostgreSQL 参数化的 `= any($n::text[])` 或等价的参数化集合，不把区域值直接拼进 SQL。详情查询必须同时带 `id` 和允许区域条件，防止通过九区外 ID 绕过列表过滤。

关系、政策等跨表统计要从 `public.schools` 的九区子集出发；没有学校外键的区级政策仍按其 canonical district 过滤。relation facets 和 pathway 的 source records 也要在查询入口过滤，不能只过滤返回的学校链接。

### 2.2 产品路由与组件

新版 API 继续调用共享查询层，避免在组件端做最终安全边界过滤。组件只负责展示允许区域的 facets：

- 学校筛选器改为九区固定列表。
- pathway 的筛选器补上普陀，并使用共享允许区域。
- district overview 使用 API 返回的九区 summary。
- 主页统计使用九区后的 overview。

旧版 `/api/*`、`/legacy`、`/ops`、`/db` 以及 `/api/v2/ops*` 不接入产品范围常量，继续保留全量行为。

### 2.3 source-schools route

`app/api/v2/source-schools/route.ts` 只重新导出 `GET`，在该文件本地声明 `runtime = "nodejs"`，或改为直接实现兼容 route，避免 Next.js 16/Turbopack 无法静态解析重新导出的 route segment config。

## 3. 质量修复

按现有 ESLint 规则修复 error：

- 将 effect 中不必要的同步 loading/view 状态更新改为事件或异步链路可推导的状态转换。
- 为 `OpsDashboard` 和脚本中的 `any` 增加最小必要的具体类型或 `unknown` 缩窄。
- 将 CommonJS `require()` 改成项目可接受的 ESM 导入方式，保持脚本运行语义。
- warning 只在不改变行为且成本合理时处理，不通过关闭规则解决问题。

## 4. CI/CD 设计

新增 GitHub Actions：

- `ci.yml`：触发 `pull_request` 和 `push` 到 `main`；使用 `pnpm-lock.yaml` 做 frozen install；启动 PostgreSQL service；执行 `pnpm lint`、`pnpm exec tsc --noEmit`、`pnpm test`、`pnpm build`。
- build 阶段提供构建所需的 `DATABASE_URL`，并确保测试所需的数据库 schema/fixture 初始化方式明确且可重复。
- `cd.yml`：触发 `push` 到 `main`，先复用 CI 等价门禁，再构建并推送带 commit SHA 和 `latest` 标签的 Docker 镜像到 GHCR；没有凭据或仓库权限时应在配置层清晰失败，不把本地镜像当成发布成功。

当前不绑定具体云主机或生产域名。镜像发布是 CD 的交付边界，线上部署由后续环境任务接入，并需要目标、凭据、健康检查和回滚策略。

## 5. 兼容、回滚与数据安全

- 不执行删除或更新其他区域数据的 SQL。
- 产品过滤是代码级可回滚变更；回滚代码即可恢复全市产品视图。
- CI/CD 文件可独立回滚，不触碰 PostgreSQL volume。
- 由于当前 `main` 尚无提交，首个基线提交前不把 Git 回滚点视为已建立；完成后应明确记录工作树状态和验证结果。

## 6. 验证策略

- 单元/路由测试覆盖：九区列表、九区外默认过滤、区名规范化、九区外详情 ID、关系/政策/路径统计不泄漏。
- 运行时 HTTP smoke 覆盖主页、学校列表、九区外学校详情、pathways、relations、policies、source-schools。
- 静态质量门禁：lint、typecheck、test、build 全通过。
- CI 配置做 YAML/脚本可执行性检查，并在可用环境中验证 PostgreSQL service 和 Docker build 输入。
