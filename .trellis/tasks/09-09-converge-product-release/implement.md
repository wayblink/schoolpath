# 实施计划

## 阶段一：建立产品范围边界

1. 在产品查询模块定义 canonical 九区常量、区名规范化函数和参数化 SQL 条件。
2. 为 overview、学校列表/详情、学校汇总、关系、facets、路径、政策查询统一接入九区条件。
3. 核对关系与政策的跨表统计，保证九区外学校、小区、关系和政策不会通过 join 或 facets 回流到新版产品。
4. 更新新版产品组件中的区域选项，移除其他区域选项并补上普陀。

回滚点：只回滚共享查询层和产品组件改动，不执行数据库数据变更。

## 阶段二：修复构建和 lint

1. 修复 `app/api/v2/source-schools/route.ts` 的 `runtime` 静态导出问题。
2. 按 lint 具体报错修复 React effect 状态更新、`any` 和 `require()`。
3. 每完成一组修复运行对应的 lint/typecheck，避免把范围过滤问题与工具链问题混在一起。

回滚点：路由导出修复与 lint 修复均为独立代码改动。

## 阶段三：测试与文档

1. 先增加失败回归测试，覆盖九区常量、输入规范化、查询 SQL 条件或运行中的 API 行为。
2. 更新现有 API 测试中依赖全市数量的断言，使其改为九区范围和非泄漏断言；保留内部全量行为测试。
3. 更新 README 的当前状态、产品覆盖区域、运行方式和 CI/CD 说明。

## 阶段四：CI/CD

1. 新增 CI workflow，固定 Node/pnpm 版本，使用 frozen lockfile 和 PostgreSQL service。
2. 确认 build 需要的环境变量和数据库初始化步骤，避免 CI 依赖开发机数据库。
3. 新增 CD workflow，构建并推送带 SHA 的 GHCR Docker 镜像；使用 GitHub Actions 内置 token，权限声明最小化。
4. 为 Docker build 保留明确的失败条件；不在没有部署目标的情况下添加 SSH 或云厂商部署脚本。

## 阶段五：验收顺序

```bash
pnpm lint
pnpm exec tsc --noEmit
pnpm test
pnpm build
```

随后在不重启无关服务的前提下，对当前运行服务做 HTTP smoke：

```bash
curl -fsS http://127.0.0.1:3000/
curl -fsS 'http://127.0.0.1:3000/api/v2/overview'
curl -fsS 'http://127.0.0.1:3000/api/v2/schools?limit=500'
curl -fsS 'http://127.0.0.1:3000/api/v2/schools?district=宝山&limit=10'
curl -fsS 'http://127.0.0.1:3000/api/v2/policies'
curl -fsS 'http://127.0.0.1:3000/api/v2/pathways?limit=20'
curl -fsS 'http://127.0.0.1:3000/api/v2/district-relations?limit=20'
curl -fsS 'http://127.0.0.1:3000/api/v2/source-schools?limit=10'
```

验收时记录：

- 质量命令结果；
- 九区响应中的 district 集合；
- 九区外详情的 HTTP/页面行为；
- 数据库其他区域行数未减少的证据；
- CI workflow 静态审查结果；
- CD 是否只完成镜像发布配置，未完成线上部署。

## 启动前检查

- [x] 用户已确认九区产品过滤边界。
- [x] 已确认 legacy、ops、db 和旧版 API 保留全量。
- [x] 已确认暂不处理权限。
- [ ] `prd.md`、`design.md`、`implement.md` 通过最终规划审阅。
- [ ] `implement.jsonl` 和 `check.jsonl` 已填入真实上下文。
- [ ] 用户明确批准本规划摘要后，执行 `task.py start`。
