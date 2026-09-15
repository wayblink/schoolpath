# Design — school_pathways 升学路径结构化

## 架构边界

- 数据层：新增 `public.school_pathways`（第 10 张表）。`schools.feeder_middle_school` 保留不动（raw 凭证）。
- 迁移层：`scripts/migration/pathways-from-feeder.ts` 一次性脚本，幂等可重跑。
- 查询层：`lib/product/queries.ts` getPathways 重写；schema.ts 增加 drizzle 定义（如需走 db 客户端）或继续裸 SQL（与现有风格一致——现有 queries.ts 用裸 SQL + query() helper，本任务跟随该风格）。
- 页面层：PathwayExplorer 改造；学校详情页对口初中区改造。
- 运维层：ops 控制台 OPS_TABLES 加一行。

## 表结构（DDL 草案）

```sql
create table if not exists public.school_pathways (
  id bigserial primary key,
  primary_school_id bigint not null references public.schools(id),
  middle_school_id bigint references public.schools(id),
  admission_mode text not null check (admission_mode in ('assign','placement','direct','partial','unknown')),
  raw_text text not null,
  source_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (primary_school_id, middle_school_id, admission_mode)
);
```

注意：唯一约束含 `middle_school_id`，NULL 时 PG 唯一约束不去重（NULL distinct）——unmatched 行重跑会产生重复。处理：迁移脚本在应用层去重（同 primary+同 raw_text 只插一次），或 unique 用 `coalesce(middle_school_id, -id)` 变通。选应用层去重 + 冲突时 DO NOTHING，简单可靠。

## 解析算法（迁移脚本）

输入：`select id, name, district, feeder_middle_school from schools where type='primary' and feeder_middle_school is not null and trim(feeder_middle_school) <> ''`（264 行）

1. 清洗：去掉全角/半角括号备注 `（…）` `(…)`；去掉"(按地段)"等规则尾注
2. 分割：按 `/`、`、` 切分为候选初中名列表
3. admission_mode 识别（按整行原始文本，非单个候选名）：
   - 含"直升" → direct
   - 含"派位" → placement
   - 含"部分对口" → partial
   - 含"对口" → assign
   - 其余 → unknown
4. 候选名匹配 schools(type=middle)：
   - 精确 `name = 候选`
   - 后缀匹配 `name = 候选 || '中学'`、`'初级中学'`、`'学校'`
   - 命中 → middle_school_id；未命中 → NULL（unmatched）
5. 插入：每 (primary, 候选解析出的 middle 或 NULL, mode, raw_text) 一行；`on conflict do nothing`

预期产出：363 行（172 matched + 191 unmatched）。

## 查询设计（getPathways 重写）

```sql
select sp.primary_school_id, p.name as primary_name, p.source_tier as primary_tier,
       sp.middle_school_id, m.name as middle_name, m.source_tier as middle_tier,
       <district expr> as district, sp.admission_mode
from public.school_pathways sp
join public.schools p on p.id = sp.primary_school_id
left join public.schools m on m.id = sp.middle_school_id
where <district filter> [and sp.admission_mode = any($n)]
order by <district>, p.source_tier nulls last, p.name
limit $limit
```

- mode 标签映射：assign→对口、placement→派位、direct→直升、partial→部分对口、unknown→待识别
- 学校详情页：`getSchoolPathways(schoolId)` 查 primary 或 middle 两条路（一个小学 id 查下游初中；一个初中 id 查上游小学）

## 兼容与回滚

- 新增表 + 新查询，旧字段保留 → 无破坏性变更，回滚 = 删表 + queries.ts 还原（git）
- 迁移脚本幂等（on conflict do nothing + 应用层去重）

## 取舍记录

- 用裸 SQL 而非 drizzle 建表：项目 migration 脚本全部裸 SQL（converge 系列先例），schema.ts 不加 drizzle 表定义（OPS_TABLES 的 crud.ts 用 information_schema 动态元数据，不需要 drizzle 定义）
- unmatched 行保留 raw_text：人工补录时 ops 表单可见原文，逐条修
