/**
 * Tests for the freshness watchdog.
 *
 * `today` is injected everywhere. A test that reads the real clock passes today and fails
 * in eleven months, which is precisely the failure mode this module exists to prevent —
 * it would be embarrassing to have it in the module's own tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  scanClaims,
  readFileConstants,
  dueDate,
  evaluateFreshness,
  fetchDrift,
  DEFAULT_RECHECK_MONTHS,
} from '../src/freshness.mjs';

const TODAY = new Date('2026-08-17T00:00:00Z');

test('scanClaims reads object literals out of a TypeScript source', () => {
  const src = `
  {
    slug: 'cuet',
    name: 'CUET',
    sizeKB: [10, 200],
    officialSourceUrl: 'https://example.gov/bulletin',
    lastVerified: '2026-08-17',
  },
  {
    slug: 'ugc-net',
    name: 'UGC NET',
    lastVerified: '2026-03-01',
  },`;
  const claims = scanClaims(src);
  assert.equal(claims.length, 2);
  assert.equal(claims[0].id, 'cuet');
  assert.equal(claims[0].sourceUrl, 'https://example.gov/bulletin');
  assert.equal(claims[1].sourceUrl, undefined, 'an unsourced claim must stay unsourced');
});

test('scanClaims reads single-line object literals too', () => {
  // A line-based reader returns ZERO for this perfectly ordinary layout, and zero claims
  // reads as "nothing to check" — a watchdog silently guarding nothing.
  const src = `
  { slug: 'a', name: 'A', lastVerified: '2026-01-01', officialSourceUrl: 'https://x/a' },
  { slug: 'b', name: 'B', lastVerified: '2026-02-01' },`;
  const claims = scanClaims(src);
  assert.equal(claims.length, 2);
  assert.equal(claims[0].sourceUrl, 'https://x/a');
  assert.equal(claims[1].lastVerified, '2026-02-01');
  assert.equal(claims[1].sourceUrl, undefined, 'must not bleed a value from the previous claim');
});

test('scanClaims handles a URL prettier wrapped onto its own line', () => {
  // Real formatters do this to long URLs. Missing it silently turns a sourced claim into
  // an unsourced one — the exact state that hides a wrong number longest.
  const src = `
  {
    slug: 'wrapped',
    officialSourceUrl:
      'https://example.gov/a/very/long/path/that/prettier/wraps',
    lastVerified: '2026-01-01',
  },`;
  assert.equal(scanClaims(src)[0].sourceUrl, 'https://example.gov/a/very/long/path/that/prettier/wraps');
});

test('dueDate honours recheckBy over the default window', () => {
  assert.equal(
    dueDate({ lastVerified: '2026-01-01' }, DEFAULT_RECHECK_MONTHS).toISOString().slice(0, 10),
    '2027-01-01',
  );
  assert.equal(
    dueDate({ lastVerified: '2026-01-01', recheckBy: '2026-06-01' }).toISOString().slice(0, 10),
    '2026-06-01',
  );
  assert.equal(dueDate({}), null, 'a claim with no dates has no due date');
});

test('sorts overdue, due-soon and fine using an injected clock', () => {
  const claims = [
    { id: 'old', lastVerified: '2025-01-01' },       // long overdue
    { id: 'soon', lastVerified: '2025-09-20' },      // due 2026-09-20, ~34d away
    { id: 'fine', lastVerified: '2026-08-01' },      // due 2027-08-01
    { id: 'undated' },
  ];
  const r = evaluateFreshness(claims, { today: TODAY, warnWindowDays: 45 });
  assert.deepEqual(r.overdue.map((c) => c.id), ['old']);
  assert.deepEqual(r.dueSoon.map((c) => c.id), ['soon']);
  assert.equal(r.dated, 3);
  assert.deepEqual(r.undated.map((c) => c.id), ['undated']);
});

test('reports claims with no source URL separately from overdue ones', () => {
  // These are the ones nothing can watch drift. A freshly-verified unsourced claim is
  // still a risk, so it must not be hidden just because its date is recent.
  const r = evaluateFreshness(
    [
      { id: 'a', lastVerified: '2026-08-01', sourceUrl: 'https://x/' },
      { id: 'b', lastVerified: '2026-08-01' },
    ],
    { today: TODAY },
  );
  assert.equal(r.overdue.length, 0);
  assert.deepEqual(r.unsourced.map((c) => c.id), ['b']);
});

test('drift: a 5xx from our OWN feed is BROKEN, not merely unreachable', async () => {
  // The distinction this module exists for. A malformed record once made the feed 500 for
  // days while the check printed a warning and exited 0 — the gate was off and every run
  // looked green.
  const res = await fetchDrift('https://x/feed', [], 100, async () => ({ status: 503, ok: false }));
  assert.equal(res.status, 'broken');
});

test('drift: a network error is a soft skip, so offline work still runs', async () => {
  const res = await fetchDrift('https://x/feed', [], 100, async () => {
    throw new Error('getaddrinfo ENOTFOUND');
  });
  assert.equal(res.status, 'unreachable');
});

test('drift: malformed JSON from our feed is BROKEN too', async () => {
  const res = await fetchDrift('https://x/feed', [], 100, async () => ({
    status: 200,
    ok: true,
    json: async () => {
      throw new Error('Unexpected token <');
    },
  }));
  assert.equal(res.status, 'broken', 'a feed we cannot parse cannot be doing its job');
});

test('drift: flags only sourced claims the feed actually names', async () => {
  const claims = [
    { id: 'a', sourceUrl: 'https://x/a' },
    { id: 'b', sourceUrl: 'https://x/b' },
    { id: 'c' }, // unsourced — must never be reported as drifted
  ];
  const res = await fetchDrift('https://x/feed', claims, 100, async () => ({
    status: 200,
    ok: true,
    json: async () => ({ a: { detectedAt: '2026-08-16' }, c: { detectedAt: '2026-08-16' } }),
  }));
  assert.equal(res.status, 'ok');
  assert.deepEqual(res.drifted.map((c) => c.id), ['a']);
});

/*
  This is the case that shipped broken. tryquickimg's CUET source returned HTTP 525 for one
  scheduled run, so the worker wrote a record carrying fetchError — with baselineHash and
  latestHash still identical, because the page had not changed. The gate saw a record and
  called it "changed", blocking a deploy and telling the reader to re-verify a page that had
  not moved. Those are opposite claims and must not share a report line.
*/
test('drift: a fetch error with matching hashes is not a change', async () => {
  const claims = [{ id: 'cuet', sourceUrl: 'https://x/cuet' }];
  const res = await fetchDrift('https://x/feed', claims, 100, async () => ({
    status: 200,
    ok: true,
    json: async () => ({ cuet: { baselineHash: 'abc', latestHash: 'abc', fetchError: 'HTTP 525' } }),
  }));
  assert.equal(res.status, 'ok');
  assert.deepEqual(res.drifted, [], 'identical hashes mean the source did not change');
  assert.deepEqual(res.unchecked.map((c) => c.id), ['cuet'], 'but it still could not be checked');
});

test('drift: differing hashes are still a change', async () => {
  const claims = [{ id: 'cuet', sourceUrl: 'https://x/cuet' }];
  const res = await fetchDrift('https://x/feed', claims, 100, async () => ({
    status: 200,
    ok: true,
    json: async () => ({ cuet: { baselineHash: 'abc', latestHash: 'zzz' } }),
  }));
  assert.deepEqual(res.drifted.map((c) => c.id), ['cuet']);
  assert.deepEqual(res.unchecked, []);
});

test('drift: a feed reporting no hashes is still treated as a change', async () => {
  // Conservative on purpose: absence of evidence is not evidence the source held still.
  const claims = [{ id: 'a', sourceUrl: 'https://x/a' }];
  const res = await fetchDrift('https://x/feed', claims, 100, async () => ({
    status: 200,
    ok: true,
    json: async () => ({ a: { detectedAt: '2026-08-16' } }),
  }));
  assert.deepEqual(res.drifted.map((c) => c.id), ['a']);
});

test('drift: no configured feed is "disabled", not a failure', async () => {
  const res = await fetchDrift(null, [], 100);
  assert.equal(res.status, 'disabled');
  assert.equal(res.drifted.length, 0);
});

test('readFileConstants reads module-level date exports', () => {
  // The second shape found in the wild: each data file IS one claim.
  const src = `
    export const VERIFIED_ON = '2026-07-24';
    export const RECHECK_BY = '2027-03-15';
    export const SOURCE_URL = 'https://www.incometax.gov.in/iec/foportal/';
    export const SLABS = [];`;
  const r = readFileConstants(src);
  assert.equal(r.found, true);
  assert.equal(r.lastVerified, '2026-07-24');
  assert.equal(r.recheckBy, '2027-03-15');
  assert.equal(r.sourceUrl, 'https://www.incometax.gov.in/iec/foportal/');
});

test('readFileConstants reports an UNDATED file rather than an empty claim', () => {
  // A data file nobody dated is unguarded. Returning a blank claim would let it pass
  // every run forever, which is how a rate table goes stale for a year.
  assert.equal(readFileConstants('export const RATES = [];').found, false);
});
