/**
 * demo-site-audit
 *
 * The diamond, end to end: fan out, verify, reduce, synthesize.
 *
 * Launch with:  Workflow({ scriptPath: "<path to this file>", args: { sites: [...] } })
 * or drop it in .claude/workflows/ and launch it by name.
 *
 * Notes for anyone adapting this:
 *   - `meta` must be a PURE LITERAL. No variables, no interpolation, no spreads.
 *   - This is plain JavaScript, not TypeScript. Type annotations will not parse.
 *   - Date.now(), Math.random(), and argless new Date() all throw. Pass time in via args.
 */

export const meta = {
  name: 'demo-site-audit',
  description: 'Audit every site for stale menu data, verify each finding, rank the result',
  phases: [
    { title: 'Audit', detail: 'one agent per site' },
    { title: 'Verify', detail: 'an independent skeptic per finding' },
    { title: 'Synthesize', detail: 'one ranked report' },
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
// Cap the first run. You are buying information about cost, not the result.
// ---------------------------------------------------------------------------

const CAP = 20;
const requested = (args && args.sites) || [];
const SITES = requested.slice(0, CAP);

if (requested.length > SITES.length) {
  log(`Capped at ${CAP} sites. ${requested.length - SITES.length} not audited this run.`);
}

// ---------------------------------------------------------------------------
// FAN OUT + VERIFY as a pipeline, not a barrier.
//
// Each site's findings go into verification the moment that site's audit lands.
// A barrier here would make every site wait on the slowest one for no reason:
// nothing in the verify step compares one site against another.
// ---------------------------------------------------------------------------

const perSite = await pipeline(
  SITES,

  // stage 1: one auditor per site. Cheap tier, bounded job.
  (site) =>
    agent(
      `Audit ${site}. Report every menu item whose listed price looks stale or ` +
        `inconsistent with the rest of the page. Every finding needs a URL.`,
      { label: `audit:${site}`, phase: 'Audit', schema: FINDINGS, model: 'haiku', effort: 'low' },
    ),

  // stage 2: one skeptic per finding. It sees the FINDING, never the auditor's reasoning.
  (found, site) =>
    parallel(
      found.issues.map((issue) => () =>
        agent(
          `Try to REFUTE this finding. Open the URL and check it yourself. ` +
            `If you are not certain it holds up, return refuted:true.\n\n${JSON.stringify(issue)}`,
          { label: `verify:${site}`, phase: 'Verify', schema: VERDICT },
        ).then((v) => ({ ...issue, kept: Boolean(v) && !v.refuted, why: v && v.why })),
      ),
    ),
);

// ---------------------------------------------------------------------------
// REDUCE. Plain JavaScript. No agent, no tokens.
// Count what came back against what we sent, so a dead node cannot pass as a clean run.
// ---------------------------------------------------------------------------

const returned = perSite.filter(Boolean).length;
if (returned < SITES.length) {
  log(`WARNING: ${SITES.length - returned} of ${SITES.length} sites returned nothing.`);
}

const all = perSite.filter(Boolean).flat().filter(Boolean);
const kept = dedupeByUrl(all.filter((f) => f.kept));

log(`${kept.length} findings survived verification, out of ${all.length} raised.`);

if (!kept.length) {
  return { summary: 'No findings survived verification.', ranked: [], checked: returned };
}

// ---------------------------------------------------------------------------
// SYNTHESIZE. One node, the whole surviving set. Keep this one on the strong tier.
// ---------------------------------------------------------------------------

phase('Synthesize');

const report = await agent(
  `Write one report ranked by impact from these confirmed issues.\n${JSON.stringify(kept)}`,
  { phase: 'Synthesize', schema: REPORT, model: 'opus', effort: 'high' },
);

return { ...report, checked: returned, raised: all.length, confirmed: kept.length };

// ---------------------------------------------------------------------------

function dedupeByUrl(items) {
  const seen = new Set();
  return items.filter((i) => {
    const k = `${i.url}::${i.issue}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
