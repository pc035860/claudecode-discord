import fs from "node:fs";
import path from "node:path";

const ROOT_DIR = process.cwd();
const RULES_DIR = path.join(ROOT_DIR, "rules");
const STYLE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

export function loadBotRules(
  outputStyle?: string,
  basePath?: string
): string | undefined {
  const rulesDir = basePath ? path.join(basePath, "rules") : RULES_DIR;

  const botRulesPath = path.join(rulesDir, "BOT.md");
  let content = "";
  try {
    content = fs.readFileSync(botRulesPath, "utf-8").trim();
  } catch {
    // no BOT.md
  }

  const requestedStyle = outputStyle ?? "seed";
  const style = STYLE_NAME_RE.test(requestedStyle) ? requestedStyle : "seed";
  if (style !== requestedStyle) {
    console.warn(`[rules-loader] invalid style name "${requestedStyle}", falling back to seed`);
  }

  const stylePath = path.join(rulesDir, "output-styles", `${style}.md`);
  try {
    const styleContent = fs.readFileSync(stylePath, "utf-8").trim();
    if (styleContent) {
      content = content ? `${content}\n\n${styleContent}` : styleContent;
    }
  } catch {
    if (style !== "seed") {
      console.warn(`[rules-loader] style "${style}" not found, falling back to seed`);
      const fallbackPath = path.join(rulesDir, "output-styles", "seed.md");
      try {
        const fallbackContent = fs.readFileSync(fallbackPath, "utf-8").trim();
        if (fallbackContent) {
          content = content ? `${content}\n\n${fallbackContent}` : fallbackContent;
        }
      } catch {
        // no seed.md either
      }
    }
  }

  return content || undefined;
}

export function listOutputStyles(basePath?: string): string[] {
  const rulesDir = basePath ? path.join(basePath, "rules") : RULES_DIR;
  const stylesDir = path.join(rulesDir, "output-styles");
  try {
    return fs
      .readdirSync(stylesDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .filter((name) => STYLE_NAME_RE.test(name));
  } catch {
    return [];
  }
}
