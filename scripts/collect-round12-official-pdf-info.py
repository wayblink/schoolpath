#!/usr/bin/env python3
"""Parse cached round-12 official school-info PDFs into strict import JSON.

The output is consumed by backfill-official-exact-school-info.ts. This parser
keeps only explicit school name/address/nature/stage fields and deliberately
does not turn the Hongkou ``对口小学`` column into community relations.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

import pdfplumber


ROOT = Path.cwd()
SOURCES = [
    {
        "district": "杨浦",
        "stage": "primary",
        "path": ROOT / "data/audit/source-cache/round11/yangpu-primary-2025.pdf",
        "title": "2025年杨浦区义务教育阶段公办小学基本情况公示（规模、设备、师资）及招生计划",
        "url": "https://www.shyp.gov.cn/shypq/yqyw-wb-jyjzl-ypzs-xxzs/20250407/477710/d1833493558244b3ad870c206b1b43d0.pdf",
    },
    {
        "district": "虹口",
        "stage": "middle",
        "path": ROOT / "data/audit/source-cache/round10/hongkou-public-middle-2025.pdf",
        "title": "2025年虹口区义务教育阶段公办初中招生计划和联系方式",
        "url": "https://www.shhk.gov.cn/hkjy_nas/13bebba5-5f61-49ee-8552-4fee4665e1ac/64054e0e-3738-43c8-ba40-c345b0d09b27/2025%E5%B9%B4%E8%99%B9%E5%8F%A3%E5%8C%BA%E4%B9%89%E5%8A%A1%E6%95%99%E8%82%B2%E9%98%B6%E6%AE%B5%E5%85%AC%E5%8A%9E%E5%88%9D%E4%B8%AD%E6%8B%9B%E7%94%9F%E8%AE%A1%E5%88%92%E5%92%8C%E8%81%94%E7%B3%BB%E6%96%B9%E5%BC%8F.pdf",
    },
    {
        "district": "虹口",
        "stage": "unknown",
        "path": ROOT / "data/audit/source-cache/round10/hongkou-private-2025.pdf",
        "title": "2025年虹口区义务教育阶段民办中小学基本情况",
        "url": "https://www.shhk.gov.cn/hkjy_nas/4598de7d-1bcc-4128-a18d-77828712c114/5b1f9107-1e5c-4476-8000-8af02605e94b/2025%E5%B9%B4%E8%99%B9%E5%8F%A3%E5%8C%BA%E4%B9%89%E5%8A%A1%E6%95%99%E8%82%B2%E9%98%B6%E6%AE%B5%E6%B0%91%E5%8A%9E%E4%B8%AD%E5%B0%8F%E5%AD%A6%E5%9F%BA%E6%9C%AC%E6%83%85%E5%86%B5.pdf",
    },
]


def clean(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "").replace("\u3000", " ")).strip()


def nature(value: str) -> str:
    if "民办" in value:
        return "民办"
    if "公办" in value or "公立" in value:
        return "公办"
    return ""


def looks_address(value: str) -> bool:
    """Reject the second staffing table on the Yangpu PDF."""
    return bool(re.search(r"(?:路|街|弄|号|村|校区|安置点)", value))


def row_record(config: dict, name: str, address: str, raw: list[object], stage: str | None = None, nature_value: str = "公办") -> dict | None:
    name = clean(name)
    address = clean(address)
    if not name or not address or not looks_address(address) or name in {"学校名称", "合计"}:
        return None
    if name.startswith("编号") or name.startswith("序号"):
        return None
    return {
        "district": config["district"],
        "stage": stage or config["stage"],
        "name": name,
        "campus": "",
        "nature": nature_value,
        "address": address,
        "sourceTitle": config["title"],
        "sourceUrl": config["url"],
        "raw": [clean(v) for v in raw],
    }


def parse(config: dict) -> list[dict]:
    records: list[dict] = []
    with pdfplumber.open(str(config["path"])) as pdf:
        for page in pdf.pages:
            for table in page.extract_tables() or []:
                for row in table:
                    cells = [clean(v) for v in row]
                    if config["stage"] == "primary":
                        if len(cells) >= 4 and re.fullmatch(r"\d+", cells[0]):
                            item = row_record(config, cells[1], cells[2], cells, nature_value="公办")
                            if item:
                                records.append(item)
                    elif config["stage"] == "middle":
                        if len(cells) >= 9 and re.fullmatch(r"\d+", cells[0]):
                            item = row_record(config, cells[1], cells[2], cells, nature_value=nature(cells[4]) or "公办")
                            if item:
                                records.append(item)
                    else:
                        if len(cells) >= 4 and re.fullmatch(r"\d+", cells[0]):
                            # Rows 1-4 are primary schools; rows 5-9 are middle
                            # schools. Stage is explicit in the school name.
                            inferred = "primary" if "小学" in cells[1] else "middle" if "中学" in cells[1] else "unknown"
                            item = row_record(config, cells[1], cells[2], cells, stage=inferred, nature_value="民办")
                            if item and inferred != "unknown":
                                records.append(item)
    return records


def main() -> None:
    missing = [str(x["path"]) for x in SOURCES if not x["path"].exists()]
    if missing:
        raise SystemExit("Missing cached PDF: " + ", ".join(missing))
    records: list[dict] = []
    links = []
    for config in SOURCES:
        parsed = parse(config)
        records.extend(parsed)
        links.append({"district": config["district"], "title": config["title"], "url": config["url"], "records": len(parsed)})
        print(f"{config['district']} {config['title']}: records={len(parsed)}")
    dedup = {(r["district"], r["stage"], r["name"], r["address"], r["sourceUrl"]): r for r in records}
    out = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": "cached official district education PDFs",
        "linkCount": len(links),
        "recordCount": len(dedup),
        "links": links,
        "records": list(dedup.values()),
    }
    target = ROOT / ".tmp" / "official-school-info" / "round12-official-pdfs.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Output: {target}")
    print(f"Done. records={len(dedup)}")


if __name__ == "__main__":
    main()
