"use client";
import { useEffect, useState } from "react";
import { PencilLine, Search } from "lucide-react";

type SchoolOption = { id: number; name: string; district: string };

const CONFIDENCE = ["high", "medium", "low"] as const;
const CONFIDENCE_LABEL: Record<string, string> = { high: "高（人工核验）", medium: "中", low: "低（待复核）" };

export function ManualEntry() {
  const [q, setQ] = useState("");
  const [options, setOptions] = useState<SchoolOption[]>([]);
  const [schoolId, setSchoolId] = useState<number | null>(null);
  const [schoolLabel, setSchoolLabel] = useState("");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [date, setDate] = useState("");
  const [evidence, setEvidence] = useState("");
  const [confidence, setConfidence] = useState<string>("medium");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  // 学校搜索（防抖 300ms）
  useEffect(() => {
    const keyword = q.trim();
    if (keyword.length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOptions((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/v2/schools?q=${encodeURIComponent(keyword)}&limit=8`, { signal: controller.signal })
        .then((r) => r.json())
        .then((d) =>
          setOptions(
            (d.schools ?? []).map((s: SchoolOption & { district: string }) => ({
              id: s.id,
              name: s.name,
              district: s.district,
            })),
          ),
        )
        .catch(() => {
          if (!controller.signal.aborted) setOptions([]);
        });
    }, 300);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [q]);

  async function submit() {
    setBusy(true);
    setMessage("");
    try {
      if (schoolId == null) throw new Error("请先选择关联学校");
      if (!evidence.trim()) throw new Error("证据说明必填（人工核验的依据）");
      const res = await fetch("/api/ops/manual-sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schoolId,
          title: title.trim() || "人工录入信息源",
          sourceUrl: url.trim() || null,
          sourceDate: date.trim() || null,
          evidence: evidence.trim(),
          confidence,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `插入失败 (${res.status})`);
      setMessage(`已插入 #${body.id}（来源=manual），/sources 页面可见`);
      setTitle("");
      setUrl("");
      setDate("");
      setEvidence("");
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ops-manual" id="ops-manual">
      <div className="ops-panel-head">
        <div>
          <span className="ops-section-kicker">MANUAL ENTRY</span>
          <h2>人工录入</h2>
          <p>由运营者手动补充的学校信息源，source_type=manual，插入后 /sources 页面可见。</p>
        </div>
        <PencilLine size={18} />
      </div>

      <div className="ops-manual-form">
        <label className="ops-manual-school">
          <span>关联学校（必填）</span>
          <div className="ops-manual-search">
            <Search size={13} />
            <input value={schoolLabel || q} onChange={(e) => { setQ(e.target.value); setSchoolLabel(""); setSchoolId(null); }} placeholder="输入学校名搜索（至少 2 字）" />
          </div>
          {options.length > 0 && (
            <ul className="ops-manual-options">
              {options.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSchoolId(s.id);
                      setSchoolLabel(`${s.name}（${s.district}）`);
                      setOptions([]);
                      setQ("");
                    }}
                  >
                    {s.name} <small>{s.district}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </label>
        <label>
          <span>标题</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：2026 招生简章（人工核验）" />
        </label>
        <label>
          <span>来源 URL</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </label>
        <label>
          <span>来源日期</span>
          <input value={date} onChange={(e) => setDate(e.target.value)} placeholder="如 2026-06" />
        </label>
        <label className="ops-manual-confidence">
          <span>置信度</span>
          <select value={confidence} onChange={(e) => setConfidence(e.target.value)}>
            {CONFIDENCE.map((c) => (
              <option key={c} value={c}>
                {CONFIDENCE_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="ops-manual-evidence">
          <span>证据说明（必填）</span>
          <textarea value={evidence} onChange={(e) => setEvidence(e.target.value)} rows={3} placeholder="人工核验的依据，如：电话确认 / 现场公示照片 / 校方邮件" />
        </label>
        <button type="button" className="ops-manual-submit" disabled={busy} onClick={submit}>
          <PencilLine size={13} /> 插入信息源
        </button>
      </div>

      {message && <div className="ops-message">{message}</div>}
    </section>
  );
}
