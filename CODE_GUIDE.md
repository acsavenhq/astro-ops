# astro-ops — Code Guide (for beginners)

The README tells you how to *use* this package. This file explains how it *works*, so you can
change it without guessing. No prior knowledge of this codebase is assumed.

---

## 1. What is this project, in one paragraph?

`@acsaven/astro-ops` is a set of six checks ("gates") you run against a built static site
before shipping it. Each gate catches one class of mistake that is invisible in normal
testing — a stale cache key, a page linking to a page that no longer exists, a third-party
script that crept into a privacy-first site, a data file that quietly went out of date. It is
a command-line tool with **zero runtime dependencies**: everything is plain Node.

Three sibling sites (TryQuickImg, TryCalculatingNow, TryDevSnip) consume it from GitHub by
tag — `"@acsaven/astro-ops": "github:acsavenhq/astro-ops#v0.2.2"`. Acsaven does not use it;
it is a plain static site with its own scripts.

**Pushing to `main` does not ship it.** Those sites pin a tag, so a new release means
tagging here and bumping the ref there. It used to be an unpinned `github:acsavenhq/astro-ops`,
where any install pulled whatever `main` happened to be — the gates guarding a deploy could
change with nothing recording that they had. It is also published to npm now. See
**Updating** in the README for both halves.

---

## 2. The mental model

```
your site  ->  npm run build  ->  dist/         (plain HTML, CSS, JS on disk)
                                    |
                                    v
                            astro-ops <gate>     reads dist/, exits 0 or 1
```

Every gate has the same shape:

1. read `astro-ops.config.mjs` (merged over built-in defaults),
2. walk `dist/`,
3. print what it found,
4. `process.exit(1)` if something is wrong.

A gate never edits your site. The one exception is `build-id`, which *writes* one file — and
that is the entire point of it.

---

## 3. The folder map

| Path | What it is |
|---|---|
| `bin/astro-ops.mjs` | The CLI. Parses the subcommand, loads config, calls into `src/`, prints results, sets the exit code. |
| `src/index.mjs` | Public exports, for importing the package as a library instead of a CLI. |
| `src/config.mjs` | Defaults for every gate, plus `resolveConfig()` and `validate()`. **Read this first** — it documents every option. |
| `src/build-id.mjs` | Content-hashed build id. The most consequential file here; see section 5. |
| `src/links.mjs` | Internal-link and trailing-slash checking. |
| `src/external-assets.mjs` | Tripwire for third-party scripts, styles, fonts and images. |
| `src/discovery.mjs` | Title/description length, canonical vs route, sitemap vs noindex agreement. |
| `src/freshness.mjs` | "This data was verified on DATE" expiry checking. |
| `src/budgets.mjs` | Page-weight budgets. |
| `test/*.test.mjs` | One test file per gate, run with Node's built-in runner. |
| `template/` | A complete example Astro site with all of this wired up. |

---

## 4. How the config works

Your site has an `astro-ops.config.mjs` exporting one object. Each top-level key is a gate:

```js
export default {
  external: { allowHosts: ['pagead2.googlesyndication.com'] },
  freshness: { scan: { file: 'src/data/docs.ts' } },
  discovery: { rules: { maxTitle: 62, maxDescription: 165 } },
}
```

`resolveConfig()` merges yours over the defaults **one level deep per section**. That means
array options such as `skipDirs` **replace** rather than concatenate.

That is deliberate. Silent concatenation is worse: you could never remove a default you
disagreed with, and the value actually in force would stop being visible in your own config
file. Here, what you write is what runs.

`validate()` then rejects nonsense before any gate does work — an empty `include`, an invalid
`constName`, a hash length outside 8–64. It also **reports unknown sections rather than
dropping them**, so a newer config against an older toolkit tells you, instead of silently
ignoring half your settings.

---

## 5. `build-id` — the important one

### What it does

Hashes everything in `dist/` and writes a single constant to a file you commit:

```js
export const BUILD_ID = 'c49739f0c7cd5b60'
```

Your edge worker puts that value in its cache key. A deploy that changes something produces a
new id, which moves the whole site to a fresh keyspace — every stale cached page becomes
unreachable at once. A deploy that changes nothing keeps the same id, and therefore keeps its
warm cache.

### Why it is a content hash and not a timestamp

This is the part that cost a production incident, so it is worth understanding properly.

Most projects grow **two** ways to deploy — CI plus a manual command. That is a good thing:
either can ship when the other is unavailable. But it means the same commit can be deployed
by two different pipelines, and a non-deterministic id cannot survive that:

- A git-integration build has no build step. It uploads the repo as-is, shipping whatever
  value is **committed** in your build-id file.
- A local deploy command rotates that file **on disk**, and unless you commit the result the
  repo still holds the old value.

Push a content change while the rotated id sits uncommitted and you ship new HTML under the
**previous** id. The cache key never changed, so every colo keeps serving the old page. The
origin is correct. The deploy "succeeded". Nothing in a test suite can see it, because only
the cache is wrong.

Hashing the deployed content fixes it at the root: both pipelines compute the same id for the
same commit, any real change produces a new id, and running it twice is a no-op.

**So: always commit the file it writes.** The CLI says so on every run for exactly this reason.

### The sorted walk

`walk()` sorts entry names before recursing, and paths are normalised to forward slashes.
Without that, the same tree hashes differently on Windows and on Linux CI — which would make
the two pipelines disagree, i.e. precisely the failure this module exists to prevent.

### `build-id --check`

Recomputes and fails when the committed file is stale. Run it in CI. This turns "someone
forgot to regenerate" from a silent stale-cache bug into a failed build.

---

## 6. The other five gates, briefly

- **`links`** — every internal `href` in `dist/` must resolve to a file that exists, and URLs
  must agree with your trailing-slash setting. This is the gate that catches you after
  deleting a page whose siblings still link to it.
- **`external`** — fails when built HTML/CSS loads a script, stylesheet, font or image from a
  host you have not named. `allowHosts` is **empty by default on purpose**: a toolkit that
  ships a permissive allowlist teaches the wrong lesson on day one. You should have to name
  every third party you accept, one at a time, and watch that list grow.
- **`discovery`** — title/description lengths, canonical-vs-route agreement, and
  sitemap-vs-`noindex` agreement (a page cannot honestly be both).
- **`freshness`** — parses `VERIFIED_ON` / `RECHECK_BY` markers out of a data file and fails
  when something is past due. Parsing is layout-independent: an earlier line-based version
  returned zero matches for single-line literals and reported "no claims configured", which
  is a gate that passes because it is not looking.
- **`budgets`** — page weight ceilings.

---

## 7. Running and testing it locally

```bash
npm test           # node --test over test/*.test.mjs — no framework
npm run selfcheck  # runs the gates against the bundled template/ site
```

To try a change against a real site without publishing:

```bash
cd ../../TryQuickImg/tryquickimg
npm install ../../AstroStarter/astro-production-starter
npm run check:links
```

---

## 8. Recipes

**Add a new gate** → create `src/mygate.mjs` exporting a function that takes resolved config
and returns a result object; add its defaults to `DEFAULTS` in `src/config.mjs`; add
validation to `validate()`; wire a subcommand in `bin/astro-ops.mjs`; add
`test/mygate.test.mjs`. Follow the shape of `links.mjs` — it is the smallest one.

**Add a config option** → add it to that gate's defaults block in `src/config.mjs` with a
comment saying what it does, then validate it. The defaults are the documentation here.

**Change the hash input** → think hard first. Changing what `build-id` hashes changes every
id, which cold-starts every cached page on every consuming site. Assets are excluded on
purpose: they are separately-hashed URLs, so changing one cannot make cached HTML wrong.

**Ship it** → merging to `main` is not shipping. Consumers pin, so a release is three acts:
`npm version patch`, push the tag, `npm publish --access public`. Then bump the ref in each
consuming site and run `npx astro-ops check` there before deploying.

Skipping the bump is the quiet failure mode: `main` has the fix, every site still runs the
old gates, and nothing anywhere says so.

---

## 9. Things worth knowing before they bite you

- **A gate that cannot fail is not a gate.** Before trusting a new check, deliberately break
  the thing it guards and confirm it goes red. Gates in this family have previously passed
  while the thing they guarded was wide open.
- **`spawnSync` blocks the Node event loop.** If a gate needs to start a local server and hit
  it, use async `spawn` — `spawnSync` deadlocks against an in-process server.
- **On Windows, `npx` is `npx.cmd`** and needs `shell: true`, which then strips quotes from
  JSON arguments. Pass a file path instead of inline JSON.
- **Do not suppress stderr when running generators.** A syntax error becomes an invisible
  no-op that looks like success.

---

## 10. Where do I look?

| I want to… | Go to |
|---|---|
| See every option a gate accepts | `src/config.mjs` |
| Understand the cache-key story | `src/build-id.mjs` header, and section 5 above |
| Add a subcommand | `bin/astro-ops.mjs` |
| See a working wired-up site | `template/` |
| Know why a gate exists at all | the header comment at the top of its `src/*.mjs` |
