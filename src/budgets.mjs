/**
 * Performance budgets that block a merge.
 *
 * WHY A GATE AND NOT A DASHBOARD
 * ------------------------------
 * Everyone measures performance. Almost nobody enforces it, and the two are not the same
 * thing. A score you look at after shipping tells you what you already regret; a threshold
 * that fails the build is the only version that changes what gets merged.
 *
 * Regression is the normal state of a site. Nothing arrives labelled "this makes the page
 * slower" — it arrives as a font, an embed, a polyfill, a third image above the fold. Each
 * is defensible alone. The budget is what makes the cumulative cost visible at the moment
 * someone can still decide differently.
 *
 * BLOCKING VS ADVISORY, AND WHY BOTH EXIST
 * ----------------------------------------
 * Accessibility is blocking by default. It is close to deterministic — the same page scores
 * the same on any machine — so a failure is a real defect and not noise.
 *
 * Performance defaults to ADVISORY. Lighthouse performance moves several points between
 * runs on identical code, and more between a laptop and a loaded CI runner. Made blocking
 * at a tight threshold, it fails randomly; people learn to re-run until it passes, and once
 * a gate is understood as a coin flip it protects nothing. Set it blocking only at a
 * threshold loose enough that tripping it means something genuinely broke.
 *
 * This module does not bundle Lighthouse. It shells out to whatever the project already
 * has, so the toolkit adds no multi-hundred-megabyte dependency to your install.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Default thresholds. Each category is `{ min, blocking }`.
 * See the header for why performance is advisory out of the box.
 */
export const BUDGET_DEFAULTS = {
  url: null,
  categories: {
    accessibility: { min: 90, blocking: true },
    performance: { min: 80, blocking: false },
    'best-practices': { min: 90, blocking: false },
    seo: { min: 90, blocking: false },
  },
  preset: 'desktop',
  chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'],
  timeoutMs: 180000,
};

/**
 * Reads category scores out of a Lighthouse JSON report.
 *
 * @param {object} report - Parsed Lighthouse result.
 * @returns {Record<string, number>} Category id → score 0-100.
 */
export function scoresFromReport(report) {
  const out = {};
  for (const [id, cat] of Object.entries(report?.categories ?? {})) {
    // A null score means the category could not be evaluated. Recording it as 0 would
    // fail the build for a measurement that never happened, which teaches people to
    // ignore the gate. Skipped instead, and surfaced as "not measured".
    if (typeof cat?.score === 'number') out[id] = Math.round(cat.score * 100);
  }
  return out;
}

/**
 * Compares scores against thresholds.
 *
 * @param {Record<string, number>} scores
 * @param {Record<string, {min:number, blocking:boolean}>} categories
 * @returns {{failures:Array, warnings:Array, notMeasured:string[], passed:Array}}
 */
export function evaluateBudgets(scores, categories) {
  const failures = [];
  const warnings = [];
  const notMeasured = [];
  const passed = [];

  for (const [id, rule] of Object.entries(categories)) {
    const score = scores[id];
    if (score === undefined) {
      notMeasured.push(id);
      continue;
    }
    const row = { id, score, min: rule.min };
    if (score < rule.min) (rule.blocking ? failures : warnings).push(row);
    else passed.push(row);
  }

  return { failures, warnings, notMeasured, passed };
}

/**
 * Runs Lighthouse against a URL and returns its scores.
 *
 * Uses the project's own Lighthouse via `npx --no-install`, so it fails with a clear
 * message rather than silently downloading a copy into someone's CI cache.
 *
 * @param {object} options
 * @param {string} options.url
 * @param {string} [options.preset]
 * @param {string[]} [options.chromeFlags]
 * @param {number} [options.timeoutMs]
 * @returns {{ok:boolean, scores?:Record<string,number>, error?:string}}
 */
export function runLighthouse({
  url,
  preset = BUDGET_DEFAULTS.preset,
  chromeFlags = BUDGET_DEFAULTS.chromeFlags,
  timeoutMs = BUDGET_DEFAULTS.timeoutMs,
}) {
  /*
    These two values reach a shell on Windows, so they are checked before they get there.

    spawnSync runs with `shell: true` on win32 below, because npx is npx.cmd and Node
    refuses to execute a .cmd without one — that is the fix for CVE-2024-27980, and it has
    the side effect of making every argument shell-interpreted on that platform. Both `url`
    and `chromeFlags` come from the consuming site's config rather than from here, and Node
    now warns about exactly this (DEP0190).

    The exposure is narrow: editing that config already implies being able to run code from
    a build script. It widens on CI that builds pull requests, where a fork could change the
    config and reach the runner's shell. This package runs inside other people's pipelines,
    so it is worth not being the way in.

    Parsing the URL is NOT enough, and assuming otherwise is how the first version of this
    check shipped wrong. `new URL()` leaves backticks, $, |, ; and & untouched in `href` —
    verified, not assumed — so a URL that parses perfectly can still carry a command through
    cmd.exe. The punctuation check below is what actually does the work.

    It runs only on Windows, because there is no shell on POSIX and no reason to reject a
    legitimate query string there. On Windows a URL needing `&` must percent-encode it as
    %26; that is a real constraint and it is better than a silent shell.
  */
  const parsed = (() => {
    try {
      return new URL(String(url));
    } catch {
      return null;
    }
  })();
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    return { ok: false, error: `budgets.url must be an http or https URL, got: ${String(url).slice(0, 80)}` };
  }

  const SHELL_PUNCTUATION = /[;&|`$<>(){}^%!\n\r"']/;
  if (process.platform === 'win32') {
    if (SHELL_PUNCTUATION.test(parsed.href)) {
      return {
        ok: false,
        error:
          `budgets.url reaches a Windows shell and contains shell punctuation: ${parsed.href.slice(0, 80)}. ` +
          'Percent-encode it (& as %26, for example) or run the budget check on a POSIX runner.',
      };
    }
    const badFlag = chromeFlags.find((f) => SHELL_PUNCTUATION.test(String(f)));
    if (badFlag) {
      return { ok: false, error: `budgets.chromeFlags contains shell punctuation: ${String(badFlag).slice(0, 80)}` };
    }
  }

  const dir = mkdtempSync(join(tmpdir(), 'astro-ops-lh-'));
  const outPath = join(dir, 'report.json');

  const args = [
    '--no-install',
    'lighthouse',
    parsed.href,
    '--output=json',
    `--output-path=${outPath}`,
    '--quiet',
    `--chrome-flags=${chromeFlags.join(' ')}`,
  ];
  if (preset === 'desktop') args.push('--preset=desktop');

  try {
    const res = spawnSync('npx', args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      shell: process.platform === 'win32',
    });

    if (!existsSync(outPath)) {
      const stderr = (res.stderr || '').trim().split('\n').slice(-4).join('\n');
      return {
        ok: false,
        error:
          `Lighthouse produced no report.\n` +
          `    Is it installed? \`npm i -D lighthouse\`. Is ${url} actually serving?\n` +
          (stderr ? `    Last output: ${stderr}` : ''),
      };
    }

    const report = JSON.parse(readFileSync(outPath, 'utf8'));
    return { ok: true, scores: scoresFromReport(report) };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
