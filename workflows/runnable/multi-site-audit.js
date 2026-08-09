/**
 * multi-site-audit
 *
 * Spec 1 (operations) from workflows/README.md, made runnable.
 * Breadth no single context could hold: one agent per site, a skeptic on every
 * finding, and a count check so a dead node cannot quietly shrink the report.
 *
 * Launch with:
 *   Workflow({ name: "multi-site-audit", args: {
 *     sites: ["https://demo.gosnappy.io/acme-pizza", ...],
 *     defect: "stale pricing",     // or "broken links" / "wrong hours"
 *     cap: 20                       // optional, defaults to 20
 *   }})
 *
 * Real use: sweeping the Snappy demo sites we build for restaurant prospects.
 * A demo with last season's prices or a dead reservation link is worse than no
 * demo, and nobody has time to open forty of them by hand.
 *
 * Notes for anyone adapting this:
 *   - `meta` must be a PURE LITERAL. No variables, no interpolation, no spreads.
 *   - This is plain JavaScript, not TypeScript. Type annotations will not parse.
 *   - Date.now(), Math.random(), and argless new Date() all throw. Pass time in via args.
 *   - `meta.phases[].title` must match every `phase()` / `opts.phase` string exactly.
 */

export const meta = {
  name: 'multi-site-audit',
  description:
    'Audit a list of sites for one named defect class, verify every finding with an independent skeptic, and return one ranked report plus the count check',
  whenToUse:
    'When you have more sites than one context can hold and a specific defect to hunt: stale pricing, broken links, wrong hours. Point it at the list, name the defect, read the ranked list.',
  phases: [
    { title: 'Audit', detail: 'one cheap auditor per site' },
    { title: 'Verify', detail: 'an independent skeptic per finding, refuting by default' },
    { title: 'Synthesize', detail: 'one ranked report on the strong tier' },
  ],
};

// ---------------------------------------------------------------------------
// Contracts. A node whose output is prose is a node only a human can read.
// ---------------------------------------------------------------------------

const FINDINGS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          site: { type: 'string' },
          issue: { type: 'string' },
          url: { type: 'string' },
          impact: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['site', 'issue', 'url', 'impact'],
      },
    },
  },
  required: ['issues'],
};

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    refuted: { type: 'boolean' },
    why: { type: 'string' },
  },
  required: ['refuted', 'why'],
};

const REPORT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    ranked: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'ranked'],
};

// ---------------------------------------------------------------------------
// Inputs. `args` may be undefined, and any key inside it may be missing or the
// wrong type. Nothing below is allowed to throw on that.
// ---------------------------------------------------------------------------

const INPUT = args || {};

const DEFAULT_CAP = 20;
// Backstop is 1000 agents per workflow. Worst case is 1 auditor + MAX_FINDINGS_PER_SITE
// verifiers per site, plus the single synthesizer: N * 11 + 1 <= 1000, so N <= 90.
// (100 would spawn 1101 and blow through the backstop.)
const HARD_CAP = 90;
const MAX_FINDINGS_PER_SITE = 10;

const DEFECT =
  typeof INPUT.defect === 'string' && INPUT.defect.trim()
    ? INPUT.defect.trim()
    : 'stale pricing, broken links, or wrong hours';

const rawCap = Number(INPUT.cap);
let CAP = Number.isFinite(rawCap) && rawCap >= 1 ? Math.floor(rawCap) : DEFAULT_CAP;
if (CAP > HARD_CAP) {
  log(`Requested cap ${CAP} exceeds the ${HARD_CAP}-site ceiling. Using ${HARD_CAP}.`);
  CAP = HARD_CAP;
}

// Clean and dedupe the list in plain JS before spending a single agent on it.
const rawSites = Array.isArray(INPUT.sites) ? INPUT.sites : [];
const cleaned = rawSites.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim());
const requested = unique(cleaned);

if (cleaned.length > requested.length) {
  log(`Dropped ${cleaned.length - requested.length} duplicate entries from the site list.`);
}

const SITES = requested.slice(0, CAP);
const droppedSites = requested.slice(CAP);

// ---------------------------------------------------------------------------
// Cap the first run. You are buying information about cost, not the result.
// Say exactly which sites were dropped. Silent truncation is a defect.
// ---------------------------------------------------------------------------

if (droppedSites.length) {
  log(
    `Capped at ${CAP} sites. ${droppedSites.length} not audited this run: ` +
      `${droppedSites.slice(0, 10).join(', ')}` +
      `${droppedSites.length > 10 ? ` (+${droppedSites.length - 10} more)` : ''}`,
  );
}

if (!SITES.length) {
  log('WARNING: no usable sites in args.sites. Nothing to audit.');
  return {
    summary: 'No usable sites were supplied, so nothing was audited.',
    ranked: [],
    findings: [],
    counts: {
      defect: DEFECT,
      cap: CAP,
      sitesRequested: requested.length,
      sitesSent: 0,
      sitesReturned: 0,
      sitesDropped: droppedSites.length,
      findingsRaised: 0,
      findingsVerified: 0,
      findingsConfirmed: 0,
      findingsDroppedOverCap: 0,
    },
  };
}

log(`Auditing ${SITES.length} site(s) for: ${DEFECT}`);

// ---------------------------------------------------------------------------
// FAN OUT + VERIFY as a pipeline, not a barrier.
//
// Each site's findings enter verification the moment that site's audit lands.
// A barrier here would make every site wait on the slowest one for no reason:
// nothing in the verify step compares one site against another.
//
// Model tiering, stage 1: an auditor reads one page and fills a fixed schema.
// Bounded, repetitive, no cross-site judgment. That is haiku / low effort, and
// it is the tier that makes a forty-site sweep affordable at all.
// ---------------------------------------------------------------------------

let verifiersSent = 0;
let verifiersReturned = 0;
let findingsDroppedOverCap = 0;

const perSite = await pipeline(
  SITES,

  // stage 1: one auditor per site.
  (site) =>
    agent(
      `Audit this page for one defect class only: ${DEFECT}.\n\n` +
        `PAGE: ${site}\n\n` +
        `This is a restaurant demo site. Open the page yourself and read what is ` +
        `actually published. Report only defects you can see on the page, one entry ` +
        `each. Every finding needs the exact URL where it appears. Set impact to ` +
        `high when a prospect would see something wrong or hit a dead end, medium ` +
        `when it is visible but cosmetic, low when it is an internal inconsistency. ` +
        `If the page is clean, return an empty issues array. Do not invent findings ` +
        `to fill the list.`,
      { label: `audit:${site}`, phase: 'Audit', schema: FINDINGS, model: 'haiku', effort: 'low' },
    ),

  // stage 2: one skeptic per finding.
  //
  // parallel() is a barrier, and it is the right call here precisely because the
  // reduce below needs every verdict for this site before the site is done. It
  // is scoped to one site's findings, so it never blocks a different site.
  //
  // The skeptic receives the FINDING ONLY. Never the auditor's reasoning, never
  // its transcript. Pasting either in is the one way to defeat the fresh context
  // every agent already gets by construction, and it turns the check into an echo.
  //
  // Model tiering, stage 2: this node has to open a URL and argue against a claim.
  // It is the node whose failure mode (waving through a false positive) is the most
  // expensive one in the graph, so it does not ride the cheap tier with the auditor.
  // Sonnet / medium is the floor for an adversarial read that is worth anything.
  (found, site) => {
    if (!found || !Array.isArray(found.issues)) {
      log(`WARNING: audit of ${site} returned nothing usable. Site excluded from the report.`);
      return null;
    }

    const issues = found.issues.filter(Boolean);
    const toVerify = issues.slice(0, MAX_FINDINGS_PER_SITE);

    if (issues.length > toVerify.length) {
      findingsDroppedOverCap += issues.length - toVerify.length;
      log(
        `Capped ${site} at ${MAX_FINDINGS_PER_SITE} findings for verification. ` +
          `${issues.length - toVerify.length} unverified findings dropped.`,
      );
    }

    if (!toVerify.length) return [];

    verifiersSent += toVerify.length;

    return parallel(
      toVerify.map((issue) => () =>
        agent(
          `Try to REFUTE this finding. Open the URL yourself and check it against ` +
            `what is actually published there. You are not confirming a colleague's ` +
            `work, you are trying to knock it down.\n\n` +
            `If you cannot open the URL, if the page does not show what is claimed, ` +
            `or if you are not certain the finding holds up, return refuted:true. ` +
            `Uncertainty means refuted. Only return refuted:false when you have seen ` +
            `the defect with your own eyes.\n\n` +
            `FINDING:\n${JSON.stringify(issue)}`,
          { label: `verify:${site}`, phase: 'Verify', schema: VERDICT, model: 'sonnet', effort: 'medium' },
        ).then((v) => {
          // agent() returns null when the user skips it or it dies after retries.
          // A missing verdict is not a pass. Default to refuted, same as uncertainty.
          const kept = Boolean(v) && v.refuted === false;
          return {
            site: issue.site || site,
            issue: issue.issue,
            url: issue.url,
            impact: issue.impact,
            kept: kept,
            why: v ? v.why : 'Verifier returned nothing. Treated as refuted.',
            verified: Boolean(v),
          };
        }),
      ),
    ).then((verdicts) => {
      const back = verdicts.filter(Boolean);
      // Count VERDICTS that actually landed, not findings that came back holding a
      // default. Every finding survives this stage carrying kept:false, so counting
      // findings here would make the shortfall warning permanently unreachable.
      const withVerdict = back.filter((f) => f.verified);
      verifiersReturned += withVerdict.length;
      if (withVerdict.length < toVerify.length) {
        log(
          `WARNING: ${toVerify.length - withVerdict.length} of ${toVerify.length} verifiers on ` +
            `${site} returned nothing. Those findings are dropped, not confirmed.`,
        );
      }
      return back;
    });
  },
);

// ---------------------------------------------------------------------------
// REDUCE. Plain JavaScript. No agent, no tokens.
// Count what came back against what we sent at every fan-in, so a dead node
// cannot pass as a clean run.
// ---------------------------------------------------------------------------

const sitesReturned = perSite.filter(Boolean).length;
if (sitesReturned < SITES.length) {
  log(`WARNING: ${SITES.length - sitesReturned} of ${SITES.length} sites returned nothing.`);
}
if (verifiersReturned < verifiersSent) {
  log(
    `WARNING: ${verifiersSent - verifiersReturned} of ${verifiersSent} verifiers returned nothing ` +
      `across the whole run.`,
  );
}

const all = perSite.filter(Boolean).flat().filter(Boolean);
const kept = rankByImpact(dedupeByUrlAndIssue(all.filter((f) => f.kept)));

log(`${kept.length} findings survived verification, out of ${all.length} raised.`);

if (!kept.length) {
  return {
    summary: `No ${DEFECT} findings survived verification across ${sitesReturned} site(s).`,
    ranked: [],
    findings: [],
    counts: {
      defect: DEFECT,
      cap: CAP,
      sitesRequested: requested.length,
      sitesSent: SITES.length,
      sitesReturned: sitesReturned,
      sitesDropped: droppedSites.length,
      findingsRaised: all.length,
      findingsVerified: verifiersReturned,
      findingsConfirmed: 0,
      findingsDroppedOverCap: findingsDroppedOverCap,
    },
  };
}

// ---------------------------------------------------------------------------
// SYNTHESIZE. One node, the whole surviving set, on the strong tier.
//
// Model tiering, stage 3: this is the only node in the graph doing cross-site
// judgment — what actually matters, what is one root cause showing up on six
// sites, what a human should fix first. It runs once, so opus / high effort is
// cheap here and it is the node the reader actually sees. Do not economise here.
// ---------------------------------------------------------------------------

phase('Synthesize');

const report = await agent(
  `Write one report on ${DEFECT} across a set of restaurant demo sites, ranked by ` +
    `impact, highest first. These findings have already been independently verified — ` +
    `do not re-litigate them, and do not add findings that are not in this list.\n\n` +
    `Group anything that is the same root cause showing up on multiple sites. In ` +
    `the ranked array, write one line per item: the site, the defect, the URL, and ` +
    `what to do about it. In the summary, lead with what a human should fix first ` +
    `and why.\n\n` +
    `Audited ${sitesReturned} of ${SITES.length} site(s) sent. ` +
    `${all.length} finding(s) raised, ${kept.length} confirmed.\n\n` +
    `CONFIRMED FINDINGS:\n${JSON.stringify(kept)}`,
  { label: 'synthesize', phase: 'Synthesize', schema: REPORT, model: 'opus', effort: 'high' },
).catch(() => null);
// This is the only agent call not already wrapped by pipeline() or parallel(), both of
// which absorb a throw into null. Unguarded, a rejecting synthesizer would discard every
// verified finding and the whole count check. The `if (!report)` fallback below is the
// intended failure path, so route a rejection into it too.

if (!report) {
  log('WARNING: synthesis returned nothing. Falling back to the raw ranked list.');
}

// The count check ships next to the report, always. A ranked list without the
// denominator reads as complete even when half the fleet died.
return {
  summary: report ? report.summary : 'Synthesis failed. Ranked findings are listed as returned.',
  ranked: report ? report.ranked : kept.map((f) => `[${f.impact}] ${f.site} — ${f.issue} (${f.url})`),
  findings: kept,
  counts: {
    defect: DEFECT,
    cap: CAP,
    sitesRequested: requested.length,
    sitesSent: SITES.length,
    sitesReturned: sitesReturned,
    sitesDropped: droppedSites.length,
    findingsRaised: all.length,
    findingsVerified: verifiersReturned,
    findingsConfirmed: kept.length,
    findingsDroppedOverCap: findingsDroppedOverCap,
  },
};

// ---------------------------------------------------------------------------
// Plumbing. Plain JS, no agents.
// ---------------------------------------------------------------------------

function unique(items) {
  const seen = new Set();
  return items.filter((i) => {
    if (seen.has(i)) return false;
    seen.add(i);
    return true;
  });
}

function dedupeByUrlAndIssue(items) {
  const seen = new Set();
  return items.filter((i) => {
    const k = `${i.url}::${i.issue}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function rankByImpact(items) {
  const order = { high: 0, medium: 1, low: 2 };
  // Sort deterministically: impact, then site, then url. No clocks, no randomness.
  return items.slice().sort((a, b) => {
    const ra = order[a.impact] === undefined ? 3 : order[a.impact];
    const rb = order[b.impact] === undefined ? 3 : order[b.impact];
    if (ra !== rb) return ra - rb;
    if (a.site !== b.site) return a.site < b.site ? -1 : 1;
    if (a.url !== b.url) return a.url < b.url ? -1 : 1;
    return 0;
  });
}
