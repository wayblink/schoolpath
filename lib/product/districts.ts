export const PRODUCT_DISTRICTS = [
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

export type ProductDistrict = (typeof PRODUCT_DISTRICTS)[number];

export function normalizeProductDistrict(value: string | null | undefined): ProductDistrict | null {
  if (!value?.trim()) return null;
  const normalized = value.trim().replace(/新区$/, "").replace(/区$/, "");
  return PRODUCT_DISTRICTS.includes(normalized as ProductDistrict)
    ? normalized as ProductDistrict
    : null;
}

export function displayProductDistrict(value: string | null | undefined) {
  const district = normalizeProductDistrict(value);
  return district === "浦东" ? "浦东新区" : district ? `${district}区` : value;
}
