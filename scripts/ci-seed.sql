-- CI 合成最小种子：替代 pg_dump 恢复基线（dump 不纳入 git，CI 自造数据跑门禁）。
-- 覆盖九区 canonical 区名、primary/middle 学校、对口关系、升学路径与政策，
-- 满足产品查询与路由冒烟测试的数据断言。本地开发请用真实恢复基线，勿运行本脚本。
-- 用法：psql "$DATABASE_URL" -f scripts/ci-seed.sql

begin;

-- 区县（canonical 九区 + 完整目录）
insert into public.districts (canonical_name, display_name) values
  ('黄浦', '黄浦区'), ('静安', '静安区'), ('长宁', '长宁区'), ('虹口', '虹口区'),
  ('杨浦', '杨浦区'), ('徐汇', '徐汇区'), ('闵行', '闵行区'), ('浦东', '浦东新区'), ('普陀', '普陀区')
on conflict (canonical_name) do nothing;

-- 学校：九区各一所一梯队小学 + 一所对口初中（含 completeness 需要的字段）
insert into public.schools (name, district, type, source_tier, address, lat, lng, area, source_name) values
  ('上海市实验小学', '黄浦', 'primary', 1, '露香园路242号', 121.48, 31.22, '老西门', 'ci-seed'),
  ('上海市黄浦学校', '黄浦', 'middle', 2, '中华路699号', 121.49, 31.21, '老西门', 'ci-seed'),
  ('静安区第一中心小学', '静安', 'primary', 1, '新闸路1449号', 121.45, 31.24, '曹家渡', 'ci-seed'),
  ('育才初级中学', '静安', 'middle', 2, '山海关路445号', 121.46, 31.25, '曹家渡', 'ci-seed'),
  ('江苏路第五小学', '长宁', 'primary', 1, '长宁路1488弄', 121.42, 31.22, '江苏路', 'ci-seed'),
  ('延安初级中学', '长宁', 'middle', 1, '延安西路601号', 121.43, 31.21, '江苏路', 'ci-seed'),
  ('虹口区第三中心小学', '虹口', 'primary', 1, '山阴路103号', 121.48, 31.27, '鲁迅公园', 'ci-seed'),
  ('虹口实验学校', '虹口', 'middle', 2, '辉河路118号', 121.47, 31.28, '凉城新村', 'ci-seed'),
  ('打虎山路第一小学', '杨浦', 'primary', 1, '打虎山路77号', 121.51, 31.28, '四平路', 'ci-seed'),
  ('昆明学校', '杨浦', 'middle', 2, '打虎山路7号', 121.51, 31.28, '四平路', 'ci-seed'),
  ('建襄小学', '徐汇', 'primary', 1, '永嘉路420号', 121.45, 31.20, '天平路', 'ci-seed'),
  ('位育初级中学', '徐汇', 'middle', 1, '复兴中路1260号', 121.44, 31.20, '天平路', 'ci-seed'),
  ('明强小学', '闵行', 'primary', 1, '七宝镇新镇路1050号', 121.35, 31.15, '七宝', 'ci-seed'),
  ('文来中学', '闵行', 'middle', 2, '七宝镇农南路66号', 121.36, 31.16, '七宝', 'ci-seed'),
  ('福山外国语小学', '浦东', 'primary', 1, '福山路150号', 121.54, 31.23, '洋泾', 'ci-seed'),
  ('建平中学西校', '浦东', 'middle', 1, '乳山路145号', 121.53, 31.24, '洋泾', 'ci-seed'),
  ('华东师范大学附属小学', '普陀', 'primary', 1, '中山北路3669号', 121.41, 31.24, '长风新村', 'ci-seed'),
  ('梅陇中学', '普陀', 'middle', 2, '丹巴路1500号', 121.40, 31.23, '长风新村', 'ci-seed');

-- 小区（两区各一个）
insert into public.communities (name, district, source_name, source_date) values
  ('露香园', '黄浦', 'ci-seed', '2026-01-01'),
  ('曹家渡花园', '静安', 'ci-seed', '2026-01-01');

-- 对口关系（学校-小区）
insert into public.school_communities (school_id, community_id, year, source_name, source_date)
select s.id, c.id, 2026, 'ci-seed', '2026-01-01'
from public.schools s, public.communities c
where s.district = c.district and s.type = 'primary'
on conflict (school_id, community_id) do nothing;

-- 升学路径（小学→初中，对口与派位各一条）
insert into public.school_pathways (primary_school_id, middle_school_id, admission_mode, raw_text, source_name)
select p.id, m.id, 'assign', 'ci-seed 对口', 'ci-seed'
from public.schools p join public.schools m on m.district = p.district and m.type = 'middle'
where p.type = 'primary'
on conflict do nothing;

-- 政策（区级 + 学校级各一条）
insert into public.policy_documents (scope, year, title, content, district_id, public_school_id)
select 'district', 2026, '黄浦区 2026 年义务教育阶段学校招生入学工作实施意见', 'CI 合成种子政策：小学实行按户籍对口入学。',
  d.id, null from public.districts d where d.canonical_name = '黄浦';
insert into public.policy_documents (scope, year, title, content, district_id, public_school_id)
select 'school', 2026, '上海市实验小学 2026 年招生通告', 'CI 合成种子政策：本校招生范围为露香园等小区。',
  null, s.id from public.schools s where s.name = '上海市实验小学';

commit;
