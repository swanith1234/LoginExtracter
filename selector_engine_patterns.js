// selector_engine_patterns.js
// Universal Login Pattern Extractor
// - Extract inputs/buttons
// - Ask Gemini (LLM) for semantic PATTERNS (not ephemeral selectors)
// - Handle single-step and multi-step flows (fills dummy email + clicks next)
// - Append results per-domain to JSON + YAML files
//
// Exports: analyzeLoginPage(page, options)
// Requires: set GEMINI_API_KEY env var or edit GEMINI_KEY below and install @google/generative-ai

const fs = require("fs");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const DEFAULT_SAVE_JSON = path.join(process.cwd(), "login_pattern.json");
const DEFAULT_SAVE_YAML = path.join(process.cwd(), "login_pattern.yaml");
const GEMINI_KEY =
  process.env.GEMINI_API_KEY || "AIzaSyAdiCRtQr59NFbagewPzCpDZi1ByX_325Y";
const GEMINI_MODEL = "gemini-2.0-flash";

/* ---------------------------
   Basic file helpers
   --------------------------- */
function loadExistingJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function saveJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
}

/* ---------------------------
   YAML-like exporter (simple, readable)
   --------------------------- */
function jsonToYamlLike(obj, indent = 0) {
  const pad = (n) => "  ".repeat(n);
  let out = "";

  if (typeof obj !== "object" || obj === null) {
    return String(obj) + "\n";
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (typeof item === "object") {
        out += `${pad(indent)}- \n${jsonToYamlLike(item, indent + 1)}`;
      } else {
        out += `${pad(indent)}- ${item}\n`;
      }
    }
    return out;
  }

  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      out += `${pad(indent)}${key}:\n${jsonToYamlLike(val, indent + 1)}`;
    } else if (Array.isArray(val)) {
      out += `${pad(indent)}${key}:\n`;
      for (const v of val) {
        if (typeof v === "object") {
          out += `${pad(indent + 1)}- \n${jsonToYamlLike(v, indent + 2)}`;
        } else {
          out += `${pad(indent + 1)}- ${v}\n`;
        }
      }
    } else {
      out += `${pad(indent)}${key}: ${String(val)}\n`;
    }
  }

  return out;
}

/* ---------------------------
   LLM wrapper
   --------------------------- */
function ensureGemini() {
  if (!GEMINI_KEY) {
    throw new Error("GEMINI_API_KEY is not set. Set env var GEMINI_API_KEY.");
  }
  return new GoogleGenerativeAI(GEMINI_KEY);
}

async function queryGemini(prompt) {
  try {
    const g = ensureGemini();
    const model = g.getGenerativeModel({ model: GEMINI_MODEL });
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    try {
      return JSON.parse(text);
    } catch {
      // attempt to extract JSON substring
      const m = text.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]);
      throw new Error("Gemini returned non-JSON");
    }
  } catch (e) {
    // bubble up with context
    throw new Error("Gemini error: " + (e.message || e));
  }
}

/* ---------------------------
   DOM extraction helpers
   --------------------------- */
async function extractInputsWithContext(page) {
  return await page.$$eval("input", (els) =>
    els.map((el, idx) => {
      const id = el.id || "";
      const name = el.name || "";
      const type = (el.type || "").toLowerCase();
      const placeholder = el.placeholder || "";
      const aria = el.getAttribute("aria-label") || "";
      const label =
        document.querySelector(`label[for="${el.id}"]`)?.innerText ||
        "" ||
        el.closest("label")?.innerText ||
        "";
      const classes = el.className || "";
      const outerHTML = el.outerHTML || "";
      const suggestedSelectors = [];
      if (id) suggestedSelectors.push(`#${id}`);
      if (name) suggestedSelectors.push(`input[name="${name}"]`);
      if (placeholder)
        suggestedSelectors.push(`input[placeholder="${placeholder}"]`);
      if (type) suggestedSelectors.push(`input[type="${type}"]`);
      if (!suggestedSelectors.length)
        suggestedSelectors.push(`input:nth-of-type(${idx + 1})`);
      return {
        id,
        name,
        type,
        placeholder,
        aria,
        label: label.trim(),
        classes,
        outerHTML,
        suggestedSelectors,
      };
    })
  );
}

async function extractButtonsWithContext(page) {
  return await page.$$eval(
    'button, input[type="submit"], [role="button"], a',
    (els) =>
      els.map((el, idx) => {
        const tag = el.tagName.toLowerCase();
        const text = (el.innerText || el.value || "").trim();
        const id = el.id || "";
        const aria = el.getAttribute("aria-label") || "";
        const classes = el.className || "";
        const outerHTML = el.outerHTML || "";
        const suggestedSelectors = [];
        if (id) suggestedSelectors.push(`#${id}`);
        if (text) {
          suggestedSelectors.push(`text="${text}"`);
          suggestedSelectors.push(`${tag}:has-text("${text}")`);
        }
        if (!suggestedSelectors.length)
          suggestedSelectors.push(`${tag}:nth-of-type(${idx + 1})`);
        return { tag, text, id, aria, classes, outerHTML, suggestedSelectors };
      })
  );
}

/* ---------------------------
   Prompts
   --------------------------- */
function buildPatternPrompt(inputs, buttons) {
  return `
You are a UI automation assistant. Given the lists of input fields and button candidates,
return a JSON object that represents PATTERN rules (not raw instance selectors) for login.

Return ONLY JSON. Two possible outputs:

1) Single-step login:
{
  "type": "simple_login",
  "username_patterns": ["css-or-playwright-pattern", ...],
  "password_patterns": ["..."],
  "submit_patterns": ["..."]
}

2) Multi-step login:
{
  "type": "multi_step_login",
  "steps": 2,
  "step_1": {
    "field_type": "username",
    "field_patterns": ["..."],
    "submit_patterns": ["..."]
  },
  "step_2": {
    "field_type": "password",
    "field_patterns": ["..."],
    "submit_patterns": ["..."]
  }
}

Important rules:
- DO NOT return ephemeral selectors like '#user_12345' or '.class_abcd'.
- Prefer semantic patterns: input[type='email'], input[name='username'], input[placeholder*='Email'], input[type='password'], button[type='submit'], button:has-text('Next')
- If a category is not present, return an empty array for that key.
- Only produce valid JSON, nothing else.

Inputs:
${JSON.stringify(inputs, null, 2)}

Buttons:
${JSON.stringify(buttons, null, 2)}
`.trim();
}

function buildSecondPatternPrompt(inputs, buttons) {
  return `
You are a UI automation assistant. This is a second-stage page (after clicking Next).
Return ONLY JSON:
{
  "password_patterns": ["..."],
  "submit_patterns": ["..."]
}

Inputs:
${JSON.stringify(inputs, null, 2)}

Buttons:
${JSON.stringify(buttons, null, 2)}
`.trim();
}

/* ---------------------------
   Playwright helper helpers
   --------------------------- */
async function existsSelector(page, selector) {
  if (!selector) return false;
  try {
    const c = await page.locator(selector).count();
    return c > 0;
  } catch {
    return false;
  }
}

async function isVisibleSelector(page, selector) {
  if (!selector) return false;
  try {
    const loc = page.locator(selector).first();
    return await loc.isVisible();
  } catch {
    return false;
  }
}

async function pickConcreteSelectorFromPatterns(page, patterns = []) {
  for (const p of patterns || []) {
    try {
      const c = await page.locator(p).count();
      if (c > 0) return p;
    } catch {
      // ignore invalid pattern types
    }
  }
  return null;
}

async function pickConcreteFieldSelectorForInputs(
  page,
  patterns = [],
  inputs = []
) {
  // try patterns first
  for (const p of patterns || []) {
    try {
      if (await page.locator(p).count()) return p;
    } catch {}
  }
  // fallback to suggestedSelectors from scraped inputs
  for (const inp of inputs || []) {
    for (const s of inp.suggestedSelectors || []) {
      try {
        if (await page.locator(s).count()) return s;
      } catch {}
    }
  }
  return null;
}

/* ---------------------------
   Main analyze flow
   --------------------------- */
async function analyzeLoginPage(page, options = {}) {
  // options: { waitAfterClickMs, savePathJson, savePathYaml, promptVerbose }
  const waitAfterClickMs = options.waitAfterClickMs ?? 2200;
  const savePathJson = options.savePathJson || DEFAULT_SAVE_JSON;
  const savePathYaml = options.savePathYaml || DEFAULT_SAVE_YAML;
  const verbose = !!options.promptVerbose;

  // 1) initial scrape
  const inputs = await extractInputsWithContext(page);
  const buttons = await extractButtonsWithContext(page);

  if (verbose) {
    console.log("Inputs extracted:", inputs.length);
    console.log("Buttons extracted:", buttons.length);
  }

  // 2) ask Gemini
  const prompt1 = buildPatternPrompt(inputs, buttons);
  if (verbose) console.log("Prompt (1st) -> Gemini");
  let firstResult;
  try {
    firstResult = await queryGemini(prompt1);
  } catch (e) {
    // graceful fallback
    if (verbose) console.error("Gemini call failed:", e.message || e);
    firstResult = {
      type: "incomplete",
      username_patterns: [],
      password_patterns: [],
      submit_patterns: [],
    };
  }
  if (verbose) console.log("FirstResult:", firstResult);

  // 3) STRONG heuristic override (must run BEFORE using 'type')
  const usernamePatterns = firstResult.username_patterns || [];
  const passwordPatterns = firstResult.password_patterns || [];
  const submitPatterns = firstResult.submit_patterns || [];

  let overrideToMulti = false;

  // Rule A: username present but password missing -> multi-step
  if (usernamePatterns.length > 0 && passwordPatterns.length === 0)
    overrideToMulti = true;

  // Rule B: password pattern exists but invisible -> multi-step
  if (passwordPatterns.length > 0) {
    try {
      const vis = await isVisibleSelector(page, passwordPatterns[0]);
      if (!vis) overrideToMulti = true;
    } catch {}
  }

  // Rule C: submit patterns look like Next/Continue -> multi-step
  const nextWords = ["next", "continue", "verify", "proceed"];
  const looksLikeNext = (submitPatterns || []).some((s) =>
    nextWords.some((w) => s.toLowerCase().includes(w))
  );
  if (looksLikeNext) overrideToMulti = true;

  if (overrideToMulti) {
    if (verbose) console.log("⚠ Heuristic override: forcing multi_step_login");
    firstResult.type = "multi_step_login";
    if (!firstResult.step_1) {
      firstResult.step_1 = {
        field_type: "username",
        field_patterns: usernamePatterns,
        submit_patterns: submitPatterns,
      };
    }
  }

  // now compute effective type
  const type = firstResult.type || "incomplete";

  // determine domain and load existing
  const domain = (() => {
    try {
      return new URL(page.url()).hostname.replace(/^www\./, "");
    } catch {
      return "unknown";
    }
  })();
  const existing = loadExistingJson(savePathJson);

  // SIMPLE
  if (type === "simple_login") {
    const out = {
      url: page.url(),
      simple_login: {
        username_patterns: firstResult.username_patterns || [],
        password_patterns: firstResult.password_patterns || [],
        submit_patterns: firstResult.submit_patterns || [],
      },
    };
    existing[domain] = out;
    saveJson(savePathJson, existing);
    fs.writeFileSync(savePathYaml, jsonToYamlLike(existing), "utf8");
    return out;
  }

  // MULTI-STEP
  if (type === "multi_step_login") {
    const step1 = firstResult.step_1 || {};
    const step1FieldPatterns =
      step1.field_patterns ||
      step1.field_patterns ||
      step1.field_patterns ||
      step1.fieldPatterns ||
      step1.field_patterns ||
      step1.field_patterns ||
      step1.field_patterns ||
      step1.field_patterns ||
      step1.field_patterns ||
      step1.field_patterns ||
      step1.field_patterns ||
      step1.field_patterns ||
      []; // defensive (some LLMs vary)
    // above line is intentionally forgiving; prefer robust parsing below
    const step1Fields =
      step1.field_patterns ||
      step1.field_patterns ||
      step1.field_patterns ||
      step1.fieldPatterns ||
      step1.field_patterns ||
      step1.field_patterns ||
      [];
    const step1SubmitPatterns =
      step1.submit_patterns ||
      step1.submit_patterns ||
      step1.submitPatterns ||
      [];

    // pick concrete username selector to fill
    const fillSel = await pickConcreteFieldSelectorForInputs(
      page,
      step1Fields,
      inputs
    );
    if (fillSel) {
      try {
        await page.locator(fillSel).fill("dummy@example.com");
        await page.waitForTimeout(300);
      } catch (e) {
        if (verbose)
          console.log("Could not fill username via", fillSel, e.message || e);
      }
    } else {
      // Try pressing Enter in the first username-like input if exists
      if (usernamePatterns.length > 0) {
        const trySel = await pickConcreteSelectorFromPatterns(
          page,
          usernamePatterns
        );
        if (trySel) {
          try {
            await page.locator(trySel).fill("dummy@example.com");
            await page.waitForTimeout(200);
          } catch {}
        }
      }
    }

    // click next
    let clickSel = await pickConcreteSelectorFromPatterns(
      page,
      step1SubmitPatterns
    );
    if (!clickSel) {
      // fallback to button candidates scraped earlier
      for (const b of buttons) {
        for (const s of b.suggestedSelectors || []) {
          if (await existsSelector(page, s)) {
            clickSel = s;
            break;
          }
        }
        if (clickSel) break;
      }
    }

    if (clickSel) {
      try {
        const loc = page.locator(clickSel).first();
        try {
          const disabled = await loc.isDisabled().catch(() => false);
          if (disabled) {
            // fallback: press Enter on username field
            if (fillSel) await page.locator(fillSel).press("Enter");
          } else {
            await loc.click({ timeout: 5000 });
          }
        } catch {
          if (fillSel) await page.locator(fillSel).press("Enter");
        }
      } catch (e) {
        if (verbose) console.log("Click next error:", e.message || e);
      }
    } else {
      if (verbose)
        console.log("No next/continue selector found to click for step1");
    }

    await page.waitForTimeout(waitAfterClickMs);

    // second pass (password)
    const inputs2 = await extractInputsWithContext(page);
    const buttons2 = await extractButtonsWithContext(page);

    if (verbose)
      console.log(
        "Second pass inputs:",
        inputs2.length,
        "buttons:",
        buttons2.length
      );

    let secondResult;
    try {
      const prompt2 = buildSecondPatternPrompt(inputs2, buttons2);
      secondResult = await queryGemini(prompt2);
    } catch (e) {
      if (verbose) console.error("Gemini (2nd) failed:", e.message || e);
      secondResult = { password_patterns: [], submit_patterns: [] };
    }

    const out = {
      url: page.url(),
      multi_step_login: {
        steps: 2,
        step_1: {
          field_type: step1.field_type || "username",
          field_patterns: step1Fields,
          submit_patterns: step1SubmitPatterns,
        },
        step_2: {
          field_type: "password",
          field_patterns: secondResult.password_patterns || [],
          submit_patterns: secondResult.submit_patterns || [],
        },
      },
    };

    existing[domain] = out;
    saveJson(savePathJson, existing);
    fs.writeFileSync(savePathYaml, jsonToYamlLike(existing), "utf8");
    return out;
  }

  // FALLBACK: incomplete
  const out = {
    url: page.url(),
    incomplete: {
      username_patterns: firstResult.username_patterns || [],
      password_patterns: firstResult.password_patterns || [],
      submit_patterns: firstResult.submit_patterns || [],
    },
  };

  existing[domain] = out;
  saveJson(savePathJson, existing);
  fs.writeFileSync(savePathYaml, jsonToYamlLike(existing), "utf8");
  return out;
}

/* ---------------------------
   Exports
   --------------------------- */
module.exports = { analyzeLoginPage };
