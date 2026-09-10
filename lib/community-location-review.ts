const RESIDENTIAL_ROOT_TYPES = new Set(["商务住宅", "房产小区"]);
const RESIDENTIAL_DETAIL_TYPES = new Set(["住宅区", "住宅小区"]);

export function isResidentialCommunityPoiType(poiType: string) {
  const parts = poiType
    .split(/[;:]/)
    .map((part) => part.trim())
    .filter(Boolean);

  return RESIDENTIAL_ROOT_TYPES.has(parts[0] ?? "") && parts.slice(1).some((part) => RESIDENTIAL_DETAIL_TYPES.has(part));
}

export function communityLocationAuditRunName(stamp: string, provider: string, sourceReport: string) {
  const sourceRun = sourceReport.match(/community-location-backfill\/(\d{8}-\d{6})\//)?.[1] ?? "unknown-source";
  return `${stamp}-${provider}-${sourceRun}`;
}
