/**
 * catalog-copy-audit
 *
 * Spec 3 (ecommerce) from workflows/README.md, built as a real graph.
 *
 * Launch with:  Workflow({ scriptPath: "<path to this file>", args: { pages: [...], cap: 30 } })
 * or drop it in ~/.claude/workflows/ and launch it by name.
 *
 * The load-bearing line in this whole file is ANCHOR. The SKU name and the spec
 * sheet are ground truth. The marketing copy is the suspect. If the verifier is
 * handed the auditor's reasoning instead of the anchor, it is checking copy
 * against copy, which is an echo and not a check — so stage 1 extracts the anchor
 * BEFORE anyone reads the copy, and stage 3 gets the anchor plus a stripped
 * finding and nothing else.
 *
 * Union Made Apparel is the reason this exists: a long sleeve tee is not a
 * sweater, and the product page is not allowed to call it one.
 *
 * Notes for anyone adapting this:
 *   - `meta` must be a PURE LITERAL. No variables, no interpolation, no spreads.
 *   - This is plain JavaScript, not TypeScript. Type annotations will not parse.
 *   - Date.now(), Math.random(), and argless new Date() all throw. Pass time in via args.
 */

export const meta = {
  name: 'catalog-copy-audit',
  description:
    'Check product pages for marketing copy that misdescribes the actual garment, anchored to the SKU name and spec sheet, and propose edits without touching anything live',
  whenToUse:
    'You have a list of product page URLs and want to know which ones describe the garment wrong (a long sleeve tee sold as a sweater, cotton sold as merino, a crew called a mock neck). Returns flagged pages only, each with the offending line quoted, plus proposed replacement copy. Proposal only — it never edits the store.',
  phases: [
    { title: 'Anchor', detail: 'pull SKU + spec sheet as ground truth, copy ignored' },
    { title: 'Audit', detail: 'one agent per page, flags copy that contradicts the anchor' },
    { title: 'Verify', detail: 'independent checker per flag, anchor only, must requote the line' },
    { title: 'Propose', detail: 'one ranked edit list for a human to apply' },
  ],
};

// ---------------------------------------------------------------------------
// Contracts. A node whose output is prose is a node only a human can read.
// ---------------------------------------------------------------------------

// Stage 1 output. This is the thing that cannot argue back later.
const ANCHOR = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sku: { type: 'string' },
    // The garment as the SKU/spec sheet names it. "long sleeve tee", not "layering piece".
    garmentType: { type: 'string' },
    facts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          attribute: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['attribute', 'value'],
      },
    },
    // Where on the page the ground truth was read from, so a human can re-check it.
    source: { type: 'string' },
  },
  required: ['sku', 'garmentType', 'facts', 'source'],
};

// Stage 2 output. quotedLine must be verbatim page text — it is what stage 3 re-finds.
const FLAGS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    flags: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          quotedLine: { type: 'string' },
          copyClaim: { type: 'string' },
          anchorFact: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['quotedLine', 'copyClaim', 'anchorFact', 'severity'],
      },
    },
  },
  required: ['flags'],
};

// Stage 3 output. confirmed:false is the default the checker has to be argued out of.
const VERDICT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    confirmed: { type: 'boolean' },
    quotedLine: { type: 'string' },
    why: { type: 'string' },
  },
  required: ['confirmed', 'quotedLine', 'why'],
};

// Stage 4 output. Proposals only. Nothing in this schema can be applied by a machine.
const PROPOSALS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          page: { type: 'string' },
          sku: { type: 'string' },
          currentLine: { type: 'string' },
          proposedLine: { type: 'string' },
          rationale: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['page', 'sku', 'currentLine', 'proposedLine', 'rationale', 'severity'],
      },
    },
  },
  required: ['summary', 'edits'],
};

// ---------------------------------------------------------------------------
// Input handling. args may be undefined, may be missing keys, may hold junk.
// Nothing below is allowed to throw on a bad call.
// ---------------------------------------------------------------------------

const rawPages = (args && Array.isArray(args.pages) ? args.pages : []).filter(
  (p) => typeof p === 'string' && p.trim().length > 0,
);

const requested = dedupeStrings(rawPages.map((p) => p.trim()));

if (rawPages.length > requested.length) {
  log(`Dropped ${rawPages.length - requested.length} duplicate page entries before fan-out.`);
}

// Cap the first run. You are buying information about cost, not the result.
//
// The caller's cap is not trusted to be sane. The platform backstops a workflow at
// 1000 agents total and 4096 items per pipeline() call, and this graph spends at
// least two agents per page (anchor + audit) before a single verifier runs — so
// pages, not items, is the binding constraint. Past ~400 pages the run trips the
// backstop mid-flight and pages die as null with no way to tell them from a clean
// page. Clamp here rather than discover it at agent 1000.
const MAX_CAP = 400;

const requestedCap =
  args && typeof args.cap === 'number' && args.cap > 0 ? Math.floor(args.cap) : 30;

const CAP = Math.min(requestedCap, MAX_CAP);

if (requestedCap > CAP) {
  log(
    `Requested cap of ${requestedCap} exceeds the ${MAX_CAP}-page ceiling this workflow can run ` +
      `under the platform's 1000-agent backstop. Using ${CAP}.`,
  );
}

const PAGES = requested.slice(0, CAP);

if (requested.length > PAGES.length) {
  const dropped = requested.slice(PAGES.length);
  // The COUNT is the load-bearing part — silent truncation is the defect, not a
  // shortened list. Enumerate a readable sample rather than dumping thousands of
  // URLs into one progress line.
  const shown = dropped.slice(0, 20);
  const rest = dropped.length - shown.length;
  log(
    `Capped at ${CAP} pages. ${dropped.length} not audited this run: ${shown.join(', ')}` +
      (rest > 0 ? `, and ${rest} more` : ''),
  );
}

if (!PAGES.length) {
  log('No usable page URLs in args.pages. Nothing to audit.');
  return {
    summary: 'No pages supplied. Nothing audited, nothing changed.',
    edits: [],
    pagesSent: 0,
    pagesReturned: 0,
    flagsRaised: 0,
    flagsConfirmed: 0,
    changesApplied: 0,
    humanGate:
      'Proposal only. This workflow never edits a live product page; every edit below needs a human to apply it.',
  };
}

log(`Auditing ${PAGES.length} product page(s) against SKU + spec-sheet ground truth.`);

// ---------------------------------------------------------------------------
// ANCHOR -> AUDIT -> VERIFY as a pipeline, not a barrier.
//
// Page B's anchor extraction should not wait on page A's slowest verifier.
// Nothing in any stage compares one product against another, so a barrier here
// would buy latency and nothing else. parallel() shows up exactly once, inside
// stage 3, where the fan is per-flag and the fan-in has to be counted.
// ---------------------------------------------------------------------------

let flagsRaised = 0;
let verdictsMissing = 0;
let requoteMismatches = 0;

const perPage = await pipeline(
  PAGES,

  // -------------------------------------------------------------------------
  // stage 1 — ANCHOR. Extraction, not judgment: read the SKU title, the spec
  // table, the materials/care block. Explicitly told to ignore marketing prose,
  // because anything it absorbs from the copy contaminates the ground truth the
  // verifier later leans on. Bounded, repetitive, no reasoning required -> haiku/low.
  // -------------------------------------------------------------------------
  (page) =>
    agent(
      `Open ${page} and extract the GROUND TRUTH for this garment.\n\n` +
        `Ground truth means ONLY: the SKU / product code, the product title as it appears ` +
        `in the SKU or page title, and the structured spec sheet — fabric composition, ` +
        `weight/GSM, sleeve length, neckline, fit, construction, care instructions, country of origin.\n\n` +
        `IGNORE the marketing description, the hero blurb, bullet-point selling points, ` +
        `reviews, and cross-sell modules entirely. Those are the thing being audited later; ` +
        `if you let them in here the whole audit becomes circular.\n\n` +
        `garmentType must be the literal garment the SKU and spec sheet describe ` +
        `(for example "long sleeve tee", "crewneck sweatshirt", "flannel overshirt"), ` +
        `not a category or a marketing label.\n` +
        `If a fact is not stated in the SKU or spec sheet, leave it out. Do not infer.`,
      {
        label: `anchor:${page}`,
        phase: 'Anchor',
        schema: ANCHOR,
        model: 'haiku',
        effort: 'low',
      },
    ),

  // -------------------------------------------------------------------------
  // stage 2 — AUDIT. Same page, now reading only the copy, holding the anchor.
  // Flag ONLY contradictions of the anchor; "the copy is bland" is not a finding.
  // Bounded per page and highly repetitive -> haiku/low. Volume lives here, and
  // false positives are affordable because stage 3 exists to kill them.
  //
  // It returns { anchor, flags } rather than the bare agent result: a pipeline stage
  // only ever sees the PREVIOUS stage's output, so the anchor has to be carried
  // forward by hand or stage 3 has nothing to check against but the auditor's word.
  // -------------------------------------------------------------------------
  async (anchor, page) => {
    if (!anchor) return null; // stage 1 died or was skipped; counted at the fan-in below

    const found = await agent(
      `ANCHOR (ground truth, taken from the SKU and spec sheet — treat as correct, ` +
        `it is NOT up for debate):\n${JSON.stringify(anchor)}\n\n` +
        `Now open ${page} and read ONLY the marketing copy: title-adjacent taglines, the ` +
        `product description, bullet selling points, and any fabric/fit language in the prose.\n\n` +
        `Flag every line of copy that CONTRADICTS the anchor. Examples of a real contradiction: ` +
        `the anchor says "long sleeve tee" and the copy calls it a sweater; the anchor says ` +
        `100% cotton and the copy says merino or wool-blend; the anchor says crewneck and the ` +
        `copy says mock neck; the anchor says 180 GSM and the copy calls it heavyweight fleece.\n\n` +
        `Do NOT flag: tone, grammar, SEO quality, length, missing information, subjective ` +
        `puffery ("incredibly soft"), or anything the anchor is silent on. Silence in the ` +
        `anchor is not a contradiction. If nothing contradicts the anchor, return an empty ` +
        `flags array — a clean page is a valid and common result.\n\n` +
        `quotedLine MUST be the offending sentence copied verbatim from the page, character ` +
        `for character. Do not paraphrase it, do not trim it to a fragment, do not fix its ` +
        `punctuation. An independent checker has to find that exact string on the page.\n` +
        `anchorFact must name the specific anchor value the line contradicts.`,
      {
        label: `audit:${page}`,
        phase: 'Audit',
        schema: FLAGS,
        model: 'haiku',
        effort: 'low',
      },
    );

    // A dead auditor is an UNAUDITED page, not a clean one. Returning null here
    // makes it show up in the fan-in shortfall count instead of as zero flags.
    if (!found || !Array.isArray(found.flags)) return null;

    return { anchor: anchor, flags: found.flags };
  },

  // -------------------------------------------------------------------------
  // stage 3 — VERIFY. One independent checker per flag, fresh look at the page.
  //
  // It receives the ANCHOR and a STRIPPED finding: the page, the quoted line, and
  // the anchor fact at issue. It never receives the auditor's transcript, its
  // reasoning, its severity call, or its copyClaim narrative — those are the
  // auditor's characterization, and passing them turns a check into agreement.
  //
  // Tier note: this is the load-bearing node in the graph, so it deliberately does
  // NOT run on the same haiku/low tier as the auditor. Two agents on the same cheap
  // tier fail the same way, and a verifier that shares the auditor's blind spots is
  // decoration. sonnet/medium: enough to re-read a page adversarially, far cheaper
  // than the opus synthesis node, and it scales with flag count.
  // -------------------------------------------------------------------------
  async (audit, page, index) => {
    if (!audit) return null; // stage 1 or 2 died; the shortfall count picks it up
    if (!audit.flags.length) return []; // a genuinely clean page

    const anchor = audit.anchor;
    const flags = audit.flags;
    flagsRaised += flags.length;

    const verdicts = await parallel(
      flags.map((flag, flagIndex) => () =>
        agent(
          `You are an independent checker. Assume the flag below is WRONG until the page ` +
            `proves otherwise. Confirm nothing you have not read yourself.\n\n` +
            `ANCHOR (ground truth from the SKU and spec sheet — this is what the copy must ` +
            `agree with):\n${JSON.stringify(stripAnchor(anchor))}\n\n` +
            `FLAG:\n${JSON.stringify(stripFlag(flag, page))}\n\n` +
            `Open ${page} yourself with a fresh look. Then:\n` +
            `1. Find the offending line on the live page and copy it into quotedLine VERBATIM. ` +
            `If you cannot find that line on the page, set confirmed:false and say so.\n` +
            `2. Decide whether that line genuinely contradicts the anchor. A difference in ` +
            `wording is not a contradiction; a difference in the garment is.\n` +
            `3. If you are not certain the contradiction holds, set confirmed:false.\n\n` +
            `Do not evaluate tone, style, or whether the copy could be better written.`,
          {
            // page index + flag index, so two flags on one page are distinguishable
            // in the progress view. No Math.random / Date.now available for ids.
            label: `verify:p${index + 1}#f${flagIndex + 1}:${page}`,
            phase: 'Verify',
            schema: VERDICT,
            model: 'sonnet',
            effort: 'medium',
          },
        ).then((v) => ({ page: page, sku: anchor.sku, flag: flag, verdict: v })),
      ),
    );

    // Fan-in count, per page. A dead checker must not read as a cleared flag.
    const back = verdicts.filter(Boolean).filter((v) => Boolean(v.verdict));
    if (back.length < flags.length) {
      verdictsMissing += flags.length - back.length;
      log(
        `WARNING: ${flags.length - back.length} of ${flags.length} checkers returned nothing on ${page}. ` +
          `Those flags are dropped, not cleared.`,
      );
    }

    return back;
  },
);

// ---------------------------------------------------------------------------
// REDUCE. Plain JavaScript. No agent, no tokens.
// Count what came back against what we sent, so a dead node cannot pass as a clean run.
// ---------------------------------------------------------------------------

const pagesReturned = perPage.filter(Boolean).length;
if (pagesReturned < PAGES.length) {
  log(
    `WARNING: ${PAGES.length - pagesReturned} of ${PAGES.length} pages returned nothing ` +
      `(anchor or audit failed). They are UNAUDITED, not clean.`,
  );
}

const audited = perPage
  .map((r, i) => (r ? PAGES[i] : null))
  .filter(Boolean);

const unaudited = PAGES.filter((p) => audited.indexOf(p) === -1);

const checked = perPage.filter(Boolean).flat().filter(Boolean);

// The checker had to requote the line. If its quote and the auditor's quote are not
// the same string, one of them was looking at something else — drop it rather than
// ship a "confirmed" finding whose quoted line nobody can trust.
const confirmed = [];
for (const c of checked) {
  if (!c.verdict.confirmed) continue;
  if (!sameLine(c.verdict.quotedLine, c.flag.quotedLine)) {
    requoteMismatches += 1;
    log(
      `Dropped a confirmed flag on ${c.page}: checker requoted a different line than the auditor flagged.`,
    );
    continue;
  }
  confirmed.push({
    page: c.page,
    sku: c.sku,
    quotedLine: c.verdict.quotedLine,
    anchorFact: c.flag.anchorFact,
    severity: c.flag.severity,
    why: c.verdict.why,
  });
}

const survivors = rank(dedupeFindings(confirmed));

log(
  `${survivors.length} mismatches survived verification, out of ${flagsRaised} raised across ` +
    `${pagesReturned} page(s).`,
);

const HUMAN_GATE =
  'Proposal only. This workflow read the store and changed nothing: no product, no ' +
  'description, no metafield, no theme file was written. Every edit below is a suggestion ' +
  'for a human to review and apply by hand.';

if (!survivors.length) {
  return {
    summary:
      'No copy mismatches survived verification. Flagged pages, if any, were refuted by the independent checker.',
    edits: [],
    flaggedPages: [],
    pagesSent: PAGES.length,
    pagesReturned: pagesReturned,
    unauditedPages: unaudited,
    flagsRaised: flagsRaised,
    flagsConfirmed: 0,
    verdictsMissing: verdictsMissing,
    requoteMismatches: requoteMismatches,
    changesApplied: 0,
    humanGate: HUMAN_GATE,
  };
}

// ---------------------------------------------------------------------------
// PROPOSE. One node, the whole surviving set, so the edits are consistent with
// each other and ranked against each other. Keep this one on the strong tier:
// it is the only node writing customer-facing words, and it is the only node
// that sees the catalog as a whole. opus/high, exactly once.
// ---------------------------------------------------------------------------

phase('Propose');

const proposal = await agent(
  `These are verified mismatches between Union Made Apparel product copy and the garment ` +
    `the SKU and spec sheet actually describe. Each one has been independently confirmed ` +
    `against the anchor by a second agent.\n\n` +
    `${JSON.stringify(survivors)}\n\n` +
    `For each one, write a replacement line. Rules:\n` +
    `- currentLine must be the quoted offending line, unchanged.\n` +
    `- proposedLine must be accurate to the anchor fact FIRST. A long sleeve tee is a long ` +
    `sleeve tee; it is never a sweater, a knit, or a pullover.\n` +
    `- Keep the brand's existing voice and roughly the original length. This is a correction, ` +
    `not a rewrite, and not an excuse to add claims the spec sheet does not support.\n` +
    `- Do not introduce any new material, weight, fit, or construction claim.\n` +
    `- rationale states the specific spec-sheet fact the current line contradicts.\n` +
    `- Rank the edits so the ones most likely to cause a return or a chargeback come first.\n\n` +
    `You are producing a proposal for a human to apply. Do not attempt to edit any page, ` +
    `product, or store. Output the edit list only.`,
  { label: 'propose-edits', phase: 'Propose', schema: PROPOSALS, model: 'opus', effort: 'high' },
);

if (!proposal) {
  log('WARNING: the proposal node returned nothing. Returning the verified findings raw.');
  return {
    summary: `${survivors.length} verified copy mismatches. Edit drafting failed; findings returned unedited.`,
    edits: [],
    flaggedPages: survivors,
    pagesSent: PAGES.length,
    pagesReturned: pagesReturned,
    unauditedPages: unaudited,
    flagsRaised: flagsRaised,
    flagsConfirmed: survivors.length,
    verdictsMissing: verdictsMissing,
    requoteMismatches: requoteMismatches,
    changesApplied: 0,
    humanGate: HUMAN_GATE,
  };
}

return {
  summary: proposal.summary,
  edits: proposal.edits,
  flaggedPages: survivors,
  pagesSent: PAGES.length,
  pagesReturned: pagesReturned,
  unauditedPages: unaudited,
  flagsRaised: flagsRaised,
  flagsConfirmed: survivors.length,
  verdictsMissing: verdictsMissing,
  requoteMismatches: requoteMismatches,
  changesApplied: 0,
  humanGate: HUMAN_GATE,
};

// ---------------------------------------------------------------------------
// Plumbing. All of it plain JS — none of this is worth an agent.
// ---------------------------------------------------------------------------

function dedupeStrings(items) {
  const seen = new Set();
  return items.filter((i) => {
    if (seen.has(i)) return false;
    seen.add(i);
    return true;
  });
}

// The verifier gets the anchor, and only the anchor — no auditor internals.
function stripAnchor(anchor) {
  if (!anchor) return { note: 'anchor unavailable' };
  return {
    sku: anchor.sku,
    garmentType: anchor.garmentType,
    facts: anchor.facts,
    source: anchor.source,
  };
}

// The verifier gets the FINDING only: where to look, what line, which anchor fact.
// copyClaim and severity are the auditor's characterization and are withheld on purpose.
function stripFlag(flag, page) {
  return {
    page: page,
    quotedLine: flag.quotedLine,
    anchorFact: flag.anchorFact,
  };
}

// Two quotes of the same line, normalized for whitespace, quote glyphs, and case.
// Containment is allowed because the checker may quote a slightly wider or narrower
// span than the auditor did — but only above a length floor, or a three-word quote
// would "match" any line that happens to contain those three words.
function sameLine(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (Math.min(x.length, y.length) < 16) return false;
  return x.indexOf(y) !== -1 || y.indexOf(x) !== -1;
}

function normalize(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/[‘’“”]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function dedupeFindings(items) {
  const seen = new Set();
  return items.filter((i) => {
    const k = `${i.page}::${normalize(i.quotedLine)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function rank(items) {
  const order = { high: 0, medium: 1, low: 2 };
  return items.slice().sort((a, b) => {
    const sa = order[a.severity] === undefined ? 3 : order[a.severity];
    const sb = order[b.severity] === undefined ? 3 : order[b.severity];
    if (sa !== sb) return sa - sb;
    return a.page < b.page ? -1 : a.page > b.page ? 1 : 0;
  });
}
