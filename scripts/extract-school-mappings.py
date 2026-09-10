#!/usr/bin/env python3
"""
Phase 2: 抓本地宝 16 区对口表，build districts-schools.json

策略：
- 对每区，fetch 小学对口 + 初中对口 article HTML
- 解析正文表格 (<table>)
- 第 1 列假设是学校名，第 2 列是对口居委(小学)或对口小学(初中)
- 输出 {district, schools: [{name, type, matching_committees / feeder_schools}]}

源 (article id 已知): 见脚本顶部 DISTRICT_ARTICLES
"""
import urllib.request
import re
import time
import json
import html as htmlib
from html.parser import HTMLParser

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
BASE = "https://sh.bendibao.com/edu/202547"

# 已知 article id (从 bendibao-articles.json 提炼)，None 表示该区暂未找到该类
DISTRICT_ARTICLES = {
    "黄浦": {"policy": 296251, "primary": 296254, "middle": None},
    "徐汇": {"policy": 296228, "primary": 296230, "middle": 296237},
    "长宁": {"policy": 296283, "primary": 296284, "middle": 296286},
    "静安": {"policy": 296305, "primary": 296325, "middle": 296326},
    "普陀": {"policy": 296266, "primary": 296274, "middle": 296272},
    "虹口": {"policy": 296319, "primary": 296321, "middle": 296323},
    "杨浦": {"policy": 296296, "primary": 296298, "middle": 296300},
    "浦东": {"policy": 296190, "primary": None, "middle": 296199},
    "闵行": {"policy": 296191, "primary": 296201, "middle": 296203},
    "宝山": {"policy": 296196, "primary": 296231, "middle": 296235},
    "嘉定": {"policy": 296189, "primary": 296217, "middle": 296219},
    "金山": {"policy": 296308, "primary": 296310, "middle": 296312},
    "松江": {"policy": 296288, "primary": 296299, "middle": 296306},
    "青浦": {"policy": 296245, "primary": 296256, "middle": 296258},
    "奉贤": {"policy": 296302, "primary": 296304, "middle": 296304},
    "崇明": {"policy": 296313, "primary": 296315, "middle": 296316},
}

def fetch(url, timeout=10):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8", errors="ignore")
    except Exception as e:
        return None


class TableExtractor(HTMLParser):
    """从 HTML 抓所有 <table>，每个 table 返回 list[ list[ str ] ] (rows × cells)"""
    def __init__(self):
        super().__init__()
        self.tables = []
        self.current_table = None
        self.current_row = None
        self.current_cell = None
        self.cell_text_parts = []

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.current_table = []
        elif tag == "tr" and self.current_table is not None:
            self.current_row = []
        elif tag in ("td", "th") and self.current_row is not None:
            self.current_cell = True
            self.cell_text_parts = []

    def handle_endtag(self, tag):
        if tag == "table":
            if self.current_table is not None and self.current_table:
                self.tables.append(self.current_table)
            self.current_table = None
        elif tag == "tr":
            if self.current_row is not None and self.current_row:
                self.current_table.append(self.current_row)
            self.current_row = None
        elif tag in ("td", "th"):
            if self.current_cell:
                text = " ".join(self.cell_text_parts)
                text = re.sub(r"\s+", " ", text).strip()
                if self.current_row is not None:
                    self.current_row.append(text)
            self.current_cell = False
            self.cell_text_parts = []

    def handle_data(self, data):
        if self.current_cell:
            self.cell_text_parts.append(data)


def extract_tables(html):
    p = TableExtractor()
    p.feed(html)
    return p.tables


NAME_KEYS = ["校名", "学校名称", "学校 名称", "学校", "校 名"]
BOUNDARY_KEYS = [
    "对口居委", "招生地块", "对口地段", "对口范围", "招生范围", "招生地段", "招生区域", "招生片区",
    "招生划片范围", "对口区域范围", "对口就近入学范围", "学区范围", "居委会", "对口划片",
    "对口入学范围", "划片范围", "学区划分", "对口小区", "学区", "地段", "招生地址", "对口入学",
]
FEEDER_KEYS = ["对口小学", "生源小学", "对口学校", "生源", "对口入学", "小学地段"]


def identify_columns(header_row):
    name_col = boundary_col = feeder_col = None
    for i, h in enumerate(header_row):
        h = h.strip().replace(" ", "").replace("　", "")
        if not h:
            continue
        if name_col is None and any(k in h for k in NAME_KEYS):
            name_col = i
        if boundary_col is None and any(k in h for k in BOUNDARY_KEYS):
            boundary_col = i
        if feeder_col is None and any(k in h for k in FEEDER_KEYS):
            feeder_col = i
    return name_col, boundary_col, feeder_col


def find_best_header(table, kind):
    """扫前 4 行，找含 name + boundary/feeder keyword 最多的行作为表头"""
    best_idx = 0
    best_score = -1
    for i in range(min(4, len(table))):
        nc, bc, fc = identify_columns(table[i])
        if kind == "primary":
            score = (2 if nc is not None else 0) + (2 if bc is not None else 0)
        else:
            score = (2 if nc is not None else 0) + (2 if fc is not None else 0)
        if score > best_score:
            best_score = score
            best_idx = i
    return best_idx


def parse_primary_table(district, table):
    if len(table) < 2:
        return []
    header_idx = find_best_header(table, "primary")
    name_col, boundary_col, _ = identify_columns(table[header_idx])

    # 兜底：data row 第一个学校 cell
    if name_col is None:
        for i, c in enumerate(table[header_idx + 1] if len(table) > header_idx + 1 else []):
            if any(k in c for k in ["学校", "小学", "中学"]):
                name_col = i
                break
    if boundary_col is None and name_col is not None:
        for i, c in enumerate(table[header_idx + 1] if len(table) > header_idx + 1 else []):
            if i > name_col and len(c) > 8:
                boundary_col = i
                break
    if name_col is None or boundary_col is None:
        return []

    out = []
    for r in table[header_idx + 1:]:
        # 处理 merged-cell 列偏移: 头部某列被前面行 rowspan 占用，本行少一列
        # 自动尝试 name_col 和 name_col-1
        for name_offset in [0, -1, 1]:
            nc = name_col + name_offset
            bc = boundary_col + name_offset
            if nc < 0 or bc < 0 or nc >= len(r) or bc >= len(r):
                continue
            name = r[nc].strip()
            if not name or len(name) < 3:
                continue
            if not any(k in name for k in ["学校", "小学", "中学", "实验"]):
                continue
            boundary_text = r[bc].strip()
            # 排除 sub-title 行
            if name.startswith(("一、", "二、", "三、", "四、", "五、", "六、", "七、", "八、", "九、", "十、")):
                break
            items = re.split(r"[、，,；;\n\s]+", boundary_text)
            items = [c.strip() for c in items if len(c.strip()) > 1]
            out.append({
                "name": name,
                "type": "primary",
                "district": district,
                "matching_committees": items,
                "_raw_boundary_text": boundary_text[:500],
            })
            break  # 找到一个有效行就 break offset 循环
    return out


def parse_middle_table(district, table):
    if len(table) < 2:
        return []
    header_idx = find_best_header(table, "middle")
    name_col, _, feeder_col = identify_columns(table[header_idx])

    if name_col is None:
        for i, c in enumerate(table[header_idx + 1] if len(table) > header_idx + 1 else []):
            if any(k in c for k in ["中学", "学校", "九年"]):
                name_col = i
                break
    if feeder_col is None and name_col is not None:
        for i, c in enumerate(table[header_idx + 1] if len(table) > header_idx + 1 else []):
            if i > name_col and len(c) > 5:
                feeder_col = i
                break
    if name_col is None or feeder_col is None:
        return []

    out = []
    for r in table[header_idx + 1:]:
        for name_offset in [0, -1, 1]:
            nc = name_col + name_offset
            fc = feeder_col + name_offset
            if nc < 0 or fc < 0 or nc >= len(r) or fc >= len(r):
                continue
            name = r[nc].strip()
            if not name or len(name) < 3:
                continue
            if not any(k in name for k in ["中学", "学校", "实验", "初级", "九年"]):
                continue
            if name.startswith(("一、", "二、", "三、", "四、", "五、", "六、", "七、")):
                break
            feeders_text = " ".join(r[fc:]).strip()
            feeders = re.split(r"[、，,；;\n\s]+", feeders_text)
            feeders = [f.strip() for f in feeders if len(f.strip()) > 1]
            out.append({
                "name": name,
                "type": "middle",
                "district": district,
                "feeder_schools": feeders,
                "_raw_boundary_text": feeders_text[:500],
            })
            break
    return out


def main():
    all_schools = {}  # name → school dict
    stats = {d: {"primary": 0, "middle": 0, "primary_tables": 0, "middle_tables": 0} for d in DISTRICT_ARTICLES}

    for district, ids in DISTRICT_ARTICLES.items():
        # 小学
        if ids.get("primary"):
            url = f"{BASE}/{ids['primary']}.shtm"
            html = fetch(url)
            if html:
                tables = extract_tables(html)
                stats[district]["primary_tables"] = len(tables)
                # 找最大的 table (通常对口表是最大的)
                if tables:
                    tables.sort(key=lambda t: sum(len(r) for r in t), reverse=True)
                    schools = parse_primary_table(district, tables[0])
                    for s in schools:
                        key = s["name"]
                        if key in all_schools:
                            # 累加 + dedup committees
                            existing = all_schools[key]
                            merged = list(dict.fromkeys(
                                (existing.get("matching_committees") or []) + (s["matching_committees"] or [])
                            ))
                            existing["matching_committees"] = merged
                            existing["_raw_boundary_text"] = (
                                (existing.get("_raw_boundary_text") or "") + " | " + (s.get("_raw_boundary_text") or "")
                            )[:1000]
                        else:
                            all_schools[key] = s
                            stats[district]["primary"] += 1
            time.sleep(1)
        # 初中
        if ids.get("middle"):
            url = f"{BASE}/{ids['middle']}.shtm"
            html = fetch(url)
            if html:
                tables = extract_tables(html)
                stats[district]["middle_tables"] = len(tables)
                if tables:
                    tables.sort(key=lambda t: sum(len(r) for r in t), reverse=True)
                    schools = parse_middle_table(district, tables[0])
                    for s in schools:
                        key = s["name"]
                        if key in all_schools:
                            existing = all_schools[key]
                            merged = list(dict.fromkeys(
                                (existing.get("feeder_schools") or []) + (s.get("feeder_schools") or [])
                            ))
                            existing["feeder_schools"] = merged
                            existing["type"] = "middle" if "中学" in key else existing["type"]
                        else:
                            all_schools[key] = s
                            stats[district]["middle"] += 1
            time.sleep(1)
        print(f"  {district}: 小学+{stats[district]['primary']:3d}, 初中+{stats[district]['middle']:3d}, tables=(p={stats[district]['primary_tables']}, m={stats[district]['middle_tables']})")

    out = list(all_schools.values())
    print(f"\n=== summary ===")
    print(f"total unique schools: {len(out)}")
    by_d = {}
    for s in out:
        by_d.setdefault(s["district"], {"primary": 0, "middle": 0})
        by_d[s["district"]][s["type"]] += 1
    for d in DISTRICT_ARTICLES:
        c = by_d.get(d, {"primary": 0, "middle": 0})
        print(f"  {d}: {c['primary']} 小学 + {c['middle']} 初中")

    with open("districts-schools.json", "w") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print("\n✓ saved districts-schools.json")


if __name__ == "__main__":
    main()
