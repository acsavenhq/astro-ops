<p align="center">
  <img src="https://raw.githubusercontent.com/acsavenhq/astro-ops/main/docs/astro-ops-banner.png" alt="@acsaven/astro-ops — production gates for Astro sites" width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@acsaven/astro-ops"><img alt="npm version" src="https://img.shields.io/npm/v/@acsaven/astro-ops?color=34E89A&labelColor=0C1512"></a>
  <a href="https://github.com/acsavenhq/astro-ops/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/npm/l/@acsaven/astro-ops?color=34E89A&labelColor=0C1512"></a>
  <img alt="node" src="https://img.shields.io/node/v/@acsaven/astro-ops?color=34E89A&labelColor=0C1512">
  <img alt="zero dependencies" src="https://img.shields.io/badge/dependencies-0-34E89A?labelColor=0C1512">
</p>

# @acsaven/astro-ops

Production gates for Astro sites: the operational work that keeps a site *correct* six
months later, when nobody is looking at it.

Extracted from four sites that run these gates in production — not written as a demo. It
exists because the same ~20 build scripts had been copy-pasted into every repo and were
drifting. Every check here answers something that went wrong once, and the comment above
it says what.

> **Status: stable.** All seven gates are built, tested, and running in production on three
> live sites. [`template/`](https://raw.githubusercontent.com/acsavenhq/astro-ops/tree/main/template) is a working Astro site with every gate wired into
> its build and CI — green out of the box, and each documented failure verified to fail.

---

New to this codebase? Read **[CODE_GUIDE.md](CODE_GUIDE.md)** — it explains how the
internals work and why, assuming no prior knowledge.

## Why this exists

The four sites it came from had accumulated the same ~20 build scripts, copy-pasted into
each repo. Measured before extraction:

| | |
|---|---|
| Core scripts still **byte-identical** across 3 repos | **7 of 12** |
| The other 5 | differed by 1–4 lines — a site name, a path, a threshold |

The logic never diverged. Only the config did. But the copies were drifting anyway,
because a fix landed in whichever repo hit the bug first and the other two kept the
defect. One of them had been carrying a known-broken build id for months after another
repo had already fixed it.

That is the whole thesis: **one maintained implementation, one config file per site.**

## What is in the box

Each gate answers a failure that a normal test suite cannot see, because in every case
the origin is fine and only the edge, the crawler, or the calendar is wrong.

| Gate | Catches | Command |
|---|---|---|
| **Source integrity** | A machine out of disk silently emptying your source files mid-build, and a build about to do it | `check:integrity` |
| **Content-hashed build id** | A deploy silently serving last week's HTML from a cache that was never invalidated | `check:build-id` |
| **Freshness watchdog** | A fact you verified once that the authority changed without telling you | `check:freshness` |
| **External-asset tripwire** | A third-party script, font or embed that appeared without anyone deciding to add it | `check:external` |
| **Discovery wiring** | A sitemap and a set of pages that no longer agree — noindex conflicts, canonicals pointing at 404s | `check:discovery` |
| **Link integrity** | A link to a page you no longer ship, and trailing-slash drift that costs a redirect hop | `check:links` |
| **Performance budgets** | A slow regression nobody would have blocked, because the score was only ever a dashboard | `check:budgets` |

`astro-ops check` runs all seven and reports **every** failure, not just the first — a CI run
that surfaces one problem per push turns a five-minute fix into five pushes.

**Integrity runs first**, because every other gate reads files: if the disk emptied some of
them, a link checker finds no links and a claims scanner finds no claims, and the run goes
green on a repository that was just damaged. A write that runs out of space does not throw —
it leaves the file empty, and nothing downstream notices, because an emptied module simply
exports nothing and a deleted test reports zero failures. Set `integrity.minFreeBytes: 0` to
skip the disk floor on a platform that cannot report free space; the empty-file scan still
runs.

## Install

From npm:

```sh
npm i -D @acsaven/astro-ops
```

Or as a git dependency, which is how the Try family installs it:

```jsonc
// package.json
{
  "devDependencies": {
    "@acsaven/astro-ops": "github:acsavenhq/astro-ops#v0.2.2"
  }
}
```

`npm ci` resolves git dependencies natively, so CI needs no extra setup.

Zero runtime dependencies. It installs into your build pipeline, so every dependency it
carried would become one you inherit — it carries none.

## Updating

**Nothing here updates itself.** npm never pushes a new version at an installed project: a
range only re-resolves on a fresh install or an explicit `npm update`, and a committed
`package-lock.json` pins the resolved version until something changes it.

What a given consumer gets:

| declared            | fresh install | `npm update` | left alone |
| ------------------- | ------------- | ------------ | ---------- |
| `^0.2.2` / `~0.2.2` | newest 0.2.x  | newest 0.2.x | unchanged  |
| `0.2.2` exact       | 0.2.2         | 0.2.2        | unchanged  |
| `github:…#v0.2.2`   | v0.2.2        | v0.2.2       | unchanged  |

The Try sites pin the git tag deliberately. They used to say `github:acsavenhq/astro-ops`
with no ref, so every install pulled whatever `main` happened to be — meaning the gates
guarding a deploy could change without anything recording that they had. A pinned tag costs
a manual bump and buys the ability to say which version of the checks a given release
actually passed.

To move a site to a new release:

```sh
npm i -D github:acsavenhq/astro-ops#v0.2.3
npx astro-ops check          # confirm the gates still pass before deploying
```

Cutting a release, for whoever does it next:

```sh
npm test                     # the gates gate themselves
npm version patch            # or minor / major
git push && git push --tags
npm publish --access public  # 2FA prompts in a browser
```

Publishing to npm and tagging git are separate acts, and both are needed: the registry
serves anyone who installs by name, the tag serves the sites that install by ref. Shipping
one without the other leaves the two disagreeing about what `0.2.x` means.

## Quick start

Add the gate to your build and your CI:

```jsonc
// package.json
{
  "scripts": {
    "postbuild": "astro-ops build-id",
    "check": "astro-ops check"
  }
}
```

```yaml
# .github/workflows/ci.yml
- run: npm run build
- run: npm run check          # fails if the committed build id is stale
```

Then use the id in whatever keys your edge cache:

```js
import { BUILD_ID } from './build-id.js';

const key = new URL(request.url);
key.searchParams.set('__build', BUILD_ID);
```

Commit `build-id.js`. That is the point — see below.

## Configuration

Optional. A project with no config file gets the defaults, which are the values that were
actually running in production rather than a neutral guess.

```js
// astro-ops.config.mjs
export default {
  buildId: {
    include: ['dist'],          // hashed — what you DEPLOY, not what you wrote
    out: 'build-id.js',
    constName: 'BUILD_ID',
    length: 16,
  },

  external: {
    // Empty by default, on purpose. Every third party you accept has to be named here,
    // one at a time, so the list is visible and grows where you can see it.
    allowHosts: ['api.producthunt.com'],
  },

  freshness: {
    // Point it at the file holding your claims. It reads `key: 'value'` literals without
    // importing or parsing the file, so TypeScript is fine.
    scan: { file: 'src/data/specs.ts' },
    recheckMonths: 12,
    warnWindowDays: 45,
    // Optional second tripwire: a feed of { claimId: { detectedAt } } that something you
    // run — typically a weekly cron — updates when a source page's hash changes.
    driftApi: 'https://example.com/api/freshness',
    // Fail when a claim names no source. Off by default; on is stricter and better.
    requireSourceUrl: false,
  },

  discovery: {
    ignoreRoutes: [],
    rules: { maxTitle: 60, maxDescription: 160, requireJsonLd: false },
  },

  budgets: {
    // Null skips the gate. Point it at a server you started in CI.
    url: 'http://127.0.0.1:4173/',
    categories: {
      accessibility: { min: 90, blocking: true },
      performance: { min: 80, blocking: false },
    },
  },
};
```

### Why performance is advisory by default

Lighthouse performance moves several points between runs on identical code, and further
between a laptop and a loaded CI runner. Made blocking at a tight threshold it fails
randomly, people learn to re-run until it passes, and a gate understood as a coin flip
protects nothing. Accessibility is close to deterministic, so it blocks. Set performance
blocking only at a threshold loose enough that tripping it means something really broke.

Array options **replace** the defaults rather than merging with them, so you can drop a
default you disagree with and your config file always shows the effective value.

If you have to edit a script inside this package to make it fit your project, that is a
missing config option — please report it. Patching locally puts you straight back in the
copy-drift trap.

---

## The build id, and why it is not a timestamp

This is the module people are most likely to think they can write in five minutes, so it
is worth the detail.

A build id keys your edge cache. Change the id, and every cached page becomes unreachable
at once — that is how you invalidate a CDN that has no purge API worth trusting.

**The trap:** most projects grow a second way to deploy — CI *plus* a manual command, or a
host's git integration *plus* a CLI. That is good; either can ship when the other is down.
But it means the same commit can be deployed by two pipelines, and a random or timestamped
id cannot survive that:

- A git-integration build usually has **no build step**. It uploads the repo as-is, so it
  ships whatever is **committed** in your build-id file.
- A local deploy command rotates that file **on disk**. Unless you commit the result, the
  repo still holds the old value.

Push a content change while the rotated id sits uncommitted, and you ship new HTML under
the **previous** id. The cache key never changed, so every colo keeps serving the old page.
The origin is correct. The deploy "succeeded". Nothing in CI can see it.

This is not hypothetical. It is the failure this module was written in response to: a page
whose origin served the new content while the public URL kept returning the pre-change
copy, from every colo, until someone thought to look at the cache key.

Hashing the deployed content fixes it at the root:

- Both pipelines compute the **same id for the same commit**, so the committed value is
  always correct.
- Any real change produces a new id, so the cache still busts exactly when it should.
- It is **idempotent** — running it twice is a no-op, so your working tree stops drifting
  and the file stops appearing in unrelated diffs.

A random id also throws away your entire edge cache on every deploy, which is why a long
TTL never seems to pay off. Content hashing keeps the warm cache across deploys that did
not change anything.

**`astro-ops check:build-id` is the half that matters.** Emitting the id is easy to
remember on the day you set it up. The check is what turns "someone forgot to regenerate"
from a silent stale-cache bug into a failed build, a year later, when you have forgotten
this file exists.

### Exit codes

Because these run unattended and the output is all a human sees when one fails at 2am:

| Code | Meaning |
|---|---|
| `0` | Pass |
| `1` | A gate failed — the site has a problem |
| `2` | The tool is misconfigured — a config error must not look like a content failure |

## Development

```bash
npm test        # node:test, no test-framework dependency
```

The tests are not incidental. Each one pins a property that the guarantee "both pipelines
compute the same id for the same commit" depends on — stable sort order across platforms,
path-sensitivity so a rename busts the cache, `\0` delimiters so swapping two files'
contents cannot collide, and a `fileCount` of zero surfacing as an error instead of a
constant id forever.

---

## The starter

[`template/`](https://raw.githubusercontent.com/acsavenhq/astro-ops/tree/main/template) is a complete Astro site with all seven gates wired into its build
and CI. Clone it, run `npm install && npm run check`, and every gate reports.

It scores 100 / 100 / 96 / 100 on Lighthouse, carries zero npm vulnerabilities, and its
README lists five ways to deliberately break it — each verified to produce the failure it
claims, not asserted.
