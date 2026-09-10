export type SchoolType = "primary" | "middle" | "nine_year";

export type CorrectionSource = {
  type: "official_school_info";
  name: string;
  title: string;
  url: string;
  date: string;
  matchedName: string;
  rawNature: string;
  rawAddress: string;
};

export type Correction = {
  id: number;
  currentName: string;
  reviewedName: string;
  district: string;
  type: SchoolType;
  address?: string;
  schoolNature?: "公立" | "私立";
  aliases: string[];
  note: string;
  source: CorrectionSource;
};

const GOV = "上海市人民政府/区教育局";

/**
 * Explicit aliases are used only when the official row is unique by district
 * and stage. The source records are kept separate so the UI can show their
 * provenance without treating a shorthand as a second school.
 */
export const CORRECTIONS: Correction[] = [
  {
    id: 4661,
    currentName: "上外嘉定外国语学校（小学部）",
    reviewedName: "上海外国语大学嘉定外国语学校（小学部）",
    district: "嘉定",
    type: "primary",
    address: "上海市嘉定区安亭镇墨玉北路888号",
    schoolNature: "公立",
    aliases: ["上外嘉定外国语学校", "上海外国语大学嘉定外国语学校"],
    note: "2025年嘉定区公办学校基本情况唯一列出上海外国语大学嘉定外国语学校，地址为安亭镇墨玉北路888号、性质为公办。当前小学部行仅缺地址且名称为简称，本次补全规范名、地址和官方别名，不改写既有梯队。",
    source: {
      type: "official_school_info",
      name: GOV,
      title: "2025年嘉定区义务教育阶段公办学校基本情况",
      url: "https://www.shanghai.gov.cn/cmsres/36/363881f703f146b6b50547142c3255e4/0e579ab9fa85681dd7fc712bc74f99a6.pdf",
      date: "2025",
      matchedName: "上海外国语大学嘉定外国语学校",
      rawNature: "公办",
      rawAddress: "上海市嘉定区安亭镇墨玉北路888号",
    },
  },
  {
    id: 5638,
    currentName: "中医晶城中学",
    reviewedName: "上海中医药大学附属闵行晶城中学",
    district: "闵行",
    type: "middle",
    address: "朱行路16号",
    schoolNature: "公立",
    aliases: ["中医晶城中学", "闵行晶城中学"],
    note: "2025年闵行区初中和一贯制学校基本情况唯一列出上海中医药大学附属闵行晶城中学，地址为朱行路16号、性质为公办。当前行是同区同学段简称且地址和性质为空，本次补全官方全称、地址、性质和别名。",
    source: {
      type: "official_school_info",
      name: GOV,
      title: "2025年闵行区义务教育阶段学校（初中和一贯制学校）教育教学、校舍场地条件、后勤设施设备和师资配置基本情况",
      url: "https://www.shanghai.gov.cn/mhqywjy/20250407/ff191ff43156426081990035cf99e39d.html",
      date: "2025-04-07",
      matchedName: "上海中医药大学附属闵行晶城中学",
      rawNature: "公办",
      rawAddress: "朱行路16号",
    },
  },
  {
    id: 5367,
    currentName: "上外松江外国语",
    reviewedName: "上海外国语大学松江外国语学校（初中部）",
    district: "松江",
    type: "middle",
    address: "松江区梅家浜路1701号",
    schoolNature: "公立",
    aliases: ["上外松江外国语", "上海外国语大学松江外国语学校"],
    note: "2025年松江区义务教育阶段学校公示唯一列出上海外国语大学松江外国语学校，标注为公办九年一贯制，地址为梅家浜路1701号。当前行是同区初中投影且地址为空；本次只补同一九年一贯制学校的初中部规范名、地址和公办性质，不据此新增或合并其他校区。",
    source: {
      type: "official_school_info",
      name: GOV,
      title: "2025年松江区义务教育阶段学校规模、招生计划、校舍场地条件、教育教学、后勤设施设备和师资配置基本情况公示",
      url: "https://www.shanghai.gov.cn/cmsres/90/901088067bed467382785e3076498c44/6a224298ebd26d6b2a03e14b75f56c5c.pdf",
      date: "2025",
      matchedName: "上海外国语大学松江外国语学校",
      rawNature: "公办九年一贯制",
      rawAddress: "松江区梅家浜路1701号",
    },
  },
  {
    id: 4652,
    currentName: "上海市新和中学",
    reviewedName: "上海市新和中学",
    district: "静安",
    type: "middle",
    aliases: ["新和中学"],
    note: "2025年静安区民办学校教育教学设施和师资配置公示表唯一列出上海市民办新和中学，地址为原平路128号。当前字段已完整，本次仅补登记官方来源，不覆盖现有名称、地址、性质或梯队。",
    source: {
      type: "official_school_info",
      name: GOV,
      title: "2025年静安区义务教育阶段民办学校教育教学设施和师资配置公示表",
      url: "https://www.shanghai.gov.cn/jaqywjy/20250407/3ba46a7afd384d72a690425b8667ddf9.html",
      date: "2025-04-07",
      matchedName: "上海市民办新和中学",
      rawNature: "",
      rawAddress: "原平路128号",
    },
  },
];

export type CurrentSchool = {
  id: number;
  name: string;
  district: string;
  type: SchoolType;
  address: string | null;
  schoolNature: "公立" | "私立" | null;
  aliases: string[] | null;
};

export type SafePatch = {
  name?: string;
  address?: string;
  schoolNature?: "公立" | "私立";
  aliases: string[];
};

function uniq(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/** Build a conservative patch; null means the row no longer matches the reviewed target. */
export function buildSafePatch(current: CurrentSchool, correction: Correction): SafePatch | null {
  if (current.id !== correction.id || current.district !== correction.district || current.type !== correction.type) {
    return null;
  }
  if (current.name !== correction.currentName && current.name !== correction.reviewedName) return null;

  const aliases = uniq([
    ...(current.aliases ?? []),
    current.name === correction.reviewedName ? "" : current.name,
    ...correction.aliases,
  ]);
  const patch: SafePatch = { aliases };
  if (current.name === correction.currentName && current.name !== correction.reviewedName) patch.name = correction.reviewedName;
  if ((!current.address || !current.address.trim()) && correction.address) patch.address = correction.address;
  if (!current.schoolNature && correction.schoolNature) patch.schoolNature = correction.schoolNature;
  return patch;
}
