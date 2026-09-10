export type CommunityApi = {
  linkId: number;
  communityId: number;
  name: string;
  lng: number | null;
  lat: number | null;
  amapPoiId: string | null;
  amapTypeName: string | null;
  amapAddress: string | null;
  sourceCommittee: string | null;
  communityVerified: boolean;
  committeeName: string | null;
  sourceName: string;
  sourceUrl: string | null;
  sourceQuote: string | null;
  sourceDate: string;
  linkVerified: boolean;
  notes: string | null;
  latestPriceSnapshot: {
    id: number;
    communityId: number;
    sourceName: string;
    sourceUrl: string;
    sourcePeriod: string;
    unitPriceYuanPerSqm: number;
    fetchedAt: string | null;
  } | null;
};
