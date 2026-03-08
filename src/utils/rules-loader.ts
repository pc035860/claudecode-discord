import fs from "node:fs";
import path from "node:path";

// process.cwd() points to project root in both execution modes:
// - production (PM2): cwd is set to project root at startup
// - dev (tsx): npm run dev is executed from project root
const ROOT_DIR = process.cwd();

export function loadBotRules(
  filename = "bot-rules.md",
  basePath?: string
): string | undefined {
  const filePath = path.join(basePath ?? ROOT_DIR, filename);
  try {
    const content = fs.readFileSync(filePath, "utf-8").trim();
    return content || undefined;
  } catch {
    return undefined;
  }
}
