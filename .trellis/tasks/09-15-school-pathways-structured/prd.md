# school_pathways 升学路径结构化

## Goal

把 `schools.feeder_middle_school` 的模糊文本（校名/派位列表/入学规则混杂在一个 text 列）迁移为结构化的 `public.school_pathways` 表，使"小学→初中"升学路径可查询、可编辑、可统计；getPathways 查询与 /pathways 页面改造为读结构化关系；新表自动接入 ops 控制台供人工补录。

## 背景（已确认事实）

- `public.schools` 共 2,044 行，其中 264 所 `type=primary` 的小学 `feeder_middle_school` 非空，内容是三类混杂文本：纯校名（"风华初级中学"）、多校派位列表（"虹桥/娄山/天山初中(派位)"）、入学规则（"户籍对口(按地段)"、"本校直升"、"田林三中(部分对口)/中国中学(部分对口)"）。
- `lib/product/queries.ts` 的 `getPathways` 用整串文本 `school.name = sp.feeder_middle_school` 做 join，带斜线/括号的行必然匹配失败——/pathways 页面展示混乱的直接原因。
- 实测解析可行性：264 所小学粗解析出 **363 条"小学→初中"边**（去括号备注后按 `/`、`、` 分割）；在 `schools(type=middle)` 精确匹配 120 条，加"中学/初级中学/学校"后缀再匹配 52 条，**自动匹配合计 172/363（47%）**；剩余 191 条为简称（"田二"、"延安初中"）、九年制直升（"本校直升"）、规则残留（"户籍对口"）等，标记 unmatched 待人工补录。

## Requirements

### R1 数据结构

- 新建 `public.school_pathways` 表：
  - `id` bigserial 主键
  - `primary_school_id` bigint NOT NULL → `schools(id)` FK
  - `middle_school_id` bigint NULL → `schools(id)` FK（unmatched 行为 NULL）
  - `admission_mode` text NOT NULL，取值：`assign`（对口）/ `placement`（派位）/ `direct`（直升）/ `partial`（部分对口）/ `unknown`（未能识别）
  - `raw_text` text NOT NULL（原始 feeder 文本留档，凭证）
  - `source_name` text（迁移脚本标记 `pathway-migration`；后续人工补录标 `manual`）
  - `created_at` / `updated_at`
  - 唯一约束 `(primary_school_id, middle_school_id, admission_mode)`，幂等重跑
- `schools.feeder_middle_school` 字段**保留**为原始凭证，不删除、不清空。

### R2 迁移脚本

- `scripts/migration/pathways-from-feeder.ts`：读 264 行 feeder 文本 → 解析 363 条边 → 匹配 schools → INSERT（`ON CONFLICT DO NOTHING` 幂等）。
- 匹配策略：精确匹配 → 加后缀（中学/初级中学/学校）匹配 → 否则 `middle_school_id=NULL` + `admission_mode` 按文本特征识别（含"直升"→direct，含"派位"→placement，含"部分对口"→partial，含"对口"→assign，其余 unknown）。
- 迁移结束输出报告：自动匹配 N 条、unmatched M 条（列出初中名清单供人工核对）。

### R3 查询改造

- `lib/product/queries.ts` 的 `getPathways` 重写：从 `school_pathways` 读，输出每条路径 `{primaryId, primaryName, primaryTier, middleId, middleName, middleTier, district, admissionMode, modeLabel}`；支持按区县、admission_mode 筛选。
- 新增/调整：按小学反查路径（学校详情页"对口初中"用）、按初中反查生源小学（初中详情页"生源小学"用，如已有则复用新查询）。

### R4 页面改造

- `components/product/PathwayExplorer.tsx`：每行一条清晰路径（小学 → 初中 + 升学方式标签 + 双方梯队），按区县/方式筛选；unmatched 行显示原文（如"田三(部分对口)/中国中学"）标注"待人工补录"。
- 学校详情页（XuequReplica 或学校详情组件）"对口初中"字段改读结构化数据，多个初中时列表展示。

### R5 ops 控制台接入

- `lib/db/crud.ts` 的 `OPS_TABLES` 增加 `school_pathways`（第 10 张表），FK_DISPLAY 增加 `primary_school_id` / `middle_school_id` → `schools.name`，人工补录 191 条 unmatched 边直接在 /ops 页面完成。

## Acceptance Criteria

- [ ] `public.school_pathways` 表存在，迁移后行数 = 172（matched）+ 191（unmatched）= 363；重跑迁移脚本幂等（行数不变）
- [ ] matched 行的 `middle_school_id` 指向真实存在的小学/初中（FK 完整性，抽查 20 条无错连）
- [ ] `getPathways` 不再引用 `feeder_middle_school` 做 join，返回每条边的 admission_mode 正确
- [ ] /pathways 页面每条路径为独立行，含升学方式标签；unmatched 行可识别；按区/方式筛选生效
- [ ] /ops 控制台左侧导航出现"升学路径"表，可新增/编辑/删除；删除小学或初中行时给出 FK 依赖保护提示
- [ ] 学校详情页对口初中信息来自 school_pathways（多个时全部展示）
- [ ] `schools.feeder_middle_school` 原值未被修改（抽查 264 行一致）
- [ ] tsc 0 error、lint 0 error、pnpm test 全绿；新增迁移脚本与查询的单测（解析逻辑、幂等性、unmatched 计数）

## Out of Scope

- 剩余 191 条 unmatched 边的**具体人工补录数据**（改造后由用户在 ops 控制台自行补录，本任务只做能力）
- 小区→学校 对口关系（school_communities，已是另一套结构化表，不动）
- /db 旧系统的任何改动

## Risks

- 解析规则误匹配：后缀匹配可能错连（如"市光学校"本身是九年制学校而非初中）——acceptance 要求抽查 20 条；误连可通过 ops 编辑修正
- feeder 文本里 55 行"户籍对口(按地段)"是规则非校名，将解析为 unmatched + admission_mode=assign，语义由 raw_text 保留
