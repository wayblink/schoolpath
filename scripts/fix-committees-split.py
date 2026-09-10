#!/usr/bin/env python3
"""
已停用：这是 SQLite 时代的历史一次性修复脚本。

当前正式库已经迁移到 PostgreSQL。不要直接修改 data/house.sqlite，也不要把这个脚本作为
正式数据修复入口。需要修复 matching_committees 时，请编写 PostgreSQL 增量脚本，并在写入前
备份、预演、核对影响行数和差异。

Bug: extract-school-mappings.py 之前 split 用 [、，,；;\n]+ 不含 space
     导致 cells 里 "居委A 居委B 居委C" 变成 1 个 item 而不是 3 个

历史 Fix: SQL UPDATE 每个 school 的 matching_committees, 用 re.split 重新拆
"""
raise SystemExit("Refusing to run deprecated SQLite fixer. Write a PostgreSQL incremental migration instead.")

import sqlite3
import json
import re

DB = "/Users/jyxc-dz-0101035/yard/house/data/house.sqlite"

def resplit(items):
    """对每个原 item，如果包含空格 + 居委/小区/号关键字，再拆"""
    out = []
    for s in items:
        s = s.strip()
        if not s:
            continue
        # 用 多个分隔符 re-split: 空白 / 各种逗号顿号 / 换行
        parts = re.split(r'[、，,；;\n\s]+', s)
        for p in parts:
            p = p.strip()
            if len(p) >= 2:
                out.append(p)
    # dedup keep order
    seen = set()
    deduped = []
    for x in out:
        if x not in seen:
            seen.add(x)
            deduped.append(x)
    return deduped

conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row
cur = conn.cursor()

rows = cur.execute("SELECT id, name, attrs FROM schools WHERE district IS NOT NULL").fetchall()
print(f"扫描 {len(rows)} schools")

updates = 0
total_before = 0
total_after = 0
for r in rows:
    attrs = json.loads(r["attrs"] or "{}")
    items = attrs.get("matching_committees") or []
    if not items:
        continue
    before = len(items)
    new_items = resplit(items)
    after = len(new_items)
    if after > before:
        attrs["matching_committees"] = new_items
        conn.execute(
            "UPDATE schools SET attrs = ? WHERE id = ?",
            (json.dumps(attrs, ensure_ascii=False), r["id"]),
        )
        updates += 1
        total_before += before
        total_after += after
        if updates <= 5:
            print(f"  ✓ {r['name'][:30]}: {before} → {after}")

conn.commit()
print(f"\n✓ Done. updated {updates} schools, total committees: {total_before} → {total_after}")
conn.close()
