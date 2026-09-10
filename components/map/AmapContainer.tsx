"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSelection } from "@/lib/store";
import type { CommunityApi } from "@/lib/api-types";

type FeatureCollection = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: {
      boundaryId: number;
      schoolId: number;
      schoolName: string;
      schoolTier: string | null;
      schoolType: string;
      district: string;
      year: number;
      notes: string | null;
    };
    geometry:
      | { type: "Polygon"; coordinates: number[][][] }
      | { type: "MultiPolygon"; coordinates: number[][][][] };
  }>;
};

// 把 GeoJSON Polygon/MultiPolygon 拆成"每个 outer ring 一个数组"，丢掉 holes
// (高德 Polygon 可以处理 holes 但 fitView 时容易出问题，简化处理)
function geometryToOuterRings(
  geometry: { type: "Polygon"; coordinates: number[][][] } | { type: "MultiPolygon"; coordinates: number[][][][] },
): number[][][] {
  if (geometry.type === "Polygon") {
    // 取第一个 ring（外环），忽略 holes
    return [geometry.coordinates[0]];
  }
  // MultiPolygon: 每个子 Polygon 的第一个 ring
  return geometry.coordinates.map((poly) => poly[0]);
}

type School = {
  id: number;
  name: string;
  lat: number | null;
  lng: number | null;
  tier: string | null;
  type: "primary" | "middle" | "nine_year";
  attrs: Record<string, unknown> | null;
};

type AMapLngLat = unknown;
type AMapPixel = unknown;
type AMapSize = unknown;
type AMapOverlay = {
  on: (event: string, handler: (event?: { data?: { id?: number } }) => void) => void;
  setOptions?: (options: Record<string, unknown>) => void;
  setLabel?: (label: Record<string, unknown>) => void;
  setContent?: (content: string) => void;
  setzIndex?: (zIndex: number) => void;
  setMap?: (map: AMapMap | null) => void;
};
type AMapMap = {
  add: (overlay: AMapOverlay) => void;
  remove: (overlay: AMapOverlay) => void;
  setFitView: (overlays: AMapOverlay[], immediately?: boolean, padding?: number[]) => void;
  setZoomAndCenter: (zoom: number, center: [number, number]) => void;
  setZoom?: (zoom: number) => void;
  getZoom?: () => number;
  resize?: () => void;
  destroy?: () => void;
};
type AMapNamespace = {
  Map: new (container: HTMLDivElement, options: Record<string, unknown>) => AMapMap;
  Polygon: new (options: Record<string, unknown>) => AMapOverlay;
  Marker: new (options: Record<string, unknown>) => AMapOverlay;
  MassMarks: new (data: Array<Record<string, unknown>>, options: Record<string, unknown>) => AMapOverlay;
  LngLat: new (lng: number, lat: number) => AMapLngLat;
  Pixel: new (x: number, y: number) => AMapPixel;
  Size: new (width: number, height: number) => AMapSize;
};

const TIER_COLORS: Record<string, string> = {
  "一梯队": "#dc2626",
  "二梯队": "#f97316",
  "三梯队": "#eab308",
  "四梯队": "#60a5fa",
  "未入榜/待补充": "#6b7280",
};
const DEFAULT_COLOR = "#3b82f6";

// Fixed administrative-district centers used by the AMap view. Keep these
// independent from school coverage and polygon outliers.
const DISTRICT_VIEWS: Record<string, { center: [number, number]; zoom: number }> = {
  黄浦: { center: [121.484, 31.232], zoom: 13 },
  静安: { center: [121.448, 31.229], zoom: 13 },
  长宁: { center: [121.424, 31.218], zoom: 13 },
  虹口: { center: [121.491, 31.265], zoom: 13 },
  杨浦: { center: [121.526, 31.259], zoom: 13 },
  徐汇: { center: [121.437, 31.188], zoom: 13 },
  闵行: { center: [121.381, 31.112], zoom: 11.5 },
  浦东: { center: [121.544, 31.221], zoom: 11.5 },
  普陀: { center: [121.395, 31.249], zoom: 13 },
};

function formatUnitPrice(value: number | null | undefined) {
  if (value == null) return "待采集";
  return `${Math.round(value).toLocaleString("zh-CN")} 元/㎡`;
}

interface Props {
  districts: FeatureCollection | undefined;
  schools: School[] | undefined;
  communities?: CommunityApi[];
  focusRequest?: number;
  selectedDistrict?: string;
}

declare global {
  interface Window {
    _AMapSecurityConfig?: { securityJsCode: string };
  }
}

export function AmapContainer({ districts, schools, communities, focusRequest = 0, selectedDistrict = "" }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [mapInstance, setMapInstance] = useState<unknown>(null);
  const [amapNs, setAmapNs] = useState<unknown>(null);
  const polygonRefs = useRef<Map<number, AMapOverlay[]>>(new Map());
  const markerRefs = useRef<Map<number, AMapOverlay>>(new Map());
  const schoolMassMarksRef = useRef<AMapOverlay | null>(null);
  const selectedSchoolMarkerRef = useRef<AMapOverlay | null>(null);
  const communityMarkerRefs = useRef<AMapOverlay[]>([]);
  const communityMarkerByIdRefs = useRef<Map<number, AMapOverlay>>(new Map());
  const selectedCommunityMarkerRef = useRef<AMapOverlay | null>(null);
  const massMarksRef = useRef<AMapOverlay | null>(null);

  const selectedSchoolId = useSelection((s) => s.selectedSchoolId);
  const selectedCommunityId = useSelection((s) => s.selectedCommunityId);
  const setSelectedSchool = useSelection((s) => s.setSelectedSchool);
  const setSelectedCommunity = useSelection((s) => s.setSelectedCommunity);
  const hoveredSchoolId = useSelection((s) => s.hoveredSchoolId);
  const setHoveredSchool = useSelection((s) => s.setHoveredSchool);

  const schoolsById = useMemo(() => {
    const m = new Map<number, School>();
    for (const s of schools ?? []) m.set(s.id, s);
    return m;
  }, [schools]);

  // 1. Init map (one-time)
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_AMAP_KEY;
    const securityCode = process.env.NEXT_PUBLIC_AMAP_SECURITY_CODE;

    if (!key) {
      console.warn("[AmapContainer] missing NEXT_PUBLIC_AMAP_KEY in .env.local");
      return;
    }
    if (securityCode && typeof window !== "undefined") {
      window._AMapSecurityConfig = { securityJsCode: securityCode };
    }

    const polygonMap = polygonRefs.current;
    const markerMap = markerRefs.current;
    let cancelled = false;
    (async () => {
      const { default: AMapLoader } = await import("@amap/amap-jsapi-loader");
      try {
        const AMap = (await AMapLoader.load({
          key,
          version: "2.0",
          plugins: ["AMap.Polygon", "AMap.Marker", "AMap.InfoWindow", "AMap.MassMarks"],
        })) as AMapNamespace;
        if (cancelled || !containerRef.current) return;
        const container = containerRef.current;
        if (container.clientWidth === 0 || container.clientHeight === 0) return;
        const map = new AMap.Map(containerRef.current, {
          // Default view: frame Shanghai and its immediate edge areas without
          // showing the oversized regional view used by the old map screen.
          zoom: 11,
          center: [121.4737, 31.2304],
          viewMode: "2D",
          mapStyle: "amap://styles/normal",
        });
        setMapInstance(map);
        setAmapNs(AMap);
      } catch (err) {
        console.error("[AmapContainer] AMap load failed", err);
      }
    })();

    return () => {
      cancelled = true;
      setMapInstance((m: unknown) => {
        const inst = m as AMapMap | null;
        if (inst?.destroy) inst.destroy();
        return null;
      });
      polygonMap.clear();
      markerMap.clear();
    };
  }, []);

  // 2. Render polygons whenever districts data changes
  useEffect(() => {
    const map = mapInstance as AMapMap | null;
    const AMap = amapNs as AMapNamespace | null;
    if (!map || !AMap || !districts) return;

    for (const polygons of polygonRefs.current.values()) {
      for (const p of polygons) map.remove(p);
    }
    polygonRefs.current.clear();

    for (const feature of districts.features) {
      const outerRings = geometryToOuterRings(feature.geometry);
      const tier = feature.properties.schoolTier ?? "";
      const fillColor = TIER_COLORS[tier] ?? DEFAULT_COLOR;
      const id = feature.properties.schoolId;
      const created: AMapOverlay[] = [];

      for (const ring of outerRings) {
        if (ring.length < 3) continue;
        const path = ring.map(([lng, lat]) => new AMap.LngLat(lng, lat));
        const polygon = new AMap.Polygon({
          path,
          strokeColor: fillColor,
          strokeWeight: 2,
          strokeOpacity: 0.8,
          fillColor,
          fillOpacity: 0.18,
          cursor: "pointer",
          zIndex: 10,
        });
        polygon.on("click", () => setSelectedSchool(id));
        polygon.on("mouseover", () => setHoveredSchool(id));
        polygon.on("mouseout", () => setHoveredSchool(null));
        map.add(polygon);
        created.push(polygon);
      }
      polygonRefs.current.set(id, created);
    }
  }, [mapInstance, amapNs, districts, setSelectedSchool, setHoveredSchool]);

  // Keep the map view aligned with the selected district. The filtered district
  // polygons provide a more accurate boundary than a hard-coded center.
  useEffect(() => {
    const map = mapInstance as AMapMap | null;
    const view = DISTRICT_VIEWS[selectedDistrict];
    if (!map || !view) return;
    map.setZoomAndCenter(view.zoom, view.center);
  }, [mapInstance, selectedDistrict]);

  // 3. Render school points as one canvas layer. A selected school gets one DOM marker.
  useEffect(() => {
    const map = mapInstance as AMapMap | null;
    const AMap = amapNs as AMapNamespace | null;
    if (!map || !AMap || !schools) return;

    for (const marker of markerRefs.current.values()) {
      map.remove(marker);
    }
    markerRefs.current.clear();
    schoolMassMarksRef.current?.setMap?.(null);
    schoolMassMarksRef.current = null;
    const validSchools = schools.filter((school) => school.lat != null && school.lng != null);
    if (!validSchools.length) return;
    const tierKeys = Object.keys(TIER_COLORS);
    const styles = tierKeys.map((tier) => ({
      url: `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14"><circle cx="7" cy="7" r="5.5" fill="${TIER_COLORS[tier]}" stroke="white" stroke-width="2"/></svg>`)}`,
      anchor: new AMap.Pixel(7, 7),
      size: new AMap.Size(14, 14),
    }));
    styles.push({
      url: `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14"><circle cx="7" cy="7" r="5.5" fill="${DEFAULT_COLOR}" stroke="white" stroke-width="2"/></svg>`)}`,
      anchor: new AMap.Pixel(7, 7),
      size: new AMap.Size(14, 14),
    });
    const data = validSchools.map((school) => ({
      id: school.id,
      lnglat: [school.lng, school.lat],
      name: school.name,
      style: tierKeys.indexOf(school.tier ?? "") >= 0 ? tierKeys.indexOf(school.tier ?? "") : tierKeys.length,
    }));
    const massMarks = new AMap.MassMarks(data, { zIndex: 50, cursor: "pointer", style: styles });
    massMarks.on("click", (event) => { if (event?.data?.id != null) setSelectedSchool(event.data.id); });
    massMarks.on("mouseover", (event) => { if (event?.data?.id != null) setHoveredSchool(event.data.id); });
    massMarks.on("mouseout", () => setHoveredSchool(null));
    massMarks.setMap?.(map);
    schoolMassMarksRef.current = massMarks;
    return () => { massMarks.setMap?.(null); if (schoolMassMarksRef.current === massMarks) schoolMassMarksRef.current = null; };
  }, [mapInstance, amapNs, schools, setSelectedSchool, setHoveredSchool]);

  // 3.5 Render community dots (only when a school is selected)
  // 阈值: ≤300 用 AMap.Marker (单 marker 带 hover title), >300 用 AMap.MassMarks (canvas 海量点)
  useEffect(() => {
    const map = mapInstance as AMapMap | null;
    const AMap = amapNs as AMapNamespace | null;
    if (!map || !AMap) return;

    // 清掉旧的
    for (const m of communityMarkerRefs.current) map.remove(m);
    communityMarkerRefs.current = [];
    communityMarkerByIdRefs.current.clear();
    if (selectedCommunityMarkerRef.current) {
      map.remove(selectedCommunityMarkerRef.current);
      selectedCommunityMarkerRef.current = null;
    }
    if (massMarksRef.current) {
      massMarksRef.current.setMap?.(null);
      massMarksRef.current = null;
    }

    if (!communities || communities.length === 0) return;

    const validCommunities = communities.filter(
      (c): c is CommunityApi & { lng: number; lat: number } => c.lng != null && c.lat != null,
    );

    if (validCommunities.length <= 300) {
      // 小量: 用 DOM marker
      for (const c of validCommunities) {
        const dotHtml = `<div style="
          width:8px;height:8px;border-radius:50%;
          background:#10b981;
          border:1.5px solid white;
          box-shadow:0 1px 3px rgba(0,0,0,0.4);
          cursor:pointer;
        "></div>`;
        const marker = new AMap.Marker({
          position: new AMap.LngLat(c.lng, c.lat),
          title: `${c.name}\n房价: ${formatUnitPrice(c.latestPriceSnapshot?.unitPriceYuanPerSqm)}${c.latestPriceSnapshot ? ` (${c.latestPriceSnapshot.sourcePeriod})` : ""}\n${c.amapAddress ?? ""}\n来自居委: ${c.committeeName ?? c.sourceCommittee ?? "—"}`,
          content: dotHtml,
          offset: new AMap.Pixel(-4, -4),
          zIndex: 30,
        });
        marker.on("click", () => setSelectedCommunity(c.communityId));
        map.add(marker);
        communityMarkerRefs.current.push(marker);
        communityMarkerByIdRefs.current.set(c.communityId, marker);
      }
    } else {
      // 大量: 用 MassMarks (canvas)
      const greenDot = `data:image/svg+xml;utf8,${encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="3.5" fill="#10b981" stroke="white" stroke-width="1.5"/></svg>',
      )}`;
      const data = validCommunities.map((c) => ({
        lnglat: [c.lng!, c.lat!] as [number, number],
        style: 0,
        name: c.name,
        addr: c.amapAddress ?? "",
        committee: c.committeeName ?? c.sourceCommittee ?? "—",
        price: formatUnitPrice(c.latestPriceSnapshot?.unitPriceYuanPerSqm),
      }));
      const massMarks = new AMap.MassMarks(data, {
        zIndex: 30,
        cursor: "pointer",
        style: [
          {
            url: greenDot,
            anchor: new AMap.Pixel(5, 5),
            size: new AMap.Size(10, 10),
          },
        ],
      });
      massMarks.setMap?.(map);
      massMarksRef.current = massMarks;
    }
  }, [mapInstance, amapNs, communities, setSelectedCommunity]);

  // 4. Apply selection/hover styling: dim non-active polygons + show label only on active markers
  useEffect(() => {
    const map = mapInstance as AMapMap | null;
    const AMap = amapNs as AMapNamespace | null;
    if (!map || !AMap) return;
    const activeId = selectedSchoolId ?? hoveredSchoolId;
    const hasActive = activeId != null;

    // Polygons: dim all, brighten active (each schoolId may have multiple polygon pieces)
    for (const [id, polys] of polygonRefs.current.entries()) {
      const isActive = id === activeId;
      const options = !hasActive
        ? { fillOpacity: 0.22, strokeOpacity: 0.85, strokeWeight: 2, zIndex: 10 }
        : isActive
          ? { fillOpacity: 0.55, strokeOpacity: 1, strokeWeight: 3, zIndex: 30 }
          : { fillOpacity: 0.06, strokeOpacity: 0.3, strokeWeight: 1, zIndex: 10 };
      for (const p of polys) p.setOptions?.(options);
    }

    if (selectedSchoolMarkerRef.current) {
      map.remove(selectedSchoolMarkerRef.current);
      selectedSchoolMarkerRef.current = null;
    }
    if (activeId != null) {
      const school = schoolsById.get(activeId);
      if (school?.lng != null && school.lat != null) {
        const color = TIER_COLORS[school.tier ?? ""] ?? DEFAULT_COLOR;
        const marker = new AMap.Marker({
          position: new AMap.LngLat(school.lng, school.lat),
          content: `<div style="width:18px;height:18px;border-radius:50%;background:${color};border:3px solid white;box-shadow:0 0 0 4px rgba(37,99,235,.22),0 3px 10px rgba(0,0,0,.4)"></div>`,
          offset: new AMap.Pixel(-9, -9), zIndex: 90,
        });
        marker.setLabel?.({
          content: `<div style="
            background:#16161a;
            padding:5px 9px;
            border-radius:6px;
            border:1px solid #2a2a2e;
            box-shadow:0 4px 12px rgba(0,0,0,0.5);
            font-size:12px;
            color:#ececf0;
            white-space:nowrap;
            transform: translateY(-4px);
            font-family: var(--font-sans, system-ui);
          ">${school.name}</div>`,
          direction: "top",
          offset: new AMap.Pixel(0, -6),
        });
        map.add(marker);
        selectedSchoolMarkerRef.current = marker;
      }
    }
  }, [mapInstance, amapNs, selectedSchoolId, hoveredSchoolId, schoolsById]);

  // 5. fitView on selection change
  useEffect(() => {
    const map = mapInstance as AMapMap | null;
    if (!map || selectedSchoolId == null) return;
    if (selectedCommunityId != null) return;
    const polys = polygonRefs.current.get(selectedSchoolId);
    if (polys && polys.length > 0) {
      map.setFitView(polys, false, [40, 40, 40, 40]);
    } else {
      const school = schoolsById.get(selectedSchoolId);
      if (school?.lng != null && school.lat != null) map.setZoomAndCenter(15, [school.lng, school.lat]);
    }
  }, [mapInstance, selectedSchoolId, selectedCommunityId, focusRequest, districts, schools, schoolsById]);

  useEffect(() => {
    const map = mapInstance as AMapMap | null;
    const AMap = amapNs as AMapNamespace | null;
    if (!map || !AMap) return;

    for (const [id, markerValue] of communityMarkerByIdRefs.current.entries()) {
      const marker = markerValue;
      if (id === selectedCommunityId) {
        const community = communities?.find((c) => c.communityId === id);
        marker.setzIndex?.(90);
        marker.setContent?.(`<div style="
          width:14px;height:14px;border-radius:50%;
          background:#6ba3ff;
          border:2px solid white;
          box-shadow:0 0 0 4px rgba(107,163,255,0.22),0 4px 14px rgba(0,0,0,0.45);
          cursor:pointer;
        "></div>`);
        marker.setLabel?.({
          content: `<div style="
            background:#16161a;
            padding:5px 9px;
            border-radius:6px;
            border:1px solid #6ba3ff;
            box-shadow:0 4px 12px rgba(0,0,0,0.5);
            font-size:12px;
            color:#ececf0;
            white-space:nowrap;
            transform: translateY(-4px);
            font-family: var(--font-sans, system-ui);
          ">${community?.name ?? "选中小区"}</div>`,
          direction: "top",
          offset: new AMap.Pixel(0, -8),
        });
      } else {
        const community = communities?.find((c) => c.communityId === id);
        const isDerived = community?.sourceName === "derived_via_feeder_school";
        const dotColor = isDerived ? "#a855f7" : "#10b981";
        marker.setzIndex?.(30);
        marker.setContent?.(`<div style="
          width:8px;height:8px;border-radius:50%;
          background:${dotColor};
          border:1.5px solid white;
          box-shadow:0 1px 3px rgba(0,0,0,0.4);
          cursor:pointer;
        "></div>`);
        marker.setLabel?.({ content: "" });
      }
    }

    if (selectedCommunityMarkerRef.current) {
      map.remove(selectedCommunityMarkerRef.current);
      selectedCommunityMarkerRef.current = null;
    }

    if (selectedCommunityId == null) return;
    const selectedCommunity = communities?.find((c) => c.communityId === selectedCommunityId);
    if (!selectedCommunity || selectedCommunity.lng == null || selectedCommunity.lat == null) return;

    const selectedMarker = communityMarkerByIdRefs.current.get(selectedCommunityId);
    if (selectedMarker) {
      map.setZoomAndCenter(Math.max(map.getZoom?.() ?? 0, 16), [selectedCommunity.lng, selectedCommunity.lat]);
      return;
    }

    const marker = new AMap.Marker({
      position: new AMap.LngLat(selectedCommunity.lng, selectedCommunity.lat),
      content: `<div style="
        width:16px;height:16px;border-radius:50%;
        background:#6ba3ff;
        border:2px solid white;
        box-shadow:0 0 0 5px rgba(107,163,255,0.22),0 4px 14px rgba(0,0,0,0.45);
      "></div>`,
      offset: new AMap.Pixel(-8, -8),
      zIndex: 95,
    });
    marker.setLabel?.({
      content: `<div style="
        background:#16161a;
        padding:5px 9px;
        border-radius:6px;
        border:1px solid #6ba3ff;
        box-shadow:0 4px 12px rgba(0,0,0,0.5);
        font-size:12px;
        color:#ececf0;
        white-space:nowrap;
        transform: translateY(-4px);
        font-family: var(--font-sans, system-ui);
      ">${selectedCommunity.name}</div>`,
      direction: "top",
      offset: new AMap.Pixel(0, -8),
    });
    map.add(marker);
    selectedCommunityMarkerRef.current = marker;
    map.setZoomAndCenter(Math.max(map.getZoom?.() ?? 0, 16), [selectedCommunity.lng, selectedCommunity.lat]);
  }, [mapInstance, amapNs, communities, selectedCommunityId]);

  useEffect(() => {
    const map = mapInstance as { resize?: () => void } | null;
    if (!map?.resize || !containerRef.current) return;

    let frame = 0;
    let previousWidth = 0;
    let previousHeight = 0;
    const resizeMap = (width: number, height: number) => {
      if (width <= 0 || height <= 0) return;
      if (width === previousWidth && height === previousHeight) return;
      previousWidth = width;
      previousHeight = height;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => map.resize?.());
    };
    const observer = new ResizeObserver(([entry]) => {
      resizeMap(Math.round(entry.contentRect.width), Math.round(entry.contentRect.height));
    });
    observer.observe(containerRef.current);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [mapInstance]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full bg-neutral-100"
      data-testid="amap-container"
    />
  );
}
