"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, MapPin, Play, RefreshCw, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

const DISTRICTS = [
  "全市",
  "徐汇", "黄浦", "长宁", "静安", "普陀", "虹口", "杨浦", "浦东",
  "闵行", "宝山", "嘉定", "金山", "松江", "青浦", "奉贤", "崇明",
];

type JobStatus = "running" | "succeeded" | "failed" | "stopped";

type BackfillJob = {
  id: string;
  status: JobStatus;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  apply: boolean;
  continuous: boolean;
  intervalSeconds: number;
  district: string | null;
  limit: number;
  minScore: number;
  schoolId: number | null;
  args: string[];
  logPath: string;
  summary?: {
    matched?: number;
    updated?: number;
    apply?: boolean;
    target?: number;
    remainingMissing?: number;
    rounds?: number;
    attempted?: number;
  };
  stopReason?: string;
  error?: string;
};

type JobsResp = {
  active: { jobId: string; pid: number; startedAt: string } | null;
  jobs: BackfillJob[];
};

type JobResp = {
  job: BackfillJob;
  log: string;
};

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `请求失败 (${res.status})`);
  }
  return res.json() as Promise<T>;
}

function formatTime(value: string | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function statusLabel(status: JobStatus) {
  if (status === "running") return "运行中";
  if (status === "succeeded") return "完成";
  if (status === "stopped") return "已终止";
  return "失败";
}

function StatusIcon({ status }: { status: JobStatus }) {
  if (status === "running") return <RefreshCw size={14} className="animate-spin text-[var(--color-accent)]" />;
  if (status === "succeeded") return <CheckCircle2 size={14} className="text-[var(--color-success)]" />;
  if (status === "stopped") return <XCircle size={14} className="text-[var(--color-warning)]" />;
  return <XCircle size={14} className="text-[var(--color-danger)]" />;
}

export function SchoolLocationBackfillPanel() {
  const queryClient = useQueryClient();
  const [district, setDistrict] = useState("全市");
  const [limit, setLimit] = useState(5);
  const [minScore, setMinScore] = useState(70);
  const [continuous, setContinuous] = useState(false);
  const [intervalSeconds, setIntervalSeconds] = useState(30);
  const [schoolId, setSchoolId] = useState("");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const jobsQuery = useQuery({
    queryKey: ["school-location-backfill-jobs"],
    queryFn: () => fetchJson<JobsResp>("/api/admin/school-location-backfill"),
    refetchInterval: (query) => query.state.data?.active ? 2500 : false,
  });

  const activeJobId = jobsQuery.data?.active?.jobId ?? null;
  const effectiveJobId = selectedJobId ?? activeJobId ?? jobsQuery.data?.jobs[0]?.id ?? null;

  const jobQuery = useQuery({
    queryKey: ["school-location-backfill-job", effectiveJobId],
    enabled: Boolean(effectiveJobId),
    queryFn: () => fetchJson<JobResp>(`/api/admin/school-location-backfill?jobId=${effectiveJobId}`),
    refetchInterval: (query) => query.state.data?.job.status === "running" ? 1800 : false,
  });

  const startMutation = useMutation({
    mutationFn: (apply: boolean) => fetchJson<JobResp>("/api/admin/school-location-backfill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apply,
        district,
        limit,
        minScore,
        continuous,
        intervalSeconds,
        schoolId: schoolId.trim() || null,
      }),
    }),
    onSuccess: (data) => {
      setSelectedJobId(data.job.id);
      void queryClient.invalidateQueries({ queryKey: ["school-location-backfill-jobs"] });
    },
  });

  const stopMutation = useMutation({
    mutationFn: (jobId: string) => fetchJson<JobResp>(`/api/admin/school-location-backfill?jobId=${jobId}`, {
      method: "DELETE",
    }),
    onSuccess: (data) => {
      setSelectedJobId(data.job.id);
      void queryClient.invalidateQueries({ queryKey: ["school-location-backfill-jobs"] });
      void queryClient.invalidateQueries({ queryKey: ["school-location-backfill-job", data.job.id] });
    },
  });

  const currentJob = jobQuery.data?.job;
  const log = jobQuery.data?.log ?? "";
  const running = currentJob?.status === "running" || startMutation.isPending || Boolean(activeJobId);
  const recentJobs = useMemo(() => jobsQuery.data?.jobs ?? [], [jobsQuery.data?.jobs]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-bg)]">
      <div className="shrink-0 border-b border-[var(--color-panel-border)] bg-[var(--color-panel-bg)] px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[15px] font-semibold text-[var(--color-text)]">
              <MapPin size={16} className="text-[var(--color-accent)]" />
              学校地点补全
            </div>
            <div className="mt-1 text-xs text-[var(--color-text-muted)]">
              使用后台 Playwright 调用百度地图，写入 GCJ-02 坐标，供产品内高德地图使用。
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              void jobsQuery.refetch();
              void jobQuery.refetch();
            }}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] px-3 text-[12px] text-[var(--color-text-dim)] hover:bg-[var(--color-control-hover)]"
          >
            <RefreshCw size={13} />
            刷新
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[340px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-r border-[var(--color-panel-border)] bg-[var(--color-panel-bg)]">
          <div className="grid gap-3 border-b border-[var(--color-panel-border)] p-3">
            <label className="grid gap-1.5">
              <span className="text-[11px] text-[var(--color-text-muted)]">范围</span>
              <select
                value={district}
                onChange={(event) => setDistrict(event.target.value)}
                disabled={running}
                className="h-9 rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] px-2.5 text-[13px] text-[var(--color-text)] disabled:opacity-60"
              >
                {DISTRICTS.map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
            </label>

            <div className="grid grid-cols-2 gap-2">
              <label className="grid gap-1.5">
                <span className="text-[11px] text-[var(--color-text-muted)]">批量上限</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={limit}
                  onChange={(event) => setLimit(Number(event.target.value))}
                  disabled={running}
                  className="h-9 rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] px-2.5 text-[13px] text-[var(--color-text)] disabled:opacity-60"
                />
              </label>
              <label className="grid gap-1.5">
                <span className="text-[11px] text-[var(--color-text-muted)]">最低分</span>
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={minScore}
                  onChange={(event) => setMinScore(Number(event.target.value))}
                  disabled={running}
                  className="h-9 rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] px-2.5 text-[13px] text-[var(--color-text)] disabled:opacity-60"
                />
              </label>
            </div>

            <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-2">
              <label className="flex h-9 items-center gap-2 rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] px-2.5 text-[12px] text-[var(--color-text-dim)]">
                <input
                  type="checkbox"
                  checked={continuous}
                  onChange={(event) => setContinuous(event.target.checked)}
                  disabled={running}
                  className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                />
                持续执行直到补完
              </label>
              <label className="grid gap-1">
                <span className="sr-only">间隔秒数</span>
                <input
                  type="number"
                  min={5}
                  max={3600}
                  value={intervalSeconds}
                  onChange={(event) => setIntervalSeconds(Number(event.target.value))}
                  disabled={running || !continuous}
                  title="每轮间隔秒数"
                  className="h-9 rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] px-2.5 text-[13px] text-[var(--color-text)] disabled:opacity-60"
                />
              </label>
            </div>

            <label className="grid gap-1.5">
              <span className="text-[11px] text-[var(--color-text-muted)]">指定学校 ID</span>
              <input
                type="number"
                min={1}
                value={schoolId}
                onChange={(event) => setSchoolId(event.target.value)}
                disabled={running}
                placeholder="可留空"
                className="h-9 rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] px-2.5 text-[13px] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] disabled:opacity-60"
              />
            </label>

            <div className="rounded-md border border-[var(--color-warning)]/35 bg-[var(--color-warning)]/10 p-2.5 text-[11px] leading-5 text-[var(--color-warning)]">
              <div className="mb-1 flex items-center gap-1.5 font-medium">
                <AlertTriangle size={13} />
                写库前先试运行
              </div>
              每轮只跑小批量。持续模式会跳过本轮已尝试未命中的学校，遇到百度验证码时任务会停止。
            </div>

            {startMutation.isError && (
              <div className="rounded-md border border-[var(--color-danger)]/25 bg-[var(--color-danger)]/10 px-2.5 py-2 text-[12px] text-[var(--color-danger)]">
                {(startMutation.error as Error).message}
              </div>
            )}
            {stopMutation.isError && (
              <div className="rounded-md border border-[var(--color-danger)]/25 bg-[var(--color-danger)]/10 px-2.5 py-2 text-[12px] text-[var(--color-danger)]">
                {(stopMutation.error as Error).message}
              </div>
            )}

            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                disabled={running}
                onClick={() => startMutation.mutate(false)}
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-[var(--color-control-border)] bg-[var(--color-control-bg)] px-3 text-[12px] text-[var(--color-text-dim)] hover:bg-[var(--color-control-hover)] disabled:opacity-50"
              >
                <Play size={13} />
                试运行
              </button>
              <button
                type="button"
                disabled={running}
                onClick={() => startMutation.mutate(true)}
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-[var(--color-accent-border)] bg-[var(--color-panel-accent)] px-3 text-[12px] font-medium text-white shadow-sm disabled:opacity-50"
              >
                <MapPin size={13} />
                {continuous ? "持续补齐" : "补齐坐标"}
              </button>
              <button
                type="button"
                disabled={!activeJobId || stopMutation.isPending}
                onClick={() => activeJobId && stopMutation.mutate(activeJobId)}
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-[var(--color-danger)]/35 bg-[var(--color-danger)]/10 px-3 text-[12px] font-medium text-[var(--color-danger)] hover:bg-[var(--color-danger)]/15 disabled:opacity-50"
              >
                <XCircle size={13} />
                终止
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-2">
            <div className="px-1 pb-2 text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">
              最近任务
            </div>
            {jobsQuery.isLoading ? (
              <div className="px-2 py-3 text-[12px] text-[var(--color-text-muted)]">加载任务…</div>
            ) : recentJobs.length === 0 ? (
              <div className="px-2 py-3 text-[12px] text-[var(--color-text-muted)]">暂无任务</div>
            ) : (
              <div className="space-y-1">
                {recentJobs.map((job) => {
                  const active = effectiveJobId === job.id;
                  return (
                    <button
                      key={job.id}
                      type="button"
                      onClick={() => setSelectedJobId(job.id)}
                      className={cn(
                        "w-full rounded-md border px-2 py-2 text-left text-[12px] transition-colors",
                        active
                          ? "border-[var(--color-card-hover-border)] bg-[var(--color-card-selected-bg)] shadow-[0_0_0_2px_var(--color-selected-ring)]"
                          : "border-transparent text-[var(--color-text-dim)] hover:bg-[var(--color-list-row-hover)]",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate font-mono-tiny">{job.id}</span>
                        <span className="inline-flex shrink-0 items-center gap-1 text-[11px]">
                          <StatusIcon status={job.status} />
                          {statusLabel(job.status)}
                        </span>
                      </div>
                      <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">
                        {job.apply ? "写库" : "试运行"} · {job.continuous ? "持续" : "单批"} · {job.district ?? "全市"} · limit {job.limit} · {formatTime(job.startedAt)}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </aside>

        <section className="flex min-h-0 flex-col">
          <div className="shrink-0 border-b border-[var(--color-panel-border)] bg-[var(--color-bg-elev)] px-4 py-3">
            {currentJob ? (
              <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="inline-flex items-center gap-1.5 font-medium text-[var(--color-text)]">
                    <StatusIcon status={currentJob.status} />
                    {statusLabel(currentJob.status)}
                  </span>
                  <span className="font-mono-tiny text-[var(--color-text-muted)]">{currentJob.id}</span>
                  <span className="text-[var(--color-text-muted)]">
                    {currentJob.apply ? "写库" : "试运行"} · {currentJob.continuous ? `持续 · 间隔 ${currentJob.intervalSeconds}s` : "单批"} · {currentJob.district ?? "全市"} · {formatTime(currentJob.startedAt)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
                  <span>匹配 {currentJob.summary?.matched ?? "—"}</span>
                  <span>更新 {currentJob.summary?.updated ?? "—"}</span>
                  {currentJob.continuous && <span>轮次 {currentJob.summary?.rounds ?? "—"}</span>}
                  {currentJob.continuous && <span>剩余 {currentJob.summary?.remainingMissing ?? "—"}</span>}
                  <span>退出码 {currentJob.exitCode ?? "—"}</span>
                </div>
                {currentJob.stopReason && (
                  <div className="basis-full text-[11px] text-[var(--color-text-muted)]">
                    {currentJob.stopReason}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-xs text-[var(--color-text-muted)]">选择或启动一个任务查看日志。</div>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-auto bg-[var(--color-bg)] p-4">
            <pre className="min-h-full whitespace-pre-wrap rounded-lg border border-[var(--color-panel-border)] bg-[var(--color-bg-elev)] p-3 font-mono text-[11px] leading-5 text-[var(--color-text-dim)]">
              {jobQuery.isLoading ? "加载日志…" : log || "暂无日志"}
            </pre>
          </div>
        </section>
      </div>
    </div>
  );
}
