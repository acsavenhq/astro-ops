# Astro Production Starter

A working Astro site with six production gates already wired into its build and CI.

Astro themes sell **design** — the part a competent developer already has. This is the
layer above it: the checks that notice when a correct-looking site has quietly stopped
being correct.

```bash
npm install
npm run build     # postbuild writes build-id.js from a hash of dist/
npm run check     # astro check + all six gates
```

Every gate is green out of the box, and the site scores **100 / 100 / 96 / 100** on
Lighthouse (performance / accessibility / best-practices / SEO).

---

## The six gates

Each answers a failure where the code is fine, the build passes, the page renders — and
only the edge, the crawler, or the calendar is wrong. Those are the bugs that survive
review and surface months later.

| Gate | Catches |
|---|---|
| `check:build-id` | A deploy silently serving last week's HTML from a cache that was never invalidated |
| `check:freshness` | A fact you verified once that the authority changed without telling you |
| `check:external` | A third-party script, font or embed that appeared without anyone deciding to add it |
| `check:discovery` | A sitemap and a set of pages that no longer agree |
| `check:links` | A link to a page you no longer ship, and trailing-slash drift |
| `check:budgets` | A slow regression nobody would have blocked, because the score was only ever a dashboard |

`npm run check:ci` runs the first five. `npm run check:budgets` runs the sixth — it needs a
server, and `scripts/with-server.mjs` starts and stops one for you.

## Prove they work

Do any of these, then run the matching check. Each one turns a green build red — verified,
not asserted:

| Break this | Fails with |
|---|---|
| Edit a file in `dist/`, don't rebuild | `build-id.js is STALE — committed …, content hashes to …` |
| Add `<script src="https://cdn.jsdelivr.net/npm/x">` | `2 third-party asset load(s)` |
| Point a canonical at a page that is not itself | `canonical points to /wrong/ but this page is /about/` |
| Add `noindex` to a page that is in the sitemap | `listed in the sitemap but the page is noindex` |
| Set `lastVerified` in `src/data/claims.ts` to 2023 | `1 claim(s) OVERDUE for re-verification` |

## What you get

A working site, not a demo of six checks:

- **Blog** on Astro content collections with a strict schema — a missing description or a
  malformed date fails the build, naming the file and the field.
- **Generated `sitemap.xml`, `rss.xml`, `robots.txt` and `llms.txt`** — all from the same
  content and the same draft rule, so none of them can drift from the pages.
- **Drafts** that build (so you can preview them) but carry `noindex` and stay out of the
  sitemap and the feed.
- **Dark/light theme** applied before first paint, so dark-mode visitors never see a flash.
- **Structured data**: Organization, WebPage, BlogPosting and BreadcrumbList, wired to one
  `@id` so a search engine reads the pages as one entity rather than unrelated documents.
- **Accessibility basics** most templates skip: skip link, visible focus ring, landmark
  structure, `color-scheme`.
- **One config file** that everything derives from.

```
src/config.ts              site name, URL, author, nav — the only file you must edit
src/layouts/Base.astro     title, description, canonical, OG, JSON-LD — emitted once
src/content.config.ts      blog schema; title budget derived from the site suffix
src/content/blog/          markdown posts
src/pages/                 index, about, 404, blog, and the generated .txt/.xml routes
src/data/claims.ts         facts that belong to somebody else, with dates and sources
astro-ops.config.mjs       every gate's settings, commented with the reason for each
worker.js                  Cloudflare Worker; keys the edge page cache on BUILD_ID
.github/workflows/ci.yml   build → gates → deploy, in that order
```

**Edit `src/config.ts` first.** It is the only place your domain appears. It used to be
typed into `astro.config.mjs`, `robots.txt` and `llms.txt` separately — change your domain
and two of the three silently keep pointing at the old one, because none of them is wrong
on its own. That is the same class of bug the gates exist to catch, and it was sitting in
the starter.

### The title budget

The rendered `<title>` is `"Post — Site"`, so the site suffix spends part of a fixed 60
character budget. `src/content.config.ts` derives the remaining allowance from
`SITE.titleSuffix` and enforces it in the post schema, so an over-long title fails when you
write the post — naming the file and the field — instead of surfacing later as a gate
failure on the final string.

If it feels tight, set `titleSuffix: ''` and give articles the whole budget. What you should
not do is raise `maxTitle` past what search results actually display; that only moves the
truncation somewhere you cannot see it.

## Things that look like defaults and are not

**`site` in `astro.config.mjs` is required.** The layout derives every canonical from it.
Leave it unset and canonicals become relative to whatever host served the build — which is
how a staging deploy tells Google that staging is canonical.

**The sitemap is generated from the pages**, not maintained beside them. A hand-kept list
drifts the first time someone renames a route, and the drift is invisible because each half
still looks correct alone. `noindex` pages are excluded, and the gate fails if one appears.

**`build-id.js` is committed, and `.gitignore` deliberately does not cover it.** Deploy
pipelines ship the *committed* id. Ignoring it recreates the exact stale-cache bug the gate
exists to prevent.

**There is no cache-purge step in the CI workflow.** Pages are keyed on `BUILD_ID`; assets
are immutable by filename. Nothing is left for a purge to fix, and `purge_everything` would
throw away the asset cache on every release.

**`external.allowHosts` is empty.** Every third party you accept gets named there, one at a
time, so the list is visible in review and grows where you can see it.

**Performance is advisory; accessibility blocks.** Lighthouse performance moves several
points between runs on identical code. A tight blocking threshold produces a coin-flip
gate, and a gate understood as a coin flip protects nothing.

**`scripts/with-server.mjs` uses async `spawn`, never `spawnSync`.** The server runs in the
same process; `spawnSync` blocks the event loop, so the server accepts connections and
answers none. The failure looks like "the server is not running" when it is running and
gagged.

## The engine

All six gates come from [`@acsaven/astro-ops`](https://github.com/acsavenhq/astro-ops) —
MIT, zero runtime dependencies, installed as a git dependency so there is no registry
account involved. It is free and stays free.

If you have to edit a file inside that package to fit your project, that is a missing config
option and worth reporting. Patching it locally puts you back in the copy-drift trap it
exists to end.

## Deploying

Configured for Cloudflare Workers (`wrangler.toml`). The worker serves `dist/` and caches
page HTML at the edge keyed on `BUILD_ID`, which is what makes a one-year TTL safe.

Any static host works — drop `worker.js` and `wrangler.toml`, keep everything else. You
lose the edge page cache; the other five gates are host-agnostic.
