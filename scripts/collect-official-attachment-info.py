#!/usr/bin/env python3
"""Collect school address records from official PDF/XLS attachments.

This script is read-only with respect to the database. It downloads/parses a
small allowlist of official Shanghai government attachments and writes a JSON
file compatible with scripts/backfill-school-info-from-official.ts.
"""

from __future__ import annotations

import json
import re
import sys
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable


ROOT = Path.cwd()
OUT_DIR = ROOT / ".tmp" / "official-school-info"
ATTACHMENT_DIR = ROOT / ".tmp" / "official-attachments"
BASE_URL = "https://www.shanghai.gov.cn"


@dataclass(frozen=True)
class Attachment:
    district: str
    title: str
    url: str
    filename: str
    parser: str
    nature: str = "公办"


ATTACHMENTS = [
    Attachment(
        district="嘉定",
        title="2025年嘉定区义务教育阶段公办学校基本情况",
        url=f"{BASE_URL}/cmsres/36/363881f703f146b6b50547142c3255e4/0e579ab9fa85681dd7fc712bc74f99a6.pdf",
        filename="jiading-basic-public.pdf",
        parser="jiading_pdf",
        nature="公办",
    ),
    Attachment(
        district="嘉定",
        title="2025年嘉定区义务教育阶段民办学校基本情况",
        url=f"{BASE_URL}/cmsres/b9/b967748e67074323a73ef1586db4ef32/85e9c727c4c5a019e3135337cac7b180.pdf",
        filename="jiading-basic-private.pdf",
        parser="jiading_pdf",
        nature="民办",
    ),
    Attachment(
        district="松江",
        title="2025年松江区义务教育阶段学校规模、招生计划、校舍场地条件、教育教学、后勤设施设备和师资配置基本情况公示",
        url=f"{BASE_URL}/cmsres/90/901088067bed467382785e3076498c44/6a224298ebd26d6b2a03e14b75f56c5c.pdf",
        filename="songjiang.pdf",
        parser="songjiang_pdf",
        nature="",
    ),
    Attachment(
        district="金山",
        title="2025年金山区义务教育阶段各公办学校办学规模、校舍场地、教育教学、后勤设施设备和师资配置情况公示表",
        url=f"{BASE_URL}/cmsres/0c/0c5d1e78b05f41afa48a25e31f6112e8/1694460ea3a1b9ff02bd2004376e7ece.xls",
        filename="jinshan-public.xls",
        parser="jinshan_xls",
        nature="公办",
    ),
    Attachment(
        district="金山",
        title="2025年金山区义务教育阶段各民办学校办学规模、校舍场地、教育教学、后勤设施设备和师资配置情况公示表",
        url=f"{BASE_URL}/cmsres/f8/f8d5a2d1d7234217a2ac03c81ed90314/6a63afac2f41a95acb504711898f6222.xls",
        filename="jinshan-private.xls",
        parser="jinshan_xls",
        nature="民办",
    ),
]


def clean(value: object) -> str:
    text = "" if value is None else str(value)
    text = text.replace("\u3000", " ")
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"\.0$", "", text)
    return text.strip()


def looks_like_address(value: str) -> bool:
    return bool(re.search(r"[路街道弄号村镇巷]", value)) and not re.search(
        r"学校地址|学校名称|校舍|面积|师资|招生|学区", value
    )


def infer_stage(*values: str) -> str:
    text = " ".join(values)
    if re.search(r"小学|幼升小", text):
        return "primary"
    if re.search(r"初中|中学|小升初|完全中学", text):
        return "middle"
    return "unknown"


def normalize_address(value: str) -> str:
    return (
        clean(value)
        .replace("—", "-")
        .replace("～", "-")
        .replace(" ：", "：")
        .replace("；", ";")
    )


def split_multi_address(address: str) -> str:
    # Keep multi-campus official addresses in one field, but normalize line joins.
    return re.sub(r"\s*;\s*", "；", normalize_address(address))


def record(
    attachment: Attachment,
    name: str,
    address: str,
    nature: str,
    stage_hint: str = "",
):
    name = clean(name)
    address = split_multi_address(address)
    nature = clean(nature or attachment.nature)
    if not name or not looks_like_address(address):
        return None
    if re.search(r"学校名称|学校全称|合计|序号|备注|辅读", name):
        return None
    return {
        "district": attachment.district,
        "stage": infer_stage(stage_hint, name, nature),
        "name": name,
        "campus": "",
        "nature": nature,
        "address": address,
        "sourceTitle": attachment.title,
        "sourceUrl": attachment.url,
    }


def iter_pdf_tables(path: Path) -> Iterable[list[list[str]]]:
    try:
        import pdfplumber
    except ImportError as exc:
        raise SystemExit(
            "pdfplumber is required. Install it in an isolated env, e.g. "
            "python3 -m venv .tmp/data-parse-venv && "
            ". .tmp/data-parse-venv/bin/activate && pip install pdfplumber xlrd"
        ) from exc

    with pdfplumber.open(str(path)) as pdf:
        for page in pdf.pages:
            for table in page.extract_tables() or []:
                rows = [[clean(cell) for cell in row] for row in table]
                if rows:
                    yield rows


def parse_jiading_pdf(path: Path, attachment: Attachment) -> list[dict]:
    records: list[dict] = []
    for rows in iter_pdf_tables(path):
        for row in rows:
            if len(row) < 3:
                continue
            if attachment.nature == "民办":
                name = row[0]
                address = row[1]
                stage = row[2] if len(row) > 2 else ""
            else:
                name = row[1]
                address = row[2]
                stage = row[3] if len(row) > 3 else ""
            if not name and records and looks_like_address(address):
                # Continuation rows in nine-year schools carry an additional
                # stage/address but not a repeated school name. The DB stores
                # primary/middle departments as separate school rows, so the
                # previous full school name is still the correct match target.
                name = records[-1]["name"]
            item = record(attachment, name, address, attachment.nature, stage)
            if item:
                records.append(item)
    return records


def parse_songjiang_pdf(path: Path, attachment: Attachment) -> list[dict]:
    records: list[dict] = []
    for rows in iter_pdf_tables(path):
        for row in rows:
            if len(row) < 4:
                continue
            item = record(attachment, row[1], row[3], row[2], row[2])
            if item:
                records.append(item)
    return records


def parse_jinshan_xls(path: Path, attachment: Attachment) -> list[dict]:
    try:
        import xlrd
    except ImportError as exc:
        raise SystemExit(
            "xlrd is required. Install it in an isolated env, e.g. "
            "python3 -m venv .tmp/data-parse-venv && "
            ". .tmp/data-parse-venv/bin/activate && pip install pdfplumber xlrd"
        ) from exc

    records: list[dict] = []
    book = xlrd.open_workbook(str(path))
    seen_sheet_names: set[str] = set()
    for sheet in book.sheets():
        if sheet.name in seen_sheet_names:
            continue
        seen_sheet_names.add(sheet.name)
        for idx in range(sheet.nrows):
            row = [clean(sheet.cell_value(idx, col)) for col in range(sheet.ncols)]
            if len(row) < 4:
                continue
            item = record(attachment, row[2], row[3], attachment.nature, row[2])
            if item:
                records.append(item)
    return records


def download(attachment: Attachment) -> Path:
    ATTACHMENT_DIR.mkdir(parents=True, exist_ok=True)
    path = ATTACHMENT_DIR / attachment.filename
    if path.exists() and path.stat().st_size > 0:
        return path
    request = urllib.request.Request(attachment.url, headers={"User-Agent": "school-info-collector/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        path.write_bytes(response.read())
    return path


def load_existing_records() -> list[dict]:
    latest = OUT_DIR / "latest.json"
    if not latest.exists():
        return []
    data = json.loads(latest.read_text("utf-8"))
    return list(data.get("records", []))


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    all_records = load_existing_records()
    links = []
    errors = []

    for attachment in ATTACHMENTS:
        try:
            path = download(attachment)
            if attachment.parser == "jiading_pdf":
                parsed = parse_jiading_pdf(path, attachment)
            elif attachment.parser == "songjiang_pdf":
                parsed = parse_songjiang_pdf(path, attachment)
            elif attachment.parser == "jinshan_xls":
                parsed = parse_jinshan_xls(path, attachment)
            else:
                raise ValueError(f"Unknown parser: {attachment.parser}")
            all_records.extend(parsed)
            links.append(
                {
                    "district": attachment.district,
                    "title": attachment.title,
                    "url": attachment.url,
                    "parser": attachment.parser,
                    "records": len(parsed),
                }
            )
            print(f"{attachment.district}: {attachment.title} -> records={len(parsed)}")
        except Exception as exc:  # noqa: BLE001 - report and continue for review artifact
            errors.append({"url": attachment.url, "title": attachment.title, "error": repr(exc)})
            print(f"ERROR {attachment.url}: {exc}", file=sys.stderr)

    dedup: dict[str, dict] = {}
    for item in all_records:
        key = f"{item['district']}:{item['stage']}:{item['name']}:{item['address']}:{item['sourceUrl']}"
        dedup[key] = item

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    out = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": "www.shanghai.gov.cn district义务教育招生栏目 + official attachments",
        "linkCount": len(links),
        "recordCount": len(dedup),
        "links": links,
        "records": list(dedup.values()),
        "errors": errors,
    }
    target = OUT_DIR / f"official-school-info-with-attachments-{stamp}.json"
    latest = OUT_DIR / "latest-with-attachments.json"
    target.write_text(json.dumps(out, ensure_ascii=False, indent=2), "utf-8")
    latest.write_text(json.dumps(out, ensure_ascii=False, indent=2), "utf-8")
    print(f"Output: {target}")
    print(f"Latest: {latest}")
    print(f"Done. records={len(dedup)}, errors={len(errors)}")
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
