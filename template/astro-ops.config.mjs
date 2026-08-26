/**
 * Production gates for this site. See https://github.com/acsavenhq/astro-ops
 *
 * Every value below is deliberate. Read the comments before loosening one — each is
 * tightened against a specific failure, and the loose version usually looks fine right up
 * until it does not.
 */
export default {
  buildId: {
    // Hashes what you DEPLOY, not what you wrote. Two different sources can produce
    // identical output, and rotating the cache for those throws away a warm edge for no
    // reader-visible reason.
    include: ['dist'],
    out: 'build-id.js',
    constName: 'BUILD_ID',
  },

  external: {
    /*
      Empty. Every third party you accept gets named here, one at a time, so the list is
      visible in review and grows where you can see it. If a build fails on something you
      genuinely want, adding a hostname is a deliberate act — which is the point.
    */
    allowHosts: [],
  },

  freshness: {
    scan: { file: 'src/data/claims.ts', keys: { id: 'slug', label: 'name' } },
    recheckMonths: 12,
    warnWindowDays: 45,
    /*
      An endpoint you host that reports which sources changed since you last accepted them
      — typically written by a weekly cron that hashes each officialSourceUrl. Null here
      because the calendar tripwire works offline and on its own; wire this up when you
      have claims that move without warning.

      When you do: a 5xx from it is a HARD failure, deliberately distinct from being
      offline. A feed that errors while the check exits 0 means the gate is off and every
      run looks green.
    */
    driftApi: null,
    // Turn on once you have more than a handful of claims. A claim with no source is
    // invisible to drift detection, which is how a wrong number survives longest.
    requireSourceUrl: false,
  },

  discovery: {
    rules: {
      // 60 is roughly what search results display before truncating.
      maxTitle: 60,
      maxDescription: 160,
      requireCanonical: true,
      requireOg: true,
      requireH1: true,
      // Turn on when you actually publish structured data you care about.
      requireJsonLd: false,
    },
  },

  links: {
    /*
      Must agree with astro.config's trailingSlash and with your host. Flip both together
      or the gate fights the site: with one set to 'never', every internal link is reported
      as wrong and people switch the check off.
    */
    requireTrailingSlash: true,
    ignore: [],
  },

  budgets: {
    /*
      Null skips the gate. Set it to a server you start in CI — `npm run check:budgets`
      does that for you locally.

      Accessibility blocks; performance is advisory. Lighthouse performance moves several
      points between runs on identical code, so a tight blocking threshold produces a
      coin-flip gate, and a gate understood as a coin flip protects nothing.
    */
    url: process.env.ASTRO_OPS_BUDGET_URL ?? null,
    categories: {
      accessibility: { min: 90, blocking: true },
      performance: { min: 80, blocking: false },
      'best-practices': { min: 90, blocking: false },
      seo: { min: 95, blocking: true },
    },
  },
};
