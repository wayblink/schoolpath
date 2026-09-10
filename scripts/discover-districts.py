#!/usr/bin/env python3
"""
Phase 1: 找 16 区招生政策 + 对口居委表 在本地宝 sh.bendibao.com 的 URL

策略: 用 360 搜索 "<区>区 2025 招生入学" + "对口居委"，提取本地宝目标 URL
"""
import re
import time
import urllib.parse
import urllib.request

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

DISTRICTS = [
    "黄浦", "徐汇", "长宁", "静安", "普陀", "虹口", "杨浦", "浦东",
    "闵行", "宝山", "嘉定", "金山", "松江", "青浦", "奉贤", "崇明",
]

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=12) as r:
            return r.read().decode("utf-8", errors="ignore")
    except Exception as e:
        return f"<err {e}>"

def extract_so_links(html):
    # 360 结果里的 so.com/link 跳转 (宽松 regex 处理 a 标签里多 attr)
    pattern = re.compile(
        r'<a\s+(?:[^>]+\s)?href="(https?://www\.so\.com/link\?[^"]+)"[^>]*>(.*?)</a>',
        re.DOTALL,
    )
    out = []
    for m in pattern.finditer(html):
        url = m.group(1)
        title = re.sub(r'<[^>]+>|\s+', ' ', m.group(2)).strip()
        if len(title) < 8:
            continue
        out.append((title, url))
    return out

def follow_redirect(url):
    # 跟 360 link 跳转到目标 URL
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "identity"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.geturl()
    except Exception:
        return None

def main():
    results = {}
    for d in DISTRICTS:
        print(f"\n=== {d} ===")
        for query_kind, query_text in [
            ("policy", f"2025上海{d}区义务教育招生入学政策 本地宝"),
            ("matching", f"2025上海{d}区小学对口地段表 本地宝"),
        ]:
            encoded = urllib.parse.quote(query_text)
            html = fetch(f"https://www.so.com/s?q={encoded}")
            links = extract_so_links(html)
            relevant = [
                (t, u) for t, u in links
                if (d in t or d + "区" in t) and ("本地宝" in t or "bendibao" in u)
            ]
            for title, so_url in relevant[:2]:
                target = follow_redirect(so_url)
                if target and "bendibao" in target:
                    print(f"  [{query_kind}] {title[:50]} -> {target}")
                    results.setdefault(d, {}).setdefault(query_kind, target)
                    break
            time.sleep(2)
    print("\n\n=== summary ===")
    for d in DISTRICTS:
        r = results.get(d, {})
        print(f"  {d}: policy={r.get('policy', '—')[:70]}")
        print(f"         matching={r.get('matching', '—')[:70]}")
    import json
    with open("districts-urls.json", "w") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print("\n✓ saved districts-urls.json")

if __name__ == "__main__":
    main()
