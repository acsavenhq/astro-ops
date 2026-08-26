#!/usr/bin/env node
/**
 * astro-ops CLI.
 *
 * Every command follows the same contract, because these run unattended in CI and the
 * output is the only thing a human sees when one fails at 2am:
 *
 *   - exit 0 = pass, exit 1 = a gate failed, exit 2 = the tool itself is misconfigured.
 *     A config error must not look like a content failure; you fix them in different places.
 *   - A failure names WHAT is wrong, WHERE, and the command that fixes it.
 *     A gate that only says "no" wastes the reader's time at the worst possible moment.
 *   - Consequence over rule. "The edge will serve stale HTML" beats "hash mismatch" — the
 *     reader needs to know whether to care before they know what to type.
 *   - `check` runs every gate even after one fails. A CI run that reports one problem per
 *     push turns a five-minute fix into five pushes.
 */
import { argv, cwd, exit } from 'node:process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from '../src/config.mjs';
/*
  Integrity stays a STATIC import; every other gate is loaded on demand inside its command.

  A CLI that imports all of its gates at module load cannot survive one of them being
  damaged — emptying src/links.mjs made this file die with "does not provide an export named
  checkLinks" before `check:integrity` could run, so the one command whose job is to REPORT
  that damage was the one the damage disabled.

  Loading each gate only when its command runs means a broken module now fails just that
  gate, and integrity still reports what happened.
*/
import { checkIntegrity, describeIntegrity } from '../src/integrity.mjs';

const USAGE = `astro-ops — production gates for Astro sites

Usage:
  astro-ops build-id             Write the content-hashed build id file
  astro-ops check:integrity      Fail on low disk, or on tracked files emptied by it
  astro-ops check:build-id       Fail if the committed build id is stale
  astro-ops check:external       Fail on third-party scripts, styles, fonts or embeds
  astro-ops check:freshness      Fail on claims overdue for re-verification, or drifted
  astro-ops check:discovery      Fail on broken titles, canonicals, sitemap/noindex conflicts
  astro-ops check:links          Fail on broken internal links and trailing-slash drift
  astro-ops check:budgets        Fail when Lighthouse drops below your thresholds
  astro-ops check                Run every configured gate (CI entry point)

Options:
  --root <dir>   Project root (default: current directory)
  --quiet        Print only failures
  -h, --help     Show this help

Exit codes:  0 pass  ·  1 a gate failed  ·  2 the tool is misconfigured
`;

function parseArgs(args) {
  const flags = { root: cwd(), quiet: false, help: false };
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--root') { flags.root = args[i + 1]; i += 1; }
    else if (a === '--quiet') flags.quiet = true;
    else if (a === '-h' || a === '--help') flags.help = true;
    else rest.push(a);
  }
  return { command: rest[0], flags };
}

const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => console.error(`  ✗ ${m}`);
const skip = (m) => console.log(`  – ${m}`);

/** Caps a long list so one broken template cannot bury every other finding. */
function report(items, render, limit = 20) {
  for (const item of items.slice(0, limit)) bad(render(item));
  if (items.length > limit) console.error(`    … and ${items.length - limit} more`);
}

// --- build-id ---------------------------------------------------------------------------

async function cmdBuildId(config, root, quiet) {
  const { emitBuildId } = await import('../src/build-id.mjs');

  const r = emitBuildId(config.buildId, root);
  if (r.fileCount === 0) {
    bad(
      `nothing to hash — no files under ${config.buildId.include.join(', ')}\n` +
        `    Every deploy would get the same id, so the edge cache would never bust.\n` +
        `    Run your build first, or set buildId.include in astro-ops.config.mjs.`,
    );
    return 1;
  }
  if (!quiet) {
    ok(
      r.changed
        ? `build-id ${r.id} written to ${r.path} (${r.fileCount} files) — COMMIT THIS FILE`
        : `build-id ${r.id} already current in ${r.path} (${r.fileCount} files)`,
    );
  }
  return 0;
}

function cmdCheckIntegrity(config, root, quiet) {
  const r = checkIntegrity({ root, ...config.integrity });
  if (r.ok) {
    if (!quiet) {
      const free = r.free === null ? 'unknown' : `${(r.free / 1024 ** 3).toFixed(1)} GB free`;
      ok(`integrity — ${free}, ${r.scanned} tracked files intact`);
    }
    return 0;
  }
  for (const line of describeIntegrity(r)) bad(line);
  return 1;
}

// --- build-id ---------------------------------------------------------------------------

async function cmdCheckBuildId(config, root, quiet) {
  const { checkBuildId } = await import('../src/build-id.mjs');

  const r = checkBuildId(config.buildId, root);
  if (r.ok) {
    if (!quiet) ok(`build-id ${r.expected} matches deployed content`);
    return 0;
  }
  const fix = `    Fix: run \`astro-ops build-id\` and commit ${r.path} with your change.`;
  const why =
    `    Why it matters: your deploy ships the COMMITTED id. A stale one means the edge cache\n` +
    `    is never invalidated — new HTML deploys but visitors keep getting the old page from\n` +
    `    every colo. Nothing else in CI can see this, because the origin is fine.`;
  if (r.reason === 'missing') bad(`${r.path} does not exist.\n${fix}\n${why}`);
  else if (r.reason === 'malformed') bad(`${r.path} has no \`${config.buildId.constName}\` export.\n${fix}`);
  else bad(`${r.path} is STALE — committed ${r.found}, content hashes to ${r.expected}.\n${fix}\n${why}`);
  return 1;
}

// --- external ---------------------------------------------------------------------------

async function cmdCheckExternal(config, root, quiet) {
  const { scanExternalAssets } = await import('../src/external-assets.mjs');

  const r = scanExternalAssets({ root, ...config.external });
  if (r.missingDist) {
    bad(`${config.external.dist}/ does not exist — build first; this reads what you SHIP.`);
    return 1;
  }
  if (r.issues.length === 0) {
    if (!quiet) ok(`no third-party assets (${r.htmlCount} HTML, ${r.cssCount} CSS)`);
    return 0;
  }
  console.error(`  ✗ ${r.issues.length} third-party asset load(s):`);
  report(r.issues, (i) => `  ${i.file}\n      [${i.kind}] ${i.detail}`);
  console.error(
    `\n    Each of these is a request a visitor's browser makes to someone else on your\n` +
      `    behalf. If your privacy policy says otherwise, the policy is now wrong.\n` +
      `    Allow one deliberately with external.allowHosts in astro-ops.config.mjs.`,
  );
  return 1;
}

// --- freshness --------------------------------------------------------------------------

async function cmdCheckFreshness(config, root, quiet) {
  const { scanClaims, readFileConstants, evaluateFreshness, fetchDrift } = await import('../src/freshness.mjs');

  const f = config.freshness;
  let claims = [...f.claims];

  if (f.scan) {
    const file = join(root, f.scan.file);
    if (!existsSync(file)) {
      bad(`freshness.scan.file not found: ${f.scan.file}`);
      return 1;
    }
    const scanned = scanClaims(readFileSync(file, 'utf8'), f.scan.keys);
    // A configured scan that matches nothing is a FAILURE, never a quiet pass. Otherwise a
    // renamed key silently disarms the watchdog and every run reports success — the exact
    // shape of bug this gate exists to catch, hiding inside the gate itself.
    if (scanned.length === 0) {
      bad(
        `freshness.scan matched 0 claims in ${f.scan.file}.\n` +
          `    The watchdog is configured but guarding nothing, which would report success\n` +
          `    forever. Check the key names — it looks for "${f.scan.keys?.id ?? 'slug'}" to\n` +
          `    identify each claim — or remove freshness.scan if this file is not your data.`,
      );
      return 1;
    }
    claims = claims.concat(scanned);
  }

  // Second shape: each listed file IS one claim, carrying its dates as module-level exports.
  for (const entry of f.files ?? []) {
    const file = join(root, entry.file);
    if (!existsSync(file)) {
      bad(`freshness.files entry not found: ${entry.file}`);
      return 1;
    }
    const read = readFileConstants(readFileSync(file, 'utf8'), f.fileKeys);
    if (!read.found) {
      // An undated data file is UNGUARDED. Skipping it quietly is how a rate table goes
      // stale for a year while the gate reports success every single run.
      bad(
        `${entry.file} has no ${f.fileKeys?.lastVerified ?? 'VERIFIED_ON'}/` +
          `${f.fileKeys?.recheckBy ?? 'RECHECK_BY'} export — it is listed as time-sensitive\n` +
          `    but nothing can tell when it went stale. Add the dates, or drop it from freshness.files.`,
      );
      return 1;
    }
    claims.push({ id: entry.id ?? entry.file, label: entry.label, ...read });
  }

  if (claims.length === 0) {
    if (!quiet) skip('freshness: no claims configured (set freshness.scan or freshness.claims)');
    return 0;
  }

  const { overdue, dueSoon, dated, unsourced } = evaluateFreshness(claims, {
    recheckMonths: f.recheckMonths,
    warnWindowDays: f.warnWindowDays,
  });

  if (!quiet) console.log(`  scanned ${dated} dated claim(s) of ${claims.length}`);

  let failed = 0;

  if (dueSoon.length && !quiet) {
    console.log(`  ⚠ ${dueSoon.length} due for re-verification soon:`);
    for (const c of dueSoon.slice(0, 10)) {
      console.log(`      ${c.id} — due ${c.due.toISOString().slice(0, 10)} (${c.daysLeft}d left)`);
    }
  }

  if (overdue.length) {
    console.error(`  ✗ ${overdue.length} claim(s) OVERDUE for re-verification:`);
    report(overdue, (c) =>
      `  ${c.id}${c.label ? ` (${c.label})` : ''} — due ${c.due.toISOString().slice(0, 10)}, ` +
      `${-c.daysLeft}d overdue${c.sourceUrl ? `\n      verify: ${c.sourceUrl}` : ''}`);
    failed = 1;
  }

  // Unsourced claims are the gap that hides a wrong number longest: nothing can watch them
  // drift, so they rely entirely on someone remembering. Always reported; fatal on request.
  if (unsourced.length) {
    const line = `${unsourced.length} claim(s) name no source URL — invisible to drift detection`;
    if (f.requireSourceUrl) {
      bad(`${line}\n      ${unsourced.slice(0, 8).map((c) => c.id).join(', ')}`);
      failed = 1;
    } else if (!quiet) {
      console.log(`  ⚠ ${line}`);
    }
  }

  const drift = await fetchDrift(f.driftApi, claims, f.driftTimeoutMs);
  if (drift.status === 'broken') {
    bad(
      `the drift feed at ${f.driftApi} is BROKEN, not merely unreachable (${drift.detail}).\n` +
        `    This fails the build on purpose. A 5xx from your OWN feed means the watchdog is\n` +
        `    disabled while still reporting success — worse than having none, because you stop\n` +
        `    checking by hand. Fix the feed, or set freshness.driftApi to null.`,
    );
    failed = 1;
  } else if (drift.status === 'unreachable' && !quiet) {
    skip(`drift feed unreachable (${drift.detail}) — skipped, not a failure by itself`);
  } else if (drift.drifted.length) {
    console.error(`  ✗ ${drift.drifted.length} source(s) changed since you last accepted them:`);
    report(drift.drifted, (c) =>
      `  ${c.id}${c.label ? ` (${c.label})` : ''} — ${c.sourceUrl}\n` +
      `      changed ${c.detectedAt ?? 'recently'}. Re-verify by hand, update your data, then acknowledge.`);
    failed = 1;
  }

  /*
    A source the watchdog could not reach is worth saying out loud, but it is NOT a build
    failure. The content did not change — the hashes prove that — and the outage belongs to
    someone else's server, so blocking a deploy on it gives the reader nothing to act on.
    A source that stays unreachable long enough to matter surfaces through RECHECK_BY above,
    which is the check that actually expires.
  */
  if (drift.unchecked?.length && !quiet) {
    console.log(`  ⚠ ${drift.unchecked.length} source(s) could not be checked (unchanged since last accepted):`);
    for (const c of drift.unchecked) {
      console.log(`      ${c.id}${c.label ? ` (${c.label})` : ''} — ${c.fetchError} at ${c.fetchErrorAt ?? 'unknown time'}`);
    }
  }

  if (!failed && !quiet) {
    ok(`freshness OK (0 overdue${dueSoon.length ? `, ${dueSoon.length} due soon` : ''})`);
  }
  return failed;
}

// --- discovery --------------------------------------------------------------------------

async function cmdCheckDiscovery(config, root, quiet) {
  const { auditDiscovery } = await import('../src/discovery.mjs');

  const r = auditDiscovery({ root, ...config.discovery });
  if (r.missingDist) {
    bad(`${config.discovery.dist}/ does not exist — build first.`);
    return 1;
  }
  if (r.problems.length === 0) {
    if (!quiet) {
      ok(`discovery OK (${r.pageCount} pages, ${r.sitemapCount} sitemap URLs, ${r.noindexCount} noindex)`);
    }
    return 0;
  }
  console.error(`  ✗ ${r.problems.length} discovery problem(s) across ${r.pageCount} pages:`);
  report(r.problems, (p) => `  ${p.route}\n      ${p.detail}`);
  return 1;
}

// --- links ------------------------------------------------------------------------------

async function cmdCheckLinks(config, root, quiet) {
  const { checkLinks } = await import('../src/links.mjs');

  const r = checkLinks({ root, ...config.links });
  if (r.missingDist) {
    bad(`${config.links.dist}/ does not exist — build first; a link is only broken relative to what you shipped.`);
    return 1;
  }
  if (r.broken.length === 0 && r.slashes.length === 0) {
    if (!quiet) ok(`links OK (${r.linkCount} internal hrefs across ${r.fileCount} pages)`);
    return 0;
  }

  if (r.broken.length) {
    console.error(`  ✗ ${r.broken.length} broken internal link(s):`);
    report(r.broken, (b) => `  ${b.href}\n      first seen in ${b.where} — no page is built at that path`);
  }
  if (r.slashes.length) {
    console.error(`  ✗ ${r.slashes.length} internal link(s) missing a trailing slash:`);
    report(r.slashes, (s) => `  ${s.href}  (in ${s.where})`);
    console.error(
      `\n    "/about" and "/about/" are two URLs to a crawler. If your host redirects one to\n` +
        `    the other, each of these costs a redirect hop. Set links.requireTrailingSlash:false\n` +
        `    if your site is configured the other way round.`,
    );
  }
  return 1;
}

// --- budgets ----------------------------------------------------------------------------

async function cmdCheckBudgets(config, quiet) {
  const { runLighthouse, evaluateBudgets } = await import('../src/budgets.mjs');

  const b = config.budgets;
  if (!b.url) {
    if (!quiet) skip('budgets: no URL configured (set budgets.url to a running server)');
    return 0;
  }

  const run = runLighthouse({ url: b.url, preset: b.preset, timeoutMs: b.timeoutMs });
  if (!run.ok) {
    bad(`could not run Lighthouse against ${b.url}\n    ${run.error}`);
    return 2; // A tooling problem, not a site problem — different code, different fix.
  }

  const { failures, warnings, notMeasured, passed } = evaluateBudgets(run.scores, b.categories);

  if (!quiet) for (const p of passed) console.log(`      ${p.id}: ${p.score} (min ${p.min}) ✓`);
  for (const w of warnings) console.log(`  ⚠ ${w.id}: ${w.score} < ${w.min} — advisory, not blocking`);
  for (const n of notMeasured) console.log(`  – ${n}: not measured in this run`);

  if (failures.length) {
    console.error(`  ✗ ${failures.length} budget(s) breached:`);
    report(failures, (f) => `  ${f.id}: ${f.score} < ${f.min}`);
    console.error(
      `\n    Blocking categories fail the build by design — that is the only version of a\n` +
        `    performance budget that changes what gets merged.`,
    );
    return 1;
  }
  if (!quiet) ok(`budgets OK against ${b.url}`);
  return 0;
}

// --- check (all) ------------------------------------------------------------------------

async function cmdCheckAll(config, root, quiet) {
  const gates = [
    /*
      Integrity runs FIRST, deliberately.

      Every gate below reads files. If the disk emptied some of them, those gates report
      confident nonsense — a link checker finds no links, a claims scanner finds no claims,
      and the run goes green on a repository that has just been damaged. Establishing that
      the source is intact is a precondition for believing anything else in this list.
    */
    ['integrity', () => cmdCheckIntegrity(config, root, quiet)],
    ['build-id', () => cmdCheckBuildId(config, root, quiet)],
    ['external', () => cmdCheckExternal(config, root, quiet)],
    ['freshness', () => cmdCheckFreshness(config, root, quiet)],
    ['discovery', () => cmdCheckDiscovery(config, root, quiet)],
    ['links', () => cmdCheckLinks(config, root, quiet)],
    ['budgets', () => cmdCheckBudgets(config, quiet)],
  ];

  const results = [];
  for (const [name, run] of gates) {
    if (!quiet) console.log(`\n[${name}]`);
    results.push([name, await run()]);
  }

  const failed = results.filter(([, code]) => code !== 0);
  if (failed.length) {
    console.error(`\nastro-ops check FAILED — ${failed.map(([n]) => n).join(', ')}`);
    // A misconfiguration (2) outranks a content failure (1): fix the tool first.
    return failed.some(([, c]) => c === 2) ? 2 : 1;
  }
  if (!quiet) console.log(`\nastro-ops check OK — ${results.length} gates passed`);
  return 0;
}

// --- entry ------------------------------------------------------------------------------

async function main() {
  const { command, flags } = parseArgs(argv.slice(2));
  if (flags.help || !command) {
    console.log(USAGE);
    /*
      Asking for help is not a misuse. `--help` exits 0; running with no command at all
      exits 1, because that is a caller who got the invocation wrong.

      This tested `command` rather than `flags.help`, so `astro-ops --help` — which parses
      to no command — exited 1. That made the package's own `npm run selfcheck` fail on
      every machine it was ever run on, which is why nobody noticed it was failing.
    */
    exit(flags.help ? 0 : 1);
  }

  const { config, path, problems } = await loadConfig(flags.root);
  if (problems.length > 0) {
    console.error(`astro-ops: invalid config${path ? ` in ${path}` : ''}`);
    for (const p of problems) bad(p);
    exit(2);
  }

  const commands = {
    'build-id': () => cmdBuildId(config, flags.root, flags.quiet),
    'check:integrity': () => cmdCheckIntegrity(config, flags.root, flags.quiet),
    'check:build-id': () => cmdCheckBuildId(config, flags.root, flags.quiet),
    'check:external': () => cmdCheckExternal(config, flags.root, flags.quiet),
    'check:freshness': () => cmdCheckFreshness(config, flags.root, flags.quiet),
    'check:discovery': () => cmdCheckDiscovery(config, flags.root, flags.quiet),
    'check:links': () => cmdCheckLinks(config, flags.root, flags.quiet),
    'check:budgets': () => cmdCheckBudgets(config, flags.quiet),
    check: () => cmdCheckAll(config, flags.root, flags.quiet),
  };

  const run = commands[command];
  if (!run) {
    console.error(`astro-ops: unknown command "${command}"\n`);
    console.log(USAGE);
    exit(2);
  }
  exit(await run());
}

main().catch((err) => {
  console.error(`astro-ops: ${err?.stack ?? err}`);
  exit(2);
});
