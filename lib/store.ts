"use client";

import { create } from "zustand";

export type SchoolType = "primary" | "middle" | "nine_year";
export type TypeFilter = "all" | SchoolType;
export type TierFilter = "一梯队" | "二梯队" | "三梯队" | "四梯队" | "未入榜/待补充";

export const TIER_FILTERS: TierFilter[] = [
  "一梯队",
  "二梯队",
  "三梯队",
  "四梯队",
  "未入榜/待补充",
];

export const ALL_DISTRICTS = "全市";
export const DEFAULT_VISIBLE_TIERS: TierFilter[] = [...TIER_FILTERS];

interface SelectionState {
  selectedSchoolId: number | null;
  selectedCommunityId: number | null;
  hoveredSchoolId: number | null;
  selectedYear: number;
  selectedDistrict: string;
  typeFilter: TypeFilter;
  visibleTiers: TierFilter[];
  setSelectedSchool: (id: number | null) => void;
  setSelectedCommunity: (id: number | null) => void;
  setHoveredSchool: (id: number | null) => void;
  setYear: (year: number) => void;
  setDistrict: (district: string) => void;
  setTypeFilter: (filter: TypeFilter) => void;
  toggleTier: (tier: TierFilter) => void;
}

export const useSelection = create<SelectionState>((set) => ({
  selectedSchoolId: null,
  selectedCommunityId: null,
  hoveredSchoolId: null,
  selectedYear: 2025,
  selectedDistrict: ALL_DISTRICTS,
  typeFilter: "all",
  visibleTiers: DEFAULT_VISIBLE_TIERS,
  setSelectedSchool: (id) => set({ selectedSchoolId: id, selectedCommunityId: null }),
  setSelectedCommunity: (id) => set({ selectedCommunityId: id }),
  setHoveredSchool: (id) => set({ hoveredSchoolId: id }),
  setYear: (year) => set({ selectedYear: year }),
  setDistrict: (district) => set({ selectedDistrict: district }),
  setTypeFilter: (typeFilter) => set({ typeFilter }),
  toggleTier: (tier) =>
    set((state) => ({
      visibleTiers: state.visibleTiers.includes(tier)
        ? state.visibleTiers.filter((item) => item !== tier)
        : [...state.visibleTiers, tier],
    })),
}));
