import { getConfig } from "./config.js";

const SELF_HEAL_MIN_UPTIME_SEC = 300;
const SELF_HEAL_EXIT_DELAY_MS = 2000;
let restartScheduled = false;

export function isRestartScheduled(): boolean {
  return restartScheduled;
}

export function maybeSelfRestart(): void {
  if (restartScheduled) return;
  if (!getConfig().AUTO_RESTART_ON_AUTH_ERROR) return;
  if (process.uptime() < SELF_HEAL_MIN_UPTIME_SEC) {
    console.error(
      `[self-heal] code 16 within ${Math.round(process.uptime())}s of startup — likely a real auth failure, NOT restarting to avoid a crash loop.`,
    );
    return;
  }
  restartScheduled = true;
  console.error(
    `[self-heal] Cursor SDK client unauthenticated (code 16). Restarting process in ${SELF_HEAL_EXIT_DELAY_MS}ms so PM2 brings up a clean one.`,
  );
  setTimeout(() => process.exit(1), SELF_HEAL_EXIT_DELAY_MS);
}
