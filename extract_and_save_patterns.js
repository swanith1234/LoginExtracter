// extract_and_save_patterns.js
// Usage example:
// node extract_and_save_patterns.js --url="https://account.mongodb.com/account/login" --profileBase="D:/profiles" --pageId="mongoTest" --chromePath="C:/Program Files/Google/Chrome/Application/chrome.exe" --verbose=true

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { analyzeLoginPage } = require("./selector_engine_patterns");

function parseArgs() {
  const argv = process.argv.slice(2);
  const arg = (k) => {
    const v = argv.find((a) => a.startsWith(`--${k}=`));
    return v ? v.split("=")[1] : null;
  };
  return {
    url: arg("url"),
    profileBase: arg("profileBase") || "./profiles",
    pageId: arg("pageId") || "default",
    chromePath: arg("chromePath") || undefined,
    savePathJson: arg("savePathJson") || undefined,
    savePathYaml: arg("savePathYaml") || undefined,
    promptVerbose: arg("verbose") === "true" || false,
  };
}

(async () => {
  const args = parseArgs();
  if (!args.url) {
    console.error("Missing --url argument");
    process.exit(1);
  }

  const profileDir = path.join(args.profileBase, args.pageId);
  if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    executablePath: args.chromePath,
    viewport: { width: 1366, height: 768 },
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const page = context.pages()[0] || (await context.newPage());

  console.log("Opening URL:", args.url);
  try {
    // don't block on networkidle; SPA pages never settle
    await page.goto(args.url, { timeout: 0 }).catch(() => {});
  } catch (e) {
    console.warn("goto threw, continuing:", e.message);
  }
  await page.waitForTimeout(2800);

  try {
    const result = await analyzeLoginPage(page, {
      waitAfterClickMs: 2200,
      savePathJson: args.savePathJson,
      savePathYaml: args.savePathYaml,
      promptVerbose: args.promptVerbose,
    });
    console.log("Analysis result:");
    console.log(JSON.stringify(result, null, 2));
    console.log(
      "Saved to JSON:",
      args.savePathJson || path.join(process.cwd(), "login_pattern.json")
    );
    console.log(
      "Saved to YAML:",
      args.savePathYaml || path.join(process.cwd(), "login_pattern.yaml")
    );
  } catch (e) {
    console.error("Engine error:", e);
  } finally {
    // leave the browser open so you can inspect if you want. Close if not:
    // await context.close();
  }
})();
