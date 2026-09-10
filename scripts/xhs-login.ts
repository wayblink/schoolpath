/**
 * 一次性登录小红书并把会话状态固化到 .tmp/xhs-profile/。
 *
 * 用法：
 *   pnpm xhs:login
 *
 * 启动一个 headed Chromium，打开小红书首页，扫码 / 短信登录完成后回到
 * 终端按 Enter，脚本会优雅关闭浏览器，Chromium 会把 cookies / localStorage
 * / IndexedDB 全部刷到 .tmp/xhs-profile/ 目录。后续 xhs-collect.ts 直接
 * launchPersistentContext 同一目录即可复用登录态，避免反复扫码。
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { chromium } from "playwright";

const PROFILE_DIR = path.join(process.cwd(), ".tmp", "xhs-profile");
const ENTRY_URL = "https://www.xiaohongshu.com/explore";

async function waitForEnter(prompt: string) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<void>((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  mkdirSync(PROFILE_DIR, { recursive: true });
  console.log(`[xhs-login] profile dir: ${PROFILE_DIR}`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(ENTRY_URL, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((err) => {
    console.warn(`[xhs-login] initial navigation warning: ${(err as Error).message}`);
  });

  console.log("\n[xhs-login] 请在弹出的浏览器里完成扫码 / 短信登录。");
  console.log("[xhs-login] 登录完成后回到此终端按 Enter 退出，登录态会自动保存。\n");

  await waitForEnter("Press <Enter> when logged in...");

  await context.close();
  console.log(`[xhs-login] saved. 后续可运行: pnpm xhs:collect ...`);
}

main().catch((err) => {
  console.error("[xhs-login] fatal:", err);
  process.exit(1);
});
