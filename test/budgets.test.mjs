/**
 * Tests for performance budgets.
 *
 * `runLighthouse` shells out to a real browser and is not unit-tested here — a test that
 * launches Chrome is a test nobody runs. The logic that DECIDES pass or fail is pure and
 * is tested exhaustively, because that is the part that either blocks a merge or does not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scoresFromReport, evaluateBudgets, BUDGET_DEFAULTS, runLighthouse } from '../src/budgets.mjs';

test('scoresFromReport converts 0-1 scores to 0-100 integers', () => {
  const scores = scoresFromReport({
    categories: { performance: { score: 0.923 }, accessibility: { score: 1 } },
  });
  assert.deepEqual(scores, { performance: 92, accessibility: 100 });
});

test('a null score is omitted, never treated as zero', () => {
  // Recording "not measured" as 0 would fail a build over a measurement that never
  // happened, which is how people learn to ignore a gate.
  const scores = scoresFromReport({
    categories: { performance: { score: null }, seo: { score: 0.9 } },
  });
  assert.deepEqual(scores, { seo: 90 });
});

test('blocking categories fail, advisory ones only warn', () => {
  const r = evaluateBudgets(
    { accessibility: 82, performance: 61 },
    {
      accessibility: { min: 90, blocking: true },
      performance: { min: 80, blocking: false },
    },
  );
  assert.deepEqual(r.failures.map((f) => f.id), ['accessibility']);
  assert.deepEqual(r.warnings.map((w) => w.id), ['performance']);
});

test('a category the run did not measure is reported, not failed', () => {
  const r = evaluateBudgets({ performance: 95 }, BUDGET_DEFAULTS.categories);
  assert.ok(r.notMeasured.includes('accessibility'));
  assert.equal(r.failures.length, 0);
});

test('a score exactly on the threshold passes', () => {
  // Off-by-one here would fail builds that met the budget precisely.
  const r = evaluateBudgets({ accessibility: 90 }, { accessibility: { min: 90, blocking: true } });
  assert.equal(r.failures.length, 0);
  assert.deepEqual(r.passed.map((p) => p.id), ['accessibility']);
});

test('defaults make accessibility blocking and performance advisory', () => {
  // Lighthouse performance moves several points run to run on identical code. Blocking on
  // it produces a coin-flip gate, and a gate understood as a coin flip protects nothing.
  assert.equal(BUDGET_DEFAULTS.categories.accessibility.blocking, true);
  assert.equal(BUDGET_DEFAULTS.categories.performance.blocking, false);
});

/*
  runLighthouse hands its arguments to spawnSync, which runs with shell: true on Windows
  because npx is npx.cmd. Both the URL and the Chrome flags come from the consuming site
  config, so on that platform they are shell-interpreted.

  These tests exist because the first version of the guard only parsed the URL and let the
  rest through. new URL() does not encode backticks, $, |, ; or & — a URL can parse
  perfectly and still carry a command. Parsing is not sanitising.
*/
const WINDOWS_ONLY = process.platform !== 'win32';

test('a URL that is not http or https is refused on every platform', () => {
  const r = runLighthouse({ url: 'javascript:alert(1)', timeoutMs: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error, /must be an http or https URL/);
});

test('shell punctuation in the URL is refused before it reaches cmd.exe', { skip: WINDOWS_ONLY }, () => {
  for (const url of [
    'http://x.com & calc.exe',
    'http://x.com/`whoami`',
    'http://x.com/$(calc)',
    'http://x.com/a|b',
    'http://x.com/a;b',
    'http://x.com/%USERPROFILE%',
  ]) {
    const r = runLighthouse({ url, timeoutMs: 1 });
    assert.equal(r.ok, false, `should have refused: ${url}`);
    assert.match(r.error, /shell punctuation|must be an http/);
  }
});

test('shell punctuation in a Chrome flag is refused too', { skip: WINDOWS_ONLY }, () => {
  const r = runLighthouse({ url: 'http://localhost:4321', chromeFlags: ['--headless; calc.exe'], timeoutMs: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error, /chromeFlags contains shell punctuation/);
});

test('an ordinary URL is not caught by the guard', () => {
  // Refused for any reason other than the guard is fine here; being refused BY the guard is not.
  for (const url of ['http://localhost:4321', 'https://acsaven.com/']) {
    const r = runLighthouse({ url, timeoutMs: 1 });
    if (r && r.ok === false) {
      assert.doesNotMatch(r.error, /shell punctuation|must be an http or https URL/, url);
    }
  }
});
