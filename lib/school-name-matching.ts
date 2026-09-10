export type SchoolNameStage = "primary" | "middle" | "unknown";

export type SchoolNameCandidate = {
  name: string;
  stage: SchoolNameStage;
};

export type SchoolNameRow = {
  id: number;
  name: string;
  type: "primary" | "middle" | "nine_year" | string;
  aliases?: string[] | null;
};

export type SchoolNameMatch = {
  schoolId: number;
  matchKind: "exact" | "alias";
};

const PLACEHOLDER_NAMES = /^(统筹安排|统筹|待定|待安排|其他|合计|总计|无)$/;

/** Normalize official names while retaining campus text used to disambiguate schools. */
export function normalizeSchoolName(value: string) {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/[\s\u00a0]+/g, "")
    .replace(/^上海市/, "")
    .replace(/[（）()]/g, "")
    .replace(/[：:，,。；;]/g, "")
    .trim();
}

function nameVariants(value: string) {
  const normalized = normalizeSchoolName(value);
  const variants = new Set([normalized]);
  for (const suffix of ["小学部", "中学部", "初中部", "高中部"]) {
    if (normalized.endsWith(suffix)) variants.add(normalized.slice(0, -suffix.length));
  }
  return [...variants].filter(Boolean);
}

function stageMatches(candidate: SchoolNameCandidate, school: SchoolNameRow) {
  if (candidate.stage === "unknown") return true;
  if (candidate.stage === "primary") return school.type === "primary" || school.type === "nine_year";
  return school.type === "middle" || school.type === "nine_year";
}

function isPlaceholder(value: string) {
  return PLACEHOLDER_NAMES.test(normalizeSchoolName(value));
}

/**
 * Return a match only when the official name identifies one school in the
 * correct stage. Ambiguous campus-less names are intentionally rejected.
 */
export function findUniqueSchoolMatch(
  candidate: SchoolNameCandidate,
  schools: SchoolNameRow[],
): SchoolNameMatch | null {
  if (!candidate.name.trim() || isPlaceholder(candidate.name)) return null;

  const normalizedCandidate = normalizeSchoolName(candidate.name);
  const candidateVariants = nameVariants(candidate.name);
  const eligible = schools.filter((school) => stageMatches(candidate, school));
  const exact = eligible.filter((school) => {
    const names = [school.name, ...(school.aliases ?? [])].flatMap(nameVariants);
    return names.some((name) => candidateVariants.includes(name));
  });
  if (exact.length === 1) {
    const canonical = normalizeSchoolName(exact[0].name) === normalizedCandidate;
    return { schoolId: exact[0].id, matchKind: canonical ? "exact" : "alias" };
  }
  if (exact.length > 1) return null;

  const contained = eligible.filter((school) => {
    const names = [school.name, ...(school.aliases ?? [])].flatMap(nameVariants);
    return names.some((name) =>
      candidateVariants.some((variant) => name.includes(variant) || variant.includes(name)),
    );
  });
  return contained.length === 1 ? { schoolId: contained[0].id, matchKind: "alias" } : null;
}
