/**
 * Normalize obvious abbreviated school names.
 *
 * Rules:
 * - move the previous short name into schools.aliases and attrs.aliases
 * - if the full-name row already exists, merge the short-name row into it
 * - migrate references before deleting a merged source row
 * - preserve merged source data and scalar-field conflicts in attrs
 *
 * Safety:
 * - dry-run by default; pass --apply to write
 * - creates full backup tables before applying
 * - writes plan/applied reports under .tmp/normalize-school-short-names/
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

const { Client } = pg;

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const now = new Date();
const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
const detectedAt = now.toISOString();
const reportDir = path.join(process.cwd(), ".tmp", "normalize-school-short-names", stamp);

type SchoolType = "primary" | "middle" | "nine_year";
type SchoolNature = "公立" | "私立" | null;
type PitRiskLevel = "low" | "medium" | "high" | "unknown" | null;

type SchoolRow = {
  id: number;
  name: string;
  aliases: string[] | null;
  district: string;
  tier: string | null;
  type: SchoolType;
  school_nature: SchoolNature;
  address: string | null;
  lat: number | null;
  lng: number | null;
  enrollment_note: string | null;
  recent_score_line: string | null;
  pit_risk_level: PitRiskLevel;
  attrs: Record<string, unknown> | null;
  website: string | null;
  student_count: number | null;
  school_scale: string | null;
  faculty: string | null;
  school_communities: number;
  policies: number;
  district_boundaries: number;
  school_info: number;
};

type RenameAction = {
  kind: "rename_to_full";
  id: number;
  to: string;
  source: string;
  reason: string;
};

type MergeAction = {
  kind: "merge_short_name_row";
  sourceId: number;
  targetId: number;
  targetName?: string;
  aliases?: string[];
  source: string;
  reason: string;
};

type Action = RenameAction | MergeAction;

const SCHOOL_FIELDS = [
  "tier",
  "school_nature",
  "address",
  "lat",
  "lng",
  "enrollment_note",
  "recent_score_line",
  "pit_risk_level",
  "website",
  "student_count",
  "school_scale",
  "faculty",
] as const;

const PLACEHOLDER_VALUES = new Set(["", "未入榜/待补充", "unknown"]);

const renameActions: RenameAction[] = [
  { kind: "rename_to_full", id: 4273, to: "上海市崇明区东门小学（江山校区）", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀并保留校区" },
  { kind: "rename_to_full", id: 4266, to: "上海市崇明区合兴小学", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀" },
  { kind: "rename_to_full", id: 4267, to: "上海市崇明区向化小学", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀" },
  { kind: "rename_to_full", id: 4279, to: "上海市崇明区圆沙小学", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀" },
  { kind: "rename_to_full", id: 4286, to: "上海市崇明区培林学校", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀" },
  { kind: "rename_to_full", id: 4276, to: "上海市崇明区堡镇小学（堡镇校区）", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀并保留校区" },
  { kind: "rename_to_full", id: 4272, to: "上海市崇明区实验小学（实验校区）", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀并保留校区" },
  { kind: "rename_to_full", id: 4277, to: "上海市崇明区平安小学", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀" },
  { kind: "rename_to_full", id: 4282, to: "上海市崇明区庙镇学校（庙镇校区）（小学）", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀并保留学段/校区" },
  { kind: "rename_to_full", id: 4261, to: "上海市崇明区建设小学", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀" },
  { kind: "rename_to_full", id: 4281, to: "上海市崇明区新海学校（小学）", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀并保留学段" },
  { kind: "rename_to_full", id: 4274, to: "上海市崇明区明珠小学", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀" },
  { kind: "rename_to_full", id: 4280, to: "上海市崇明区横沙小学", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀" },
  { kind: "rename_to_full", id: 4268, to: "上海市崇明区汲浜小学", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀" },
  { kind: "rename_to_full", id: 4260, to: "上海市崇明区海洪小学", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀" },
  { kind: "rename_to_full", id: 4263, to: "上海市崇明区竖新小学", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀" },
  { kind: "rename_to_full", id: 4262, to: "上海市崇明区竞存小学（新河校区）", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀并保留校区" },
  { kind: "rename_to_full", id: 4264, to: "上海市崇明区育才小学", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀" },
  { kind: "rename_to_full", id: 4270, to: "上海市崇明区裕安小学", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀" },
  { kind: "rename_to_full", id: 4271, to: "上海市崇明区西门小学（西门校区）", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀并保留校区" },
  { kind: "rename_to_full", id: 4278, to: "上海市崇明区长兴小学（前卫校区）", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀并修正匹配名多余括号" },
  { kind: "rename_to_full", id: 4283, to: "上海市崇明区长江学校（小学）", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀并保留学段" },
  { kind: "rename_to_full", id: 4269, to: "上海市崇明区陈家镇小学（上海市实验学校附属东滩学校集团校）", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀" },
  { kind: "rename_to_full", id: 4265, to: "上海市崇明区马桥小学", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀" },
  { kind: "rename_to_full", id: 4287, to: "上海市崇明区三星中学", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀" },
  { kind: "rename_to_full", id: 4290, to: "上海市崇明区三烈中学", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀" },
  { kind: "rename_to_full", id: 4304, to: "上海市崇明区凌云中学", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀" },
  { kind: "rename_to_full", id: 4291, to: "上海市崇明区合兴中学", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀" },
  { kind: "rename_to_full", id: 4293, to: "上海市崇明区向化中学", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀" },
  { kind: "rename_to_full", id: 4294, to: "上海市崇明区大公中学", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀" },
  { kind: "rename_to_full", id: 4289, to: "上海市崇明区大新中学", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀" },
  { kind: "rename_to_full", id: 4297, to: "上海市崇明区实验中学（西园校区）", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀并保留校区" },
  { kind: "rename_to_full", id: 4295, to: "上海市崇明区崇东中学（上海市实验学校附属东滩学校集团校）", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀" },
  { kind: "rename_to_full", id: 4288, to: "上海市崇明区建设中学", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀" },
  { kind: "rename_to_full", id: 4302, to: "上海市崇明区横沙中学", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀" },
  { kind: "rename_to_full", id: 4296, to: "上海市崇明区裕安中学", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀" },
  { kind: "rename_to_full", id: 4300, to: "上海市崇明区长兴中学", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀" },
  { kind: "rename_to_full", id: 4301, to: "上海市崇明区长明中学", source: "official_school_info_source.matched_name", reason: "官方匹配名补足区名前缀" },
  { kind: "rename_to_full", id: 5646, to: "上海市鞍山初级中学", source: "杨浦区政府公开页/地址匹配", reason: "现名仍为简称，补足上海市前缀" },
];

const mergeActions: MergeAction[] = [
  { kind: "merge_short_name_row", sourceId: 5297, targetId: 3927, source: "同区同学段既有全称行", reason: "嘉定区实验小学是上海市嘉定区实验小学简称" },
  { kind: "merge_short_name_row", sourceId: 5305, targetId: 3949, source: "同地址既有全称行", reason: "宋校嘉定实验学校补足上海市与小学部" },
  { kind: "merge_short_name_row", sourceId: 4656, targetId: 4587, source: "同区同学段既有全称行", reason: "民办嘉一联合补足上海民办嘉一联合中学" },
  { kind: "merge_short_name_row", sourceId: 5660, targetId: 3984, source: "同地址既有全称行", reason: "迎园中学补足上海市嘉定区前缀" },
  { kind: "merge_short_name_row", sourceId: 5795, targetId: 4332, source: "同地址既有全称行", reason: "江湾中心补足上海市宝山区江湾中心校" },
  { kind: "merge_short_name_row", sourceId: 5788, targetId: 4313, source: "同地址既有全称行", reason: "红星小学补足上海市宝山区前缀" },
  { kind: "merge_short_name_row", sourceId: 5786, targetId: 4311, source: "同地址既有全称行", reason: "虎林路小学补足上海市宝山区前缀" },
  { kind: "merge_short_name_row", sourceId: 4639, targetId: 4432, source: "同地址既有全称行", reason: "月浦中学补足上海市前缀" },
  { kind: "merge_short_name_row", sourceId: 4636, targetId: 4434, source: "同地址既有全称行", reason: "月浦实验补足上海市宝山区与中学部" },
  { kind: "merge_short_name_row", sourceId: 4641, targetId: 4422, source: "同地址近似既有全称行", reason: "共富实验补足上海市宝山区与中学部" },
  { kind: "merge_short_name_row", sourceId: 4637, targetId: 4435, source: "同地址既有全称行", reason: "上大附中实验学校补足上海市宝山区与中学部" },
  { kind: "merge_short_name_row", sourceId: 5541, targetId: 4292, source: "同地址既有全称行", reason: "正大中学补足上海师范大学附属崇明正大中学" },
  { kind: "merge_short_name_row", sourceId: 4594, targetId: 3495, source: "同地址既有全称行", reason: "徐汇中学补足上海市与南校区" },
  { kind: "merge_short_name_row", sourceId: 4697, targetId: 4580, source: "同地址既有全称行", reason: "位育初级中学补足上海市前缀" },
  { kind: "merge_short_name_row", sourceId: 4597, targetId: 3485, source: "同区同学段既有全称行", reason: "中国中学补足上海市前缀" },
  { kind: "merge_short_name_row", sourceId: 4592, targetId: 4568, source: "同区同学段既有全称行", reason: "西南模范补足上海市民办西南模范中学" },
  { kind: "merge_short_name_row", sourceId: 5700, targetId: 4471, source: "同地址既有全称行", reason: "朝春中心小学补足上海市普陀区前缀" },
  { kind: "merge_short_name_row", sourceId: 5706, targetId: 4473, source: "同地址既有全称行", reason: "武宁路小学补足上海市普陀区前缀" },
  { kind: "merge_short_name_row", sourceId: 5702, targetId: 4485, source: "同地址既有全称行", reason: "长征中心小学补足上海市普陀区前缀" },
  { kind: "merge_short_name_row", sourceId: 5698, targetId: 4491, source: "同地址既有全称行", reason: "金洲小学补足上海金洲小学" },
  { kind: "merge_short_name_row", sourceId: 4613, targetId: 4532, source: "同区同学段既有全称行", reason: "兰田中学补足上海市前缀" },
  { kind: "merge_short_name_row", sourceId: 4614, targetId: 4523, source: "同区同学段既有全称行", reason: "延河中学补足上海市前缀" },
  { kind: "merge_short_name_row", sourceId: 4608, targetId: 4526, source: "同区同学段既有全称行", reason: "曹杨中学补足上海市前缀" },
  { kind: "merge_short_name_row", sourceId: 5736, targetId: 4560, source: "同地址既有全称行", reason: "中原路小学按地址补足为分校全称" },
  { kind: "merge_short_name_row", sourceId: 5744, targetId: 3646, source: "同地址既有全称行", reason: "六一小学补足上海市杨浦区前缀" },
  { kind: "merge_short_name_row", sourceId: 5738, targetId: 4540, source: "同地址既有全称行", reason: "凤城新村小学补足上海市杨浦区前缀" },
  { kind: "merge_short_name_row", sourceId: 5740, targetId: 3648, source: "同地址既有全称行", reason: "回民小学补足上海市杨浦区前缀" },
  { kind: "merge_short_name_row", sourceId: 5727, targetId: 4558, source: "同地址既有全称行", reason: "杨浦小学补足上海市杨浦区前缀" },
  { kind: "merge_short_name_row", sourceId: 5729, targetId: 4553, source: "同地址既有全称行", reason: "水丰路小学按地址补足为分校全称" },
  { kind: "merge_short_name_row", sourceId: 5733, targetId: 4554, source: "同地址既有全称行", reason: "同济小学补足上海市杨浦区前缀" },
  { kind: "merge_short_name_row", sourceId: 5735, targetId: 4557, source: "同地址既有全称行", reason: "许昌路第五小学补足上海市杨浦区前缀" },
  { kind: "merge_short_name_row", sourceId: 5728, targetId: 3654, source: "同地址既有全称行", reason: "齐齐哈尔路第一小学补足上海市杨浦区前缀" },
  { kind: "merge_short_name_row", sourceId: 4664, targetId: 4569, source: "同区同学段既有全称行", reason: "兰生复旦补足上海市兰生复旦中学" },
  { kind: "merge_short_name_row", sourceId: 4670, targetId: 4588, source: "同地址既有全称行", reason: "凯慧中学补足上海市民办凯慧中学" },
  { kind: "merge_short_name_row", sourceId: 5160, targetId: 5646, targetName: "上海市鞍山初级中学", source: "杨浦区政府公开页/同地址既有行", reason: "鞍山初级补足上海市前缀" },
  { kind: "merge_short_name_row", sourceId: 4756, targetId: 3765, source: "同地址既有全称行", reason: "张江集团补足上海市张江集团中学" },
  { kind: "merge_short_name_row", sourceId: 4624, targetId: 3722, source: "同地址既有全称行", reason: "洋泾菊园按地址补足为启新路校区全称" },
  { kind: "merge_short_name_row", sourceId: 4628, targetId: 3670, source: "同地址既有全称行", reason: "浦东模范中学按博兴路地址补足为东校全称" },
  { kind: "merge_short_name_row", sourceId: 4622, targetId: 4585, source: "同区同学段既有全称行", reason: "进才外国语补足上海市进才外国语中学" },
  { kind: "merge_short_name_row", sourceId: 5117, targetId: 3633, source: "同地址既有全称行", reason: "丰镇中学补足上海市前缀" },
  { kind: "merge_short_name_row", sourceId: 5118, targetId: 3640, source: "同区同学段既有全称行", reason: "五十二中补足上海市第五十二中学" },
  { kind: "merge_short_name_row", sourceId: 5116, targetId: 3631, source: "同地址既有全称行", reason: "复兴实验补足上海市复兴实验中学" },
  { kind: "merge_short_name_row", sourceId: 4687, targetId: 4578, source: "同区同学段既有全称行", reason: "新复兴初级补足上海市新复兴初级中学" },
  { kind: "merge_short_name_row", sourceId: 5106, targetId: 4578, source: "同区同学段既有全称行", reason: "民办新复兴补足上海市新复兴初级中学" },
  { kind: "merge_short_name_row", sourceId: 5105, targetId: 4577, source: "同区同学段既有全称行", reason: "民办新华初补足上海市新华初级中学" },
  { kind: "merge_short_name_row", sourceId: 5114, targetId: 3629, source: "同地址既有全称行", reason: "江湾初级补足上海市江湾初级中学" },
  { kind: "merge_short_name_row", sourceId: 5115, targetId: 3635, source: "同区同学段既有全称行", reason: "钟山初级补足上海市钟山初级中学" },
  { kind: "merge_short_name_row", sourceId: 5689, targetId: 3513, source: "同地址既有全称行", reason: "天山第一小学补足上海市长宁区前缀" },
  { kind: "merge_short_name_row", sourceId: 5695, targetId: 3514, source: "同地址既有全称行", reason: "天山第二小学补足上海市长宁区前缀" },
  { kind: "merge_short_name_row", sourceId: 5693, targetId: 3516, source: "同地址既有全称行", reason: "长宁区威宁小学补足上海市前缀" },
  { kind: "merge_short_name_row", sourceId: 5694, targetId: 3506, source: "同地址既有全称行", reason: "长宁区开元小学补足上海市前缀" },
  { kind: "merge_short_name_row", sourceId: 5686, targetId: 3510, source: "同地址既有全称行", reason: "长宁区玉屏南路小学补足上海市前缀" },
  { kind: "merge_short_name_row", sourceId: 5683, targetId: 3499, source: "同地址既有全称行", reason: "江苏路第五小学按地址补足为昭化东路校区全称" },
  { kind: "merge_short_name_row", sourceId: 5778, targetId: 3820, source: "同区同学段既有全称行", reason: "七宝实验小学补足上海市前缀" },
  { kind: "merge_short_name_row", sourceId: 5772, targetId: 3822, source: "同地址既有全称行", reason: "平南小学按地址补足为平吉校区全称" },
  { kind: "merge_short_name_row", sourceId: 5776, targetId: 3817, source: "同地址既有全称行", reason: "明强小学按宝南路地址补足为西校区全称" },
  { kind: "merge_short_name_row", sourceId: 5771, targetId: 3834, source: "同地址既有全称行", reason: "莘庄镇小按地址补足为南校区全称" },
  { kind: "merge_short_name_row", sourceId: 5641, targetId: 3905, source: "同地址既有全称行", reason: "七宝实验补足上海市七宝实验中学" },
  { kind: "merge_short_name_row", sourceId: 5625, targetId: 3893, source: "同地址既有全称行", reason: "莘松中学按地址补足为莘松校区全称" },
  { kind: "merge_short_name_row", sourceId: 5676, targetId: 3533, source: "同地址既有全称行", reason: "万航渡路小学补足上海市静安区前缀" },
  { kind: "merge_short_name_row", sourceId: 4644, targetId: 4576, source: "同地址既有全称行", reason: "民办扬波补足上海市民办扬波中学" },
  { kind: "merge_short_name_row", sourceId: 4651, targetId: 3593, source: "同区同学段既有全称行", reason: "时代中学补足上海市前缀" },
  { kind: "merge_short_name_row", sourceId: 4653, targetId: 3572, source: "同地址既有全称行", reason: "民立中学补足上海市前缀" },
  { kind: "merge_short_name_row", sourceId: 4654, targetId: 3592, source: "同地址既有全称行", reason: "爱国学校补足上海市前缀" },
  { kind: "merge_short_name_row", sourceId: 5673, targetId: 3464, source: "同地址既有全称行", reason: "卢湾一中心补足上海市黄浦区卢湾一中心小学" },
  { kind: "merge_short_name_row", sourceId: 5669, targetId: 3451, source: "同地址既有全称行", reason: "曹光彪小学补足上海市黄浦区前缀" },
  { kind: "merge_short_name_row", sourceId: 5642, targetId: 3453, source: "既有全称行/已有别名", reason: "上海实验小学补足上海市实验小学" },
  { kind: "merge_short_name_row", sourceId: 4680, targetId: 4584, source: "同区同学段既有全称行", reason: "卢湾初级补足上海市卢湾初级中学" },
  { kind: "merge_short_name_row", sourceId: 4885, targetId: 4573, source: "同地址既有全称行", reason: "格致初级中学补足上海市前缀" },
];

const actions: Action[] = [...renameActions, ...mergeActions];

function unique(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

function nonEmpty(value: unknown) {
  if (value == null) return false;
  if (typeof value === "string") return !PLACEHOLDER_VALUES.has(value.trim());
  return true;
}

function refs(row: SchoolRow) {
  return {
    schoolCommunities: row.school_communities,
    policies: row.policies,
    districtBoundaries: row.district_boundaries,
    schoolInfo: row.school_info,
  };
}

function rowSummary(row: SchoolRow) {
  return {
    id: row.id,
    name: row.name,
    district: row.district,
    type: row.type,
    address: row.address,
    aliases: row.aliases ?? [],
    refs: refs(row),
    tier: row.tier,
    schoolNature: row.school_nature,
    dataSource: row.attrs?.data_source,
  };
}

function attrsAliases(attrs: Record<string, unknown> | null) {
  return Array.isArray(attrs?.aliases) ? attrs.aliases.map(String) : [];
}

function withAliasesAndCleanup(
  attrs: Record<string, unknown> | null,
  aliases: string[],
  cleanup: Record<string, unknown>,
) {
  const next = { ...(attrs ?? {}) };
  next.aliases = unique([...attrsAliases(attrs), ...aliases]);
  next.school_data_cleanup = [
    ...(Array.isArray(next.school_data_cleanup) ? next.school_data_cleanup : []),
    cleanup,
  ];
  return next;
}

function mergeAttrs(targetAttrs: Record<string, unknown> | null, source: SchoolRow, cleanup: Record<string, unknown>) {
  const next = withAliasesAndCleanup(targetAttrs, [source.name, ...(source.aliases ?? [])], cleanup);
  next.school_data_merged_sources = [
    ...(Array.isArray(next.school_data_merged_sources) ? next.school_data_merged_sources : []),
    {
      merged_at: detectedAt,
      source_id: source.id,
      source_name: source.name,
      source_district: source.district,
      source_type: source.type,
      source_refs: refs(source),
      source_fields: Object.fromEntries(
        SCHOOL_FIELDS.map((field) => [field, source[field]]).filter(([, value]) => nonEmpty(value)),
      ),
      source_attrs: source.attrs,
    },
  ];
  return next;
}

function buildMergedTarget(target: SchoolRow, sources: SchoolRow[], action: MergeAction) {
  const targetName = action.targetName ?? target.name;
  const merged: Record<string, unknown> = {};
  const conflicts: Array<Record<string, unknown>> = [];

  for (const field of SCHOOL_FIELDS) {
    let value: unknown = target[field];
    for (const source of sources) {
      const sourceValue = source[field];
      if (!nonEmpty(value) && nonEmpty(sourceValue)) {
        value = sourceValue;
      } else if (
        nonEmpty(value) &&
        nonEmpty(sourceValue) &&
        JSON.stringify(value) !== JSON.stringify(sourceValue) &&
        !["address", "lat", "lng"].includes(field)
      ) {
        conflicts.push({ field, target: value, sourceId: source.id, source: sourceValue });
      }
    }
    merged[field] = value;
  }

  const aliases = unique([
    ...(target.aliases ?? []),
    target.name === targetName ? null : target.name,
    ...(action.aliases ?? []),
    ...sources.flatMap((source) => [source.name, ...(source.aliases ?? [])]),
  ]).filter((alias) => alias !== targetName);

  let attrs = target.attrs;
  for (const source of sources) {
    attrs = mergeAttrs(attrs, source, {
      kind: action.kind,
      merged_source_id: source.id,
      merged_source_name: source.name,
      target_id: action.targetId,
      previous_target_name: target.name,
      new_target_name: targetName,
      source: action.source,
      reason: action.reason,
      detected_at: detectedAt,
    });
  }
  attrs = {
    ...(attrs ?? {}),
    aliases: unique([...attrsAliases(attrs), ...aliases]),
    school_data_merge_conflicts: conflicts,
  };

  return { targetName, merged, aliases, attrs, conflicts };
}

async function loadRows(client: pg.Client, ids: number[]) {
  const result = await client.query<SchoolRow>(
    `SELECT
       s.id,
       s.name,
       s.aliases,
       s.district,
       s.tier,
       s.type::text,
       s.school_nature::text,
       s.address,
       s.lat,
       s.lng,
       s.enrollment_note,
       s.recent_score_line,
       s.pit_risk_level::text,
       s.attrs,
       s.website,
       s.student_count,
       s.school_scale,
       s.faculty,
       COALESCE(sc.c, 0)::int AS school_communities,
       COALESCE(p.c, 0)::int AS policies,
       COALESCE(db.c, 0)::int AS district_boundaries,
       COALESCE(si.c, 0)::int AS school_info
     FROM schools s
     LEFT JOIN (SELECT school_id, count(*) c FROM school_communities GROUP BY school_id) sc ON sc.school_id = s.id
     LEFT JOIN (SELECT school_id, count(*) c FROM policies GROUP BY school_id) p ON p.school_id = s.id
     LEFT JOIN (SELECT school_id, count(*) c FROM district_boundaries GROUP BY school_id) db ON db.school_id = s.id
     LEFT JOIN (SELECT school_id, count(*) c FROM school_info GROUP BY school_id) si ON si.school_id = s.id
     WHERE s.id = ANY($1::int[])
     ORDER BY s.id`,
    [ids],
  );
  return new Map(result.rows.map((row) => [row.id, row]));
}

async function assertNoNameConflict(client: pg.Client, action: RenameAction, row: SchoolRow) {
  if (row.name === action.to) return;
  const conflict = await client.query(
    `SELECT id, name, district, type::text
     FROM schools
     WHERE id <> $1 AND name = $2 AND district = $3 AND type = $4::school_type`,
    [row.id, action.to, row.district, row.type],
  );
  if ((conflict.rowCount ?? 0) > 0) {
    throw new Error(`Rename conflict for ${row.id} -> ${action.to}: ${JSON.stringify(conflict.rows)}`);
  }
}

async function moveSchoolCommunities(client: pg.Client, sourceId: number, targetId: number) {
  const conflicting = await client.query(
    `DELETE FROM school_communities sc
     WHERE sc.school_id = $1
       AND EXISTS (
         SELECT 1
         FROM school_communities kept
         WHERE kept.school_id = $2
           AND kept.community_id = sc.community_id
           AND kept.year = sc.year
       )
     RETURNING id`,
    [sourceId, targetId],
  );
  const moved = await client.query(
    `UPDATE school_communities
     SET school_id = $1
     WHERE school_id = $2
     RETURNING id`,
    [targetId, sourceId],
  );
  return { moved: moved.rowCount ?? 0, deletedConflicts: conflicting.rowCount ?? 0 };
}

async function moveSimpleRef(client: pg.Client, table: string, sourceId: number, targetId: number) {
  const result = await client.query(
    `UPDATE ${table}
     SET school_id = $1
     WHERE school_id = $2
     RETURNING id`,
    [targetId, sourceId],
  );
  return result.rowCount ?? 0;
}

async function main() {
  mkdirSync(reportDir, { recursive: true });

  const ids = unique(
    actions.flatMap((action) => {
      if (action.kind === "rename_to_full") return [String(action.id)];
      return [String(action.sourceId), String(action.targetId)];
    }),
  ).map(Number);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const rowMap = await loadRows(client, ids);
    const missingIds = ids.filter((id) => !rowMap.has(id));
    if (missingIds.length > 0) throw new Error(`Missing expected school rows: ${missingIds.join(", ")}`);

    const plan = [];
    const rowsToRename = new Map<number, string>();
    for (const action of renameActions) {
      const row = rowMap.get(action.id);
      if (!row) throw new Error(`Missing rename row ${action.id}`);
      await assertNoNameConflict(client, action, row);
      rowsToRename.set(action.id, action.to);
      plan.push({
        ...action,
        from: row.name,
        row: rowSummary(row),
        aliasesToAdd: unique([...(row.aliases ?? []), row.name]).filter((alias) => alias !== action.to),
      });
    }

    for (const action of mergeActions) {
      const source = rowMap.get(action.sourceId);
      const target = rowMap.get(action.targetId);
      if (!source || !target) throw new Error(`Missing merge rows for ${action.sourceId} -> ${action.targetId}`);
      if (source.type !== target.type) throw new Error(`Refusing cross-type merge ${source.id} -> ${target.id}`);
      if (source.district !== target.district) throw new Error(`Refusing cross-district merge ${source.id} -> ${target.id}`);

      const targetName = action.targetName ?? rowsToRename.get(action.targetId) ?? target.name;
      const mergedPreview = buildMergedTarget(target, [source], { ...action, targetName });
      plan.push({
        ...action,
        targetName,
        sourceRow: rowSummary(source),
        targetRow: rowSummary(target),
        mergedPreview,
      });
    }

    writeFileSync(path.join(reportDir, "plan.json"), JSON.stringify({ apply, actions: plan }, null, 2));
    console.log(
      `Plan: rename=${renameActions.length}, merge=${mergeActions.length}, deleteAfterMerge=${mergeActions.length}. Report: ${reportDir}`,
    );
    if (!apply) return;

    const backupSchools = `schools_short_names_backup_${stamp}`;
    const backupSchoolCommunities = `school_communities_short_names_backup_${stamp}`;
    const backupPolicies = `policies_short_names_backup_${stamp}`;
    const backupDistrictBoundaries = `district_boundaries_short_names_backup_${stamp}`;
    const backupSchoolInfo = `school_info_short_names_backup_${stamp}`;

    await client.query("BEGIN");
    await client.query(`CREATE TABLE ${backupSchools} AS TABLE schools`);
    await client.query(`CREATE TABLE ${backupSchoolCommunities} AS TABLE school_communities`);
    await client.query(`CREATE TABLE ${backupPolicies} AS TABLE policies`);
    await client.query(`CREATE TABLE ${backupDistrictBoundaries} AS TABLE district_boundaries`);
    await client.query(`CREATE TABLE ${backupSchoolInfo} AS TABLE school_info`);

    const applied: Array<Record<string, unknown>> = [];

    for (const action of renameActions) {
      const row = rowMap.get(action.id);
      if (!row) throw new Error(`Missing rename row ${action.id}`);
      const aliases = unique([...(row.aliases ?? []), row.name]).filter((alias) => alias !== action.to);
      const attrs = withAliasesAndCleanup(row.attrs, aliases, {
        kind: action.kind,
        previous_name: row.name,
        new_name: action.to,
        source: action.source,
        reason: action.reason,
        detected_at: detectedAt,
      });

      await client.query(
        `UPDATE schools
         SET name = $1,
             aliases = $2::text[],
             attrs = $3::jsonb,
             updated_at = now()
         WHERE id = $4 AND name = $5`,
        [action.to, aliases, JSON.stringify(attrs), action.id, row.name],
      );
      row.name = action.to;
      row.aliases = aliases;
      row.attrs = attrs;
      applied.push({ ...action, previousName: aliases[aliases.length - 1] });
    }

    for (const action of mergeActions) {
      const source = rowMap.get(action.sourceId);
      const target = rowMap.get(action.targetId);
      if (!source || !target) throw new Error(`Missing merge rows for ${action.sourceId} -> ${action.targetId}`);
      const targetName = action.targetName ?? target.name;
      const merged = buildMergedTarget(target, [source], { ...action, targetName });

      await client.query(
        `UPDATE schools
         SET name = $1,
             tier = $2,
             school_nature = $3::school_nature,
             address = $4,
             lat = $5,
             lng = $6,
             enrollment_note = $7,
             recent_score_line = $8,
             pit_risk_level = $9::pit_risk_level,
             website = $10,
             student_count = $11,
             school_scale = $12,
             faculty = $13,
             aliases = $14::text[],
             attrs = $15::jsonb,
             updated_at = now()
         WHERE id = $16`,
        [
          merged.targetName,
          merged.merged.tier,
          merged.merged.school_nature,
          merged.merged.address,
          merged.merged.lat,
          merged.merged.lng,
          merged.merged.enrollment_note,
          merged.merged.recent_score_line,
          merged.merged.pit_risk_level,
          merged.merged.website,
          merged.merged.student_count,
          merged.merged.school_scale,
          merged.merged.faculty,
          merged.aliases,
          JSON.stringify(merged.attrs),
          action.targetId,
        ],
      );

      const refMoves = {
        schoolCommunities: await moveSchoolCommunities(client, action.sourceId, action.targetId),
        policies: await moveSimpleRef(client, "policies", action.sourceId, action.targetId),
        districtBoundaries: await moveSimpleRef(client, "district_boundaries", action.sourceId, action.targetId),
        schoolInfo: await moveSimpleRef(client, "school_info", action.sourceId, action.targetId),
      };

      const deleted = await client.query("DELETE FROM schools WHERE id = $1 RETURNING id", [action.sourceId]);
      if ((deleted.rowCount ?? 0) !== 1) throw new Error(`Expected to delete source row ${action.sourceId}`);

      target.name = merged.targetName;
      target.aliases = merged.aliases;
      target.attrs = merged.attrs;
      for (const field of SCHOOL_FIELDS) {
        (target as unknown as Record<string, unknown>)[field] = merged.merged[field];
      }
      applied.push({ ...action, targetName: merged.targetName, deletedSourceName: source.name, refMoves, conflicts: merged.conflicts });
    }

    await client.query("COMMIT");
    writeFileSync(
      path.join(reportDir, "applied.json"),
      JSON.stringify(
        {
          backups: {
            schools: backupSchools,
            schoolCommunities: backupSchoolCommunities,
            policies: backupPolicies,
            districtBoundaries: backupDistrictBoundaries,
            schoolInfo: backupSchoolInfo,
          },
          applied,
        },
        null,
        2,
      ),
    );
    console.log(`Applied ${applied.length} actions. Report: ${reportDir}`);
  } catch (error) {
    if (apply) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
