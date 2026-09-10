#!/usr/bin/env python3
"""
把 districts-schools.json (858 校) 转成 data/schools.json 格式 (与现有 schema/seed.ts 兼容)
"""
import json, re, os

with open("districts-schools.json") as f:
    src = json.load(f)

print(f"input: {len(src)} schools")

out = []
seen_names = set()  # 同名学校去重 (按 name 严格唯一)
for s in src:
    n = s["name"].strip()
    if n in seen_names:
        continue
    seen_names.add(n)

    # 区 normalize: "徐汇" 而不是 "徐汇区"
    district = s["district"]
    if district.endswith("区"):
        district = district[:-1]

    typ = s["type"]
    # 校区识别: 名字含 "(xxx校区)" 或 "xxx校区"
    campus_match = re.search(r"[（(]([^（）()]+校区)[）)]|（([^）]+)校区）", n)
    campus = (campus_match.group(1) or campus_match.group(2)) if campus_match else None

    matching = s.get("matching_committees") or []
    feeders = s.get("feeder_schools") or []
    raw = s.get("_raw_boundary_text", "")[:500]

    entry = {
        "name": n,
        "shortName": None,  # 暂无
        "district": district,
        "tier": None,  # 暂无 (未来从其他源补)
        "type": typ,
        "address": None,
        "lat": None,
        "lng": None,
        "enrollmentNote": (raw[:200] + "...") if len(raw) > 200 else raw or None,
        "recentScoreLine": None,
        "pitRiskLevel": "unknown",
        "attrs": {
            "verified": False,
            "data_source": "上海本地宝 2025-04 (sh.bendibao.com/edu/202547)",
            "policy_url": "https://sh.bendibao.com/",
            "school_nature": "公办",
            "campus": campus,
            "matching_committees": matching,
            "feeder_schools": feeders,
            "raw_boundary_text": raw,
        },
    }
    out.append(entry)

with open("data/schools.json", "w") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)

# 统计
by_district_type = {}
for s in out:
    k = (s["district"], s["type"])
    by_district_type[k] = by_district_type.get(k, 0) + 1
print(f"\n输出 {len(out)} 行到 data/schools.json")
for (d, t), n in sorted(by_district_type.items()):
    print(f"  {d} ({t}): {n}")
