import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { pool } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DISTRICTS = new Set([
  "徐汇", "黄浦", "长宁", "静安", "普陀", "虹口", "杨浦", "浦东",
  "闵行", "宝山", "嘉定", "金山", "松江", "青浦", "奉贤", "崇明",
]);

const JOB_DIR = path.join(process.cwd(), ".tmp", "school-location-backfill-jobs");
const LOCK_PATH = path.join(JOB_DIR, "active.lock.json");
const MAX_CONTINUOUS_ROUNDS = 500;

type JobStatus = "running" | "succeeded" | "failed" | "stopped";
type LockRecord = {
  pid?: number;
  childPid?: number;
  jobId?: string;
  startedAt?: string;
};

type JobRecord = {
  id: string;
  status: JobStatus;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
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
  rounds?: Array<{
    round: number;
    exitCode: number | null;
    target?: number;
    matched?: number;
    updated?: number;
    attemptedIds: number[];
    remainingMissing?: number;
  }>;
  stopReason?: string;
  error?: string;
};

function ensureJobDir() {
  mkdirSync(JOB_DIR, { recursive: true });
}

function jobPath(jobId: string) {
  return path.join(JOB_DIR, `${jobId}.json`);
}

function logPath(jobId: string) {
  return path.join(JOB_DIR, `${jobId}.log`);
}

function stopPath(jobId: string) {
  return path.join(JOB_DIR, `${jobId}.stop`);
}

function writeJob(job: JobRecord) {
  writeFileSync(jobPath(job.id), JSON.stringify(job, null, 2), "utf8");
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function descendantPids(pid: number) {
  const result = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  if (result.status !== 0) return [];
  const children = new Map<number, number[]>();
  for (const line of result.stdout.split("\n")) {
    const [pidText, ppidText] = line.trim().split(/\s+/);
    const childPid = Number(pidText);
    const parentPid = Number(ppidText);
    if (!Number.isInteger(childPid) || !Number.isInteger(parentPid)) continue;
    const list = children.get(parentPid) ?? [];
    list.push(childPid);
    children.set(parentPid, list);
  }

  const descendants: number[] = [];
  const stack = [...(children.get(pid) ?? [])];
  while (stack.length > 0) {
    const childPid = stack.pop()!;
    descendants.push(childPid);
    stack.push(...(children.get(childPid) ?? []));
  }
  return descendants;
}

function terminateProcessTree(pid: number) {
  const targets = [...descendantPids(pid), pid].filter((target) => target !== process.pid);
  for (const target of targets) {
    if (!isProcessAlive(target)) continue;
    try {
      process.kill(target, "SIGTERM");
    } catch {
      // Process may have exited between listing and kill.
    }
  }
}

function terminateMatchingJobProcesses(job: JobRecord) {
  const result = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  if (result.status !== 0) return;
  const requiredArgs = job.args.slice(2);
  for (const line of result.stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2];
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    if (!command.includes("scripts/backfill-school-locations-baidu-browser.ts")) continue;
    if (!requiredArgs.every((arg) => command.includes(arg))) continue;
    terminateProcessTree(pid);
  }
}

function activeLock() {
  if (!existsSync(LOCK_PATH)) return null;
  const lock = readJson<LockRecord>(LOCK_PATH);
  const job = lock?.jobId ? readJson<JobRecord>(jobPath(lock.jobId)) : null;
  if (!lock?.pid || !lock.jobId || job?.status !== "running" || !isProcessAlive(lock.pid)) {
    rmSync(LOCK_PATH, { force: true });
    return null;
  }
  return lock;
}

function readLogTail(filePath: string, maxChars = 12000) {
  try {
    const text = readFileSync(filePath, "utf8");
    return text.length > maxChars ? text.slice(text.length - maxChars) : text;
  } catch {
    return "";
  }
}

function parsePositiveNumber(value: unknown, fallback: number, max: number) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1, Math.min(max, Math.floor(number)));
}

function parseSummary(logText: string): JobRecord["summary"] {
  const match = logText.match(/Done\. matched=(\d+), updated=(\d+), apply=(true|false)/);
  if (!match) return undefined;
  const target = logText.match(/Target schools: (\d+)/);
  return {
    matched: Number(match[1]),
    updated: Number(match[2]),
    apply: match[3] === "true",
    target: target ? Number(target[1]) : undefined,
  };
}

function parseAttemptedIds(logText: string) {
  const match = logText.match(/Attempted school ids: ([^\n]+)/);
  if (!match || match[1].trim() === "none") return [];
  return match[1]
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function safeJobId(value: string | null) {
  if (!value || !/^[a-zA-Z0-9._-]+$/.test(value)) return null;
  return value;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendLog(filePath: string, text: string) {
  writeFileSync(filePath, text, { flag: "a" });
}

function isStopRequested(jobId: string) {
  return existsSync(stopPath(jobId));
}

function clampInterval(value: unknown) {
  return parsePositiveNumber(value, 30, 3600);
}

async function countMissingSchools(district: string | null, schoolId: number | null) {
  const params: Array<string | number> = [];
  const where = ["(address IS NULL OR btrim(address) = '' OR lat IS NULL OR lng IS NULL)"];
  if (district) {
    params.push(district);
    where.push(`district = $${params.length}`);
  }
  if (schoolId) {
    params.push(schoolId);
    where.push(`id = $${params.length}`);
  }
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM schools WHERE ${where.join(" AND ")}`,
    params,
  );
  return Number(result.rows[0]?.count ?? 0);
}

function runScript(job: JobRecord, args: string[], outputLogPath: string) {
  return new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; log: string }>((resolve, reject) => {
    let localLog = "";
    const child = spawn("pnpm", args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    writeFileSync(
      LOCK_PATH,
      JSON.stringify({ jobId: job.id, pid: process.pid, childPid: child.pid, startedAt: job.startedAt }, null, 2),
      "utf8",
    );

    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      localLog += text;
      appendLog(outputLogPath, text);
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      resolve({ exitCode, signal, log: localLog });
    });
  });
}

export async function DELETE(request: Request) {
  ensureJobDir();
  const url = new URL(request.url);
  const jobId = safeJobId(url.searchParams.get("jobId"));
  if (!jobId) {
    return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  }

  const job = readJson<JobRecord>(jobPath(jobId));
  if (!job) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }
  if (job.status !== "running") {
    return NextResponse.json({ job, log: readLogTail(job.logPath) });
  }

  writeFileSync(stopPath(jobId), new Date().toISOString(), "utf8");
  appendLog(job.logPath, "\nSTOP requested by user.\n");

  const lock = activeLock();
  const pidToKill = lock?.jobId === jobId ? lock.childPid ?? lock.pid : undefined;
  if (pidToKill && pidToKill !== process.pid && isProcessAlive(pidToKill)) {
    terminateProcessTree(pidToKill);
  }
  terminateMatchingJobProcesses(job);

  return NextResponse.json({ job: { ...job, stopReason: "正在终止任务" }, log: readLogTail(job.logPath) });
}

export async function GET(request: Request) {
  ensureJobDir();
  const url = new URL(request.url);
  const jobId = safeJobId(url.searchParams.get("jobId"));

  if (jobId) {
    const job = readJson<JobRecord>(jobPath(jobId));
    if (!job) {
      return NextResponse.json({ error: "job not found" }, { status: 404 });
    }
    return NextResponse.json({ job, log: readLogTail(job.logPath) });
  }

  const lock = activeLock();
  const latest = (() => {
    try {
      return readdirSync(JOB_DIR)
        .filter((name) => name.endsWith(".json") && name !== "active.lock.json")
        .sort()
        .reverse()
        .slice(0, 40);
    } catch {
      return [];
    }
  })()
    .filter(Boolean)
    .map((name) => readJson<JobRecord>(path.join(JOB_DIR, name!)))
    .filter((job): job is JobRecord => Boolean(job));

  return NextResponse.json({ active: lock, jobs: latest });
}

export async function POST(request: Request) {
  ensureJobDir();

  const existing = activeLock();
  if (existing) {
    return NextResponse.json(
      { error: "已有补数据任务在运行", activeJobId: existing.jobId },
      { status: 409 },
    );
  }

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const districtRaw = typeof body.district === "string" ? body.district.trim() : "";
  const district = districtRaw && districtRaw !== "全市" ? districtRaw.replace(/区$/, "") : null;
  if (district && !DISTRICTS.has(district)) {
    return NextResponse.json({ error: "district 不在白名单内" }, { status: 400 });
  }

  const limit = parsePositiveNumber(body.limit, 5, 20);
  const minScore = parsePositiveNumber(body.minScore, 70, 500);
  const intervalSeconds = clampInterval(body.intervalSeconds);
  const schoolId = body.schoolId == null || body.schoolId === ""
    ? null
    : parsePositiveNumber(body.schoolId, 0, 10_000_000);
  const apply = body.apply === true;
  const continuous = body.continuous === true;

  if (schoolId === 0) {
    return NextResponse.json({ error: "schoolId 必须是正整数" }, { status: 400 });
  }

  const jobId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const outputLogPath = logPath(jobId);
  const args = [
    "tsx",
    "scripts/backfill-school-locations-baidu-browser.ts",
    `--limit=${limit}`,
    `--min-score=${minScore}`,
  ];
  if (district) args.push(`--district=${district}`);
  if (schoolId) args.push(`--school-id=${schoolId}`);
  if (apply) args.push("--apply");

  const job: JobRecord = {
    id: jobId,
    status: "running",
    startedAt: new Date().toISOString(),
    apply,
    continuous,
    intervalSeconds,
    district,
    limit,
    minScore,
    schoolId,
    args,
    logPath: outputLogPath,
  };

  writeJob(job);
  rmSync(stopPath(job.id), { force: true });
  writeFileSync(outputLogPath, `$ pnpm ${args.join(" ")}\n\n`, "utf8");

  if (!continuous) {
    const child = spawn("pnpm", args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    writeFileSync(
      LOCK_PATH,
      JSON.stringify({ jobId, pid: child.pid, startedAt: job.startedAt }, null, 2),
      "utf8",
    );

    child.stdout.on("data", (chunk: Buffer) => appendLog(outputLogPath, chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => appendLog(outputLogPath, chunk.toString("utf8")));
    child.on("error", (error) => {
      const next: JobRecord = {
        ...job,
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: error.message,
      };
      appendLog(outputLogPath, `\nPROCESS_ERROR ${error.message}\n`);
      writeJob(next);
      rmSync(LOCK_PATH, { force: true });
    });
    child.on("close", (exitCode, signal) => {
      const logText = readLogTail(outputLogPath, 200_000);
      const summary = parseSummary(logText);
      const stopped = isStopRequested(job.id);
      const next: JobRecord = {
        ...job,
        status: stopped ? "stopped" : exitCode === 0 ? "succeeded" : "failed",
        finishedAt: new Date().toISOString(),
        exitCode,
        signal,
        stopReason: stopped ? "用户终止任务" : undefined,
        summary,
      };
      writeJob(next);
      rmSync(LOCK_PATH, { force: true });
    });
  } else {
    writeFileSync(
      LOCK_PATH,
      JSON.stringify({ jobId, pid: process.pid, startedAt: job.startedAt }, null, 2),
      "utf8",
    );

    void runContinuousJob(job, args, outputLogPath);
  }

  return NextResponse.json({ job, log: readLogTail(outputLogPath) }, { status: 202 });
}

async function runContinuousJob(job: JobRecord, baseArgs: string[], outputLogPath: string) {
  const attempted = new Set<number>();
  const rounds: NonNullable<JobRecord["rounds"]> = [];
  let totalMatched = 0;
  let totalUpdated = 0;
  let finalExitCode: number | null = 0;
  let finalSignal: NodeJS.Signals | null = null;
  let stopReason = "";

  try {
    appendLog(
      outputLogPath,
      `\nCONTINUOUS mode enabled: interval=${job.intervalSeconds}s, maxRounds=${MAX_CONTINUOUS_ROUNDS}\n`,
    );

    for (let round = 1; round <= MAX_CONTINUOUS_ROUNDS; round++) {
      if (isStopRequested(job.id)) {
        stopReason = "用户终止任务";
        break;
      }

      const roundArgs = [...baseArgs];
      if (attempted.size > 0) roundArgs.push(`--skip-ids=${[...attempted].join(",")}`);

      appendLog(outputLogPath, `\n========== ROUND ${round} ==========\n$ pnpm ${roundArgs.join(" ")}\n\n`);
      const result = await runScript(job, roundArgs, outputLogPath);
      finalExitCode = result.exitCode;
      finalSignal = result.signal;
      const stopped = isStopRequested(job.id);

      const summary = parseSummary(result.log);
      const attemptedIds = parseAttemptedIds(result.log);
      for (const id of attemptedIds) attempted.add(id);

      totalMatched += summary?.matched ?? 0;
      totalUpdated += summary?.updated ?? 0;

      let remainingMissing: number | undefined;
      try {
        remainingMissing = await countMissingSchools(job.district, job.schoolId);
      } catch (error) {
        appendLog(outputLogPath, `\nCOUNT_MISSING_ERROR ${error instanceof Error ? error.message : String(error)}\n`);
      }

      rounds.push({
        round,
        exitCode: result.exitCode,
        target: summary?.target,
        matched: summary?.matched,
        updated: summary?.updated,
        attemptedIds,
        remainingMissing,
      });

      const runningJob: JobRecord = {
        ...job,
        rounds,
        summary: {
          matched: totalMatched,
          updated: totalUpdated,
          apply: job.apply,
          target: summary?.target,
          remainingMissing,
          rounds: round,
          attempted: attempted.size,
        },
      };
      writeJob(runningJob);

      if (stopped) {
        stopReason = "用户终止任务";
        break;
      }
      if (result.exitCode !== 0) {
        stopReason = `第 ${round} 轮失败，已停止`;
        break;
      }
      if (remainingMissing === 0) {
        stopReason = "已补完：当前范围没有缺地址或坐标的学校";
        break;
      }
      if ((summary?.target ?? 0) === 0) {
        stopReason = "本轮候选已全部尝试，剩余缺失项未命中或低于最低分";
        break;
      }

      appendLog(outputLogPath, `\nROUND ${round} done. waiting ${job.intervalSeconds}s...\n`);
      const sleepUntil = Date.now() + job.intervalSeconds * 1000;
      while (Date.now() < sleepUntil) {
        if (isStopRequested(job.id)) {
          stopReason = "用户终止任务";
          break;
        }
        await sleep(Math.min(1000, sleepUntil - Date.now()));
      }
      if (stopReason) break;
    }

    if (!stopReason) stopReason = `达到最大轮数 ${MAX_CONTINUOUS_ROUNDS}，已停止`;
    const stopped = stopReason === "用户终止任务";

    const next: JobRecord = {
      ...job,
      status: stopped ? "stopped" : finalExitCode === 0 ? "succeeded" : "failed",
      finishedAt: new Date().toISOString(),
      exitCode: finalExitCode,
      signal: finalSignal,
      rounds,
      stopReason,
      summary: {
        matched: totalMatched,
        updated: totalUpdated,
        apply: job.apply,
        remainingMissing: rounds.at(-1)?.remainingMissing,
        rounds: rounds.length,
        attempted: attempted.size,
      },
    };
    appendLog(outputLogPath, `\nCONTINUOUS done. ${stopReason}\n`);
    writeJob(next);
  } catch (error) {
    const next: JobRecord = {
      ...job,
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      rounds,
      summary: {
        matched: totalMatched,
        updated: totalUpdated,
        apply: job.apply,
        rounds: rounds.length,
        attempted: attempted.size,
      },
    };
    appendLog(outputLogPath, `\nCONTINUOUS_ERROR ${next.error}\n`);
    writeJob(next);
  } finally {
    rmSync(LOCK_PATH, { force: true });
  }
}
