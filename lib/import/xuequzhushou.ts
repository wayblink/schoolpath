import { createHash } from "node:crypto";
import vm from "node:vm";

export type SourceSchool = {
  名称: string;
  梯队?: number;
  片区?: string;
  街道?: string;
  对口初中?: string;
  初中梯队?: number;
  对口居委?: string | string[];
  评价?: string;
  入学方式?: string;
  招生班级?: number;
  标签?: string[];
  lng?: number;
  lat?: number;
};

export type SourceDistrict = {
  区: string;
  入学制度: string;
  说明: string;
  街道?: string[];
  小学?: SourceSchool[];
  初中?: SourceSchool[];
};

export type ParsedXuequzhushou = {
  sourceUrl: string;
  contentHash: string;
  pageTitle: string;
  districts: Record<string, SourceDistrict>;
  districtOrder: string[];
  committeeOverlap: Record<string, unknown>;
  middleSchoolOverlap: Record<string, unknown>;
  stats: {
    districtCount: number;
    primarySchoolCount: number;
    middleSchoolCount: number;
    streetCount: number;
    committeeRelationCount: number;
    coordinateCount: number;
    taggedSchoolCount: number;
  };
};

export type SourceCommitteeRelation = {
  sourceKey: string;
  district: string;
  schoolName: string;
  schoolType: "primary";
  committeeName: string;
  area?: string;
  street?: string;
};

export function normalizeSchoolName(name: string): string {
  return name
    .normalize("NFKC")
    .replace(/[·•・\s]/g, "")
    .replace(/[()（）]([^()（）]*校区)[()（）]/g, "$1")
    .replace(/校区/g, "")
    .replace(/[()（）\-—_]/g, "")
    .trim();
}

export function schoolNameSimilarity(sourceName: string, catalogName: string): number {
  const source = normalizeSchoolName(sourceName);
  const catalog = normalizeSchoolName(catalogName);
  if (source === catalog) return 1;
  if (!source || !catalog) return 0;
  if (source.includes(catalog) || catalog.includes(source)) {
    return Math.min(source.length, catalog.length) / Math.max(source.length, catalog.length);
  }
  const sourceChars = new Set(source);
  const shared = [...new Set(catalog)].filter((char) => sourceChars.has(char)).length;
  return shared / Math.max(sourceChars.size, new Set(catalog).size);
}

export function isSafeSchoolMatch(score: number): boolean {
  return score === 1;
}

export function extractCommitteeRelations(parsed: ParsedXuequzhushou): SourceCommitteeRelation[] {
  const relations: SourceCommitteeRelation[] = [];
  for (const districtName of parsed.districtOrder) {
    for (const school of parsed.districts[districtName]?.小学 ?? []) {
      const committees = Array.isArray(school.对口居委)
        ? school.对口居委
        : school.对口居委
          ? [school.对口居委]
          : [];
      committees.forEach((committeeName, index) => {
        relations.push({
          sourceKey: `${districtName}:primary:${school.名称}:committee:${index}:${committeeName}`,
          district: districtName,
          schoolName: school.名称,
          schoolType: "primary",
          committeeName,
          area: school.片区,
          street: school.街道,
        });
      });
    }
  }
  return relations;
}

const START_MARKER = "var ALL_DATA = ";
const END_MARKER = "\nvar TLB=";

export function parseXuequzhushouHtml(
  html: string,
  sourceUrl = "https://xuequzhushou.cn/",
): ParsedXuequzhushou {
  const start = html.indexOf(START_MARKER);
  const end = html.indexOf(END_MARKER, start);
  if (start < 0 || end < 0) throw new Error("xuequzhushou embedded data block was not found");

  const context: Record<string, unknown> = {};
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context, { timeout: 2_000 });

  const districts = context.ALL_DATA as Record<string, SourceDistrict> | undefined;
  if (!districts || typeof districts !== "object") throw new Error("ALL_DATA is invalid");
  const districtOrder = Array.isArray(context.DISTRICTS)
    ? Array.from(context.DISTRICTS as string[])
    : Object.keys(districts);

  let primarySchoolCount = 0;
  let middleSchoolCount = 0;
  let streetCount = 0;
  let committeeRelationCount = 0;
  let coordinateCount = 0;
  let taggedSchoolCount = 0;

  for (const district of Object.values(districts)) {
    streetCount += district.街道?.length ?? 0;
    for (const school of district.小学 ?? []) {
      primarySchoolCount += 1;
      const committees = school.对口居委;
      committeeRelationCount += Array.isArray(committees) ? committees.length : committees ? 1 : 0;
      if (school.lng != null && school.lat != null) coordinateCount += 1;
      if (school.标签?.length) taggedSchoolCount += 1;
    }
    for (const school of district.初中 ?? []) {
      middleSchoolCount += 1;
      if (school.lng != null && school.lat != null) coordinateCount += 1;
    }
  }

  return {
    sourceUrl,
    contentHash: createHash("sha256").update(html).digest("hex"),
    pageTitle: html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim() ?? "",
    districts,
    districtOrder,
    committeeOverlap: JSON.parse(JSON.stringify(context.JUWOVERLAP ?? {})),
    middleSchoolOverlap: JSON.parse(JSON.stringify(context.JUWOVERLAP_MS ?? {})),
    stats: {
      districtCount: Object.keys(districts).length,
      primarySchoolCount,
      middleSchoolCount,
      streetCount,
      committeeRelationCount,
      coordinateCount,
      taggedSchoolCount,
    },
  };
}
