/**
 * Freshness watchdog — stop publishing facts that quietly stopped being true.
 *
 * THE PROBLEM
 * -----------
 * Some pages state a fact that belongs to somebody else: a fee, a file-size limit, a
 * deadline, a rate, a spec. You verified it once. The authority changed it later and did
 * not tell you. Your build still passes, your tests still pass, your page still renders —
 * and it is now wrong, with your name on it.
 *
 * Nothing in an ordinary toolchain can see this. There is no exception, no broken link, no
 * failing assertion. The only signal is a human going back to the source, which is exactly
 * the thing nobody remembers to do a year later.
 *
 * TWO INDEPENDENT TRIPWIRES
 * -------------------------
 * They fail differently on purpose, because each covers the other's blind spot.
 *
 * 1. THE CALENDAR (works offline, covers everything). Every claim carries `lastVerified`.
 *    After `recheckMonths` it is overdue and the build FAILS. A warning window before that
 *    gives you time to act before it turns red. This catches slow rot, including sources
 *    that changed in ways no diff would reveal — a PDF re-typeset with a new number.
 *
 * 2. THE DRIFT FEED (needs a network, covers only sourced claims). Something you run —
 *    typically a weekly cron — hashes each claim's `sourceUrl` and records when the hash
 *    moves. This gate reads that feed and fails on a confirmed change, no matter how
 *    recently you verified.
 *
 * A claim with no `sourceUrl` is invisible to tripwire 2. That is not a footnote: it is the
 * single most common way a wrong number survives. `astro-ops check:freshness` reports the
 * unsourced count for exactly that reason.
 *
 * THE FAILURE MODE THAT MATTERS MOST
 * ----------------------------------
 * ⚠️ A 5xx from your OWN drift feed is a HARD FAILURE, and is treated differently from
 * being offline. This distinction was paid for: a malformed record once made the feed throw,
 * it returned 500 for days, and the check printed a warning and exited 0 the whole time. The
 * drift gate was completely off and every CI run looked green.
 *
 * A safety net that reports OK while disabled is worse than no safety net, because you stop
 * checking by hand. So: unreachable (DNS, timeout, refused) is a soft skip — a laptop on a
 * train should still be able to run checks. A 5xx means the watchdog itself is broken and
 * fails the build.
 */

/** Claims older than this many months are overdue unless they set their own recheckBy. */
export const DEFAULT_RECHECK_MONTHS = 12;
/** Days before the due date that a claim starts warning. */
export const DEFAULT_WARN_WINDOW_DAYS = 45;

/**
 * Extracts claims from a source file of object literals — TypeScript included.
 *
 * Line-scanned rather than parsed or imported. Importing means executing your data file
 * (and TS cannot be imported by node without a build step); a real parser means carrying a
 * TS parser as a dependency into everyone's build pipeline. A line scan over `key: 'value'`
 * pairs is unglamorous and survives both.
 *
 * Handles a value wrapped onto its own line, which prettier does to long URLs:
 *     officialSourceUrl:
 *       'https://example.gov/very/long/path',
 *
 * @param {string} text - File contents.
 * @param {object} [keys] - Which literal keys map to which claim field.
 * @returns {Array<{id:string,label?:string,lastVerified?:string,recheckBy?:string,sourceUrl?:string}>}
 */
export function scanClaims(text, keys = {}) {
  const k = {
    id: 'slug',
    label: 'name',
    lastVerified: 'lastVerified',
    recheckBy: 'recheckBy',
    sourceUrl: 'officialSourceUrl',
    ...keys,
  };

  // Segment on the ID key rather than scanning line by line. A line-based reader assumes
  // one key per line and silently returns ZERO claims for a perfectly ordinary single-line
  // literal — `{ slug: 'a', lastVerified: '…' },` — which then reads as "nothing to check".
  // A watchdog that reports success because it could not parse its own input is the worst
  // possible outcome, so parsing is layout-independent.
  const idRe = new RegExp(`\\b${k.id}\\s*:\\s*'([^']+)'`, 'g');
  const starts = [...text.matchAll(idRe)];
  const claims = [];

  for (let i = 0; i < starts.length; i += 1) {
    const body = text.slice(starts[i].index, starts[i + 1]?.index ?? text.length);
    const claim = { id: starts[i][1] };

    for (const field of ['label', 'lastVerified', 'recheckBy', 'sourceUrl']) {
      // `\s*` spans newlines, so a value prettier wrapped onto its own line still binds to
      // its key:   officialSourceUrl:\n      'https://…',
      const m = body.match(new RegExp(`\\b${k[field]}\\s*:\\s*'([^']+)'`));
      if (m) claim[field] = m[1];
    }
    claims.push(claim);
  }

  return claims;
}

/**
 * Reads a claim from a file that carries its dates as MODULE-LEVEL EXPORTS.
 *
 * The second shape found in the wild. Instead of many claims inside one data file, each
 * data file IS one claim and states its own provenance:
 *
 *     export const VERIFIED_ON = '2026-07-24';
 *     export const RECHECK_BY  = '2027-03-15';
 *     export const SOURCE_URL  = 'https://www.incometax.gov.in/…';
 *
 * Read by regex rather than `import`, for the same reason as `scanClaims`: a TypeScript
 * data file cannot be imported without a build step, and importing arbitrary project files
 * to check them means executing them.
 *
 * A file MISSING its date exports returns `{ found: false }` rather than an empty claim.
 * That distinction matters — a data file nobody dated is unguarded, and silently treating
 * it as "no claim here" is how a rate table goes stale for a year.
 *
 * @param {string} text - File contents.
 * @param {object} [keys] - Export names to read.
 * @returns {{found:boolean, lastVerified?:string, recheckBy?:string, sourceUrl?:string}}
 */
export function readFileConstants(text, keys = {}) {
  const k = {
    lastVerified: 'VERIFIED_ON',
    recheckBy: 'RECHECK_BY',
    sourceUrl: 'SOURCE_URL',
    ...keys,
  };
  const out = {};
  for (const [field, name] of Object.entries(k)) {
    const m = text.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*['"]([^'"]+)['"]`));
    if (m) out[field] = m[1];
  }
  return { found: Boolean(out.lastVerified || out.recheckBy), ...out };
}

/**
 * Computes the date a claim must be re-verified by.
 *
 * @param {{lastVerified?:string, recheckBy?:string}} claim
 * @param {number} recheckMonths
 * @returns {Date|null} Null when the claim carries no date at all.
 */
export function dueDate(claim, recheckMonths = DEFAULT_RECHECK_MONTHS) {
  if (claim.recheckBy) return new Date(`${claim.recheckBy}T00:00:00Z`);
  if (!claim.lastVerified) return null;
  const d = new Date(`${claim.lastVerified}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCMonth(d.getUTCMonth() + recheckMonths);
  return d;
}

/**
 * Sorts claims into overdue / due-soon / fine, and counts the unsourced.
 *
 * @param {Array<object>} claims
 * @param {object} [options]
 * @param {Date} [options.today] - Injected so tests do not depend on the clock.
 * @param {number} [options.recheckMonths]
 * @param {number} [options.warnWindowDays]
 * @returns {{overdue:Array,dueSoon:Array,dated:number,undated:Array,unsourced:Array}}
 */
export function evaluateFreshness(claims, options = {}) {
  const {
    today = new Date(),
    recheckMonths = DEFAULT_RECHECK_MONTHS,
    warnWindowDays = DEFAULT_WARN_WINDOW_DAYS,
  } = options;

  const overdue = [];
  const dueSoon = [];
  const undated = [];
  let dated = 0;

  for (const claim of claims) {
    const due = dueDate(claim, recheckMonths);
    if (!due) {
      undated.push(claim);
      continue;
    }
    dated += 1;
    const daysLeft = Math.round((due.getTime() - today.getTime()) / 86_400_000);
    const row = { ...claim, due, daysLeft };
    if (daysLeft < 0) overdue.push(row);
    else if (daysLeft <= warnWindowDays) dueSoon.push(row);
  }

  return { overdue, dueSoon, dated, undated, unsourced: claims.filter((c) => !c.sourceUrl) };
}

/**
 * Reads the drift feed and returns confirmed drifts.
 *
 * The feed is expected to return an object keyed by claim id, e.g.
 *     { "cuet": { "sourceUrl": "https://…", "detectedAt": "2026-08-16T03:00:21Z" } }
 *
 * @param {string} url - Drift feed URL.
 * @param {Array<object>} claims
 * @param {number} [timeoutMs]
 * @param {typeof fetch} [fetchImpl] - Injected for tests.
 * @returns {Promise<{status:'ok'|'unreachable'|'broken'|'disabled', drifted:Array, detail?:string}>}
 */
export async function fetchDrift(url, claims, timeoutMs = 8000, fetchImpl = fetch) {
  if (!url) return { status: 'disabled', drifted: [] };

  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    // Genuinely offline. Soft skip — see the header.
    return { status: 'unreachable', drifted: [], detail: err?.message ?? String(err) };
  }

  if (res.status >= 500) {
    // OUR endpoint is erroring. The watchdog is broken, not absent. Hard fail.
    return { status: 'broken', drifted: [], detail: `HTTP ${res.status}` };
  }
  if (!res.ok) {
    return { status: 'unreachable', drifted: [], detail: `HTTP ${res.status}` };
  }

  let flags;
  try {
    flags = await res.json();
  } catch (err) {
    // Malformed JSON from our own feed is the same class of failure as a 5xx: the gate
    // cannot do its job and must not pretend otherwise.
    return { status: 'broken', drifted: [], detail: `invalid JSON: ${err?.message ?? err}` };
  }

  const named = claims
    .filter((c) => c.sourceUrl && flags && flags[c.id])
    .map((c) => ({ ...c, ...flags[c.id] }));

  /*
    Being named by the feed is not the same as having changed.

    A watchdog also writes a record when it could not FETCH the source at all — an upstream
    TLS failure, a timeout, a 5xx from someone else's server. Reporting that as "the source
    changed" states the opposite of what happened and sends someone off to re-verify a page
    that never moved. Worse, it blocks a deploy for a reason the reader cannot act on, and a
    gate that cries wolf is one people learn to bypass.

    The test is deliberately conservative: treat a record as changed UNLESS both hashes are
    present and equal. A feed that reports no hashes at all still counts as drift, because
    the absence of evidence is not evidence the source held still.
  */
  const unchanged = (e) => Boolean(e.baselineHash && e.latestHash && e.baselineHash === e.latestHash);
  const drifted = named.filter((e) => !unchanged(e));
  const unchecked = named.filter((e) => unchanged(e) && e.fetchError);

  return { status: 'ok', drifted, unchecked };
}
