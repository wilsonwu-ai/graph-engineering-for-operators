/**
 * decision-grade-research
 *
 * Spec 2 (investing) from workflows/README.md, made runnable.
 * The verify step is doing the work here, not the research step. Three skeptics
 * per finding on THREE DISTINCT LENSES, because a claim can be wrong three
 * different ways: it can be false, it can be stale, or it can be attributed to
 * a source that never said it. One lens catches one of those. Three identical
 * skeptics catch one of those three times.
 *
 * Launch with:
 *   Workflow({ name: "decision-grade-research", args: {
 *     question: "Is Toast's take rate durable as SMB restaurant churn normalizes?",
 *     angles: ["unit economics", "competitive"],   // optional; planner derives 5 if absent
 *     cap: 5,                                       // optional, defaults to 5 angles
 *     asOf: "2026-08-09",                           // optional but recommended, see below
 *     maxAgeMonths: 18,                             // optional staleness threshold
 *     reportPath: "/abs/path/research-report.md"    // optional, THE ONLY writable path
 *   }})
 *
 * Real use: Dubbs Capital investment screening. A number that reaches a model
 * without a source and a date is a number that will be defended in an IC meeting
 * by whoever remembers it wrong. Every finding here carries a URL and a
 * publication date, or it does not exist.
 *
 * HUMAN GATE: this workflow RETURNS the report. It writes no file at all unless
 * args.reportPath is supplied, and then exactly that one path and nothing else.
 * Nothing downstream of the return happens without a human asking for it.
 *
 * Notes for anyone adapting this:
 *   - `meta` must be a PURE LITERAL. No variables, no interpolation, no spreads.
 *   - This is plain JavaScript, not TypeScript. Type annotations will not parse.
 *   - Date.now(), Math.random(), and argless new Date() all throw. That is why
 *     `asOf` is an arg: the currency lens needs a today, and the script cannot
 *     read one. Pass it. Without it the lens has to establish the date itself.
 *   - `meta.phases[].title` must match every `phase()` / `opts.phase` string exactly.
 */

export const meta = {
  name: 'decision-grade-research',
  description:
    'Decision-grade research on one question: fan out to 5 distinct angles, require a source URL and publication date on every finding, verify each finding with three skeptics on distinct lenses, keep what survives a majority, and return one cited report',
  whenToUse:
    'When a decision rides on the answer and an unsourced number is worse than no number: investment screening, diligence, market sizing, any question where a stale or misattributed figure would reach a model. Not for casual lookups; this spends three verifiers per finding.',
  phases: [
    { title: 'Plan', detail: 'one planner derives 5 distinct angles from the question' },
    { title: 'Research', detail: 'one researcher per angle, every finding sourced and dated' },
    { title: 'Verify', detail: 'three skeptics per finding: correct, current, actually said it' },
    { title: 'Synthesize', detail: 'one cited report on the strong tier' },
  ],
};

// ---------------------------------------------------------------------------
// Contracts. A node whose output is prose is a node only a human can read.
//
// The CONTRACT line from the spec lives here: sourceUrl and publicationDate are
// `required`. A finding without them is not a weak finding, it is not a finding.
// ---------------------------------------------------------------------------

const ANGLE_PLAN = {
  type: 'object',
  additionalProperties: false,
  properties: {
    angles: {
      type: 'array',
      minItems: 5,
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          focus: { type: 'string' },
        },
        required: ['title', 'focus'],
      },
    },
  },
  required: ['angles'],
};

const FINDINGS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          claim: { type: 'string' },
          // The anchor. Empty string when the claim is qualitative; otherwise the
          // figure exactly as printed in the source, units and all. No rounding,
          // no unit conversion, no "approximately".
          figure: { type: 'string' },
          period: { type: 'string' },
          sourceTitle: { type: 'string' },
          sourceUrl: { type: 'string' },
          publicationDate: { type: 'string' },
          quote: { type: 'string' },
          sourceType: {
            type: 'string',
            enum: ['filing', 'company', 'regulator', 'analyst', 'press', 'trade', 'other'],
          },
          relevance: { type: 'string' },
        },
        required: [
          'claim',
          'figure',
          'period',
          'sourceTitle',
          'sourceUrl',
          'publicationDate',
          'quote',
          'sourceType',
          'relevance',
        ],
      },
    },
  },
  required: ['findings'],
};

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    upheld: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    why: { type: 'string' },
    evidence: { type: 'string' },
  },
  required: ['upheld', 'confidence', 'why', 'evidence'],
};

const REPORT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    headline: { type: 'string' },
    bottomLine: { type: 'string' },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          statement: { type: 'string' },
          citation: { type: 'string' },
          strength: { type: 'string', enum: ['strong', 'moderate', 'thin'] },
        },
        required: ['statement', 'citation', 'strength'],
      },
    },
    contradictions: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
    screeningView: { type: 'string' },
  },
  required: ['headline', 'bottomLine', 'claims', 'contradictions', 'openQuestions', 'screeningView'],
};

// ---------------------------------------------------------------------------
// Inputs. `args` may be undefined, and any key inside it may be missing or the
// wrong type. Nothing below is allowed to throw on that.
// ---------------------------------------------------------------------------

const INPUT = args || {};

const DEFAULT_ANGLES = 5;
// Backstop is 1000 agents. At 1 planner + N researchers + N * MAX_FINDINGS * 3
// verifiers + 1 synthesizer, 10 angles is the largest fan-out that cannot run away.
const HARD_CAP = 10;
const MAX_FINDINGS_PER_ANGLE = 6;
const LENS_COUNT = 3;
const MAJORITY = 2;

const QUESTION = typeof INPUT.question === 'string' ? INPUT.question.trim() : '';

// No clock is available in here. `asOf` is how the currency lens learns what
// "current" means. Without it each lens has to establish the date on its own,
// which works but costs tokens and can disagree between lenses.
const AS_OF = typeof INPUT.asOf === 'string' && INPUT.asOf.trim() ? INPUT.asOf.trim() : '';

const rawAge = Number(INPUT.maxAgeMonths);
const MAX_AGE_MONTHS = Number.isFinite(rawAge) && rawAge > 0 ? Math.floor(rawAge) : 18;

// The only writable path in this workflow. Absent means: write nothing, anywhere.
const REPORT_PATH =
  typeof INPUT.reportPath === 'string' && INPUT.reportPath.trim() ? INPUT.reportPath.trim() : '';

const rawCap = Number(INPUT.cap);
let CAP = Number.isFinite(rawCap) && rawCap >= 1 ? Math.floor(rawCap) : DEFAULT_ANGLES;
if (CAP > HARD_CAP) {
  log(`Requested cap ${CAP} exceeds the ${HARD_CAP}-angle ceiling. Using ${HARD_CAP}.`);
  CAP = HARD_CAP;
}

const HUMAN_GATE =
  'Research output only. This workflow returns the report; it wrote no file except the ' +
  'single path passed in args.reportPath, if one was passed. Nothing here has been ' +
  'entered into a model, a memo, or a tracker. Anchor every figure to the citation ' +
  'beside it before it moves anywhere.';

if (!QUESTION) {
  log('WARNING: no args.question supplied. Nothing to research.');
  return {
    headline: 'No question supplied.',
    bottomLine: 'args.question is required. Nothing was researched.',
    claims: [],
    markdown: '',
    citations: [],
    savedTo: null,
    counts: emptyCounts(),
    humanGate: HUMAN_GATE,
  };
}

if (!AS_OF) {
  log(
    'No args.asOf supplied. The currency lens will establish today\'s date itself and ' +
      'state it in its verdict. Passing asOf is cheaper and makes the lenses agree.',
  );
}

// ---------------------------------------------------------------------------
// PLAN. One agent, and only when the caller did not bring their own angles.
//
// Model tiering, stage 0: this node runs exactly once and it decides the shape
// of everything downstream. Five overlapping angles produce five copies of the
// same research and no coverage. That failure is unrecoverable later in the
// graph, so this is the cheapest place in the whole run to spend the strong
// tier. opus / medium: hard judgment, small output.
// ---------------------------------------------------------------------------

phase('Plan');

const suppliedAngles = Array.isArray(INPUT.angles)
  ? unique(INPUT.angles.filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim()))
  : [];

let requestedAngles = [];

if (suppliedAngles.length) {
  requestedAngles = suppliedAngles.map((t) => ({ title: t, focus: '' }));
  log(`Using ${requestedAngles.length} caller-supplied angle(s). Planner skipped.`);
} else {
  const plan = await agent(
    `Decompose this research question into exactly ${DEFAULT_ANGLES} DISTINCT investigative ` +
      `angles for an investment screen.\n\n` +
      `QUESTION: ${QUESTION}\n\n` +
      `Each angle gets its own researcher working with no knowledge of the others, so ` +
      `overlap is pure waste: five angles that all end up reading the same 10-K produce ` +
      `one angle's worth of coverage at five angles' cost.\n\n` +
      `Make them cut along different evidence types, not different phrasings of the same ` +
      `idea. Good separation looks like: reported financials and unit economics; ` +
      `competitive and market structure; customer or channel evidence; regulatory, legal ` +
      `and macro exposure; the bear case and the disconfirming evidence a promoter would ` +
      `leave out. Adapt those to THIS question rather than copying them.\n\n` +
      `At least one angle must be explicitly adversarial: its job is to find what would ` +
      `make the answer "no".\n\n` +
      `title is a short label. focus states what evidence that researcher should go get ` +
      `and, just as important, what they should leave to the other four.`,
    { label: 'plan:angles', phase: 'Plan', schema: ANGLE_PLAN, model: 'opus', effort: 'medium' },
  );

  // Fan-in of one. It still gets counted: a dead planner must not read as "no angles found".
  if (!plan || !Array.isArray(plan.angles) || !plan.angles.length) {
    log('WARNING: 1 planner sent, 0 returned. Cannot fan out without angles.');
    return {
      headline: 'Planning failed.',
      bottomLine:
        'The planner returned nothing, so no research angles were derived and no research ran. ' +
        'Re-run, or pass args.angles explicitly.',
      claims: [],
      markdown: '',
      citations: [],
      savedTo: null,
      counts: emptyCounts(),
      humanGate: HUMAN_GATE,
    };
  }

  requestedAngles = plan.angles;

  if (requestedAngles.length < DEFAULT_ANGLES) {
    log(
      `WARNING: planner returned ${requestedAngles.length} angle(s), ${DEFAULT_ANGLES} requested. ` +
        `Coverage is narrower than the spec calls for.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Cap the run and say exactly what was dropped. Silent truncation is a defect.
// ---------------------------------------------------------------------------

const ANGLES = requestedAngles.slice(0, CAP);
const droppedAngles = requestedAngles.slice(CAP);

if (droppedAngles.length) {
  log(
    `Capped at ${CAP} angle(s). ${droppedAngles.length} not researched this run: ` +
      `${droppedAngles.map((a) => a.title).join(' | ')}`,
  );
}

log(`Researching ${ANGLES.length} angle(s): ${ANGLES.map((a) => a.title).join(' | ')}`);

// ---------------------------------------------------------------------------
// FAN OUT + VERIFY as a pipeline, not a barrier.
//
// Each angle's findings enter verification the moment that angle lands. A
// barrier here would make every finding wait on the slowest researcher for no
// reason: verifying "does this 10-K actually say $1.2B" does not depend on what
// the competitive-landscape researcher found. The only node that genuinely needs
// every prior result is the synthesizer, and that is a single node downstream.
//
// The cost of skipping the barrier is that a duplicate found by two angles gets
// verified twice. Cross-angle dedupe happens in the reduce below instead, where
// it costs nothing. Latency beats a handful of duplicate verifier calls.
//
// Model tiering, stage 1: a researcher searches, reads, and fills a fixed schema.
// Bounded, repetitive, no cross-angle judgment, and — the part that makes cheap
// safe here — nothing it says survives unless three independent lenses agree.
// The graph is built so a cheap researcher's mistakes get caught rather than
// avoided, which is the whole point of spending on verification instead. That is
// haiku / low, and it is what makes five angles affordable.
// ---------------------------------------------------------------------------

let findingsRaised = 0;
let findingsUnsourced = 0;
let findingsDropped = 0;
let lensesSent = 0;
let lensesReturned = 0;

const perAngle = await pipeline(
  ANGLES,

  // stage 1: one researcher per angle.
  (angle) =>
    agent(
      `Research one angle of this question and report only what a source will back.\n\n` +
        `QUESTION: ${QUESTION}\n` +
        `YOUR ANGLE: ${angle.title}${angle.focus ? ` — ${angle.focus}` : ''}\n` +
        `${AS_OF ? `TODAY IS: ${AS_OF}\n` : ''}` +
        `\n` +
        `This feeds an investment screen. Numbers from here end up in a financial model, ` +
        `so an unanchored number is worse than a missing one.\n\n` +
        `HARD CONTRACT — no source, no finding:\n` +
        `- sourceUrl must be a real URL you actually opened. Not a search page, not a ` +
        `homepage you assume contains it, not a URL you reconstructed from memory.\n` +
        `- publicationDate must be the date the SOURCE was published, in YYYY-MM-DD form ` +
        `(YYYY-MM if the source gives only a month). Not the date you retrieved it.\n` +
        `- quote must be the sentence from that document that carries the claim, copied ` +
        `verbatim. If you cannot copy the sentence, you do not have the finding.\n` +
        `- figure must be the number exactly as printed in the source, units included ` +
        `("$1.24 billion", "3.2%", "27,000"). Do not convert, round, or annualize. Leave ` +
        `it as an empty string when the claim carries no number.\n` +
        `- period is the fiscal or calendar period the figure covers ("FY2025", "Q2 2026"), ` +
        `empty string when not applicable.\n\n` +
        `Prefer primary sources: filings, regulator publications, company disclosures. ` +
        `A trade-press summary of a filing is a secondary source — cite the filing.\n\n` +
        `Report at most ${MAX_FINDINGS_PER_ANGLE} findings, the load-bearing ones. Findings ` +
        `you cannot source will be discarded downstream, so do not spend effort on them. ` +
        `An empty findings array is an acceptable answer. Do not invent findings to fill ` +
        `the list, and do not pad with things everyone already knows.\n\n` +
        `Read only. Do not create or modify any file.`,
      {
        label: `research:${angle.title}`,
        phase: 'Research',
        schema: FINDINGS,
        model: 'haiku',
        effort: 'low',
      },
    ),

  // stage 2: three skeptics per finding, on three distinct lenses.
  //
  // parallel() is a barrier and it is correct here: this angle's reduce needs
  // every verdict for this angle's findings before the angle is done. It is
  // scoped to one angle, so it never blocks a different one.
  (found, angle) => {
    if (!found || !Array.isArray(found.findings)) {
      log(`WARNING: research on "${angle.title}" returned nothing usable. Angle excluded.`);
      return null;
    }

    const raised = found.findings.filter(Boolean);
    findingsRaised += raised.length;

    // The contract enforced in plain JS, before spending a single verifier.
    // A schema can require a string; it cannot require the string to be a URL.
    const sourced = raised.filter(hasSource);
    if (raised.length > sourced.length) {
      findingsUnsourced += raised.length - sourced.length;
      log(
        `[${angle.title}] dropped ${raised.length - sourced.length} finding(s) with no usable ` +
          `source URL or no publication date. No source, no finding: ` +
          `${raised.filter((f) => !hasSource(f)).map((f) => snippet(f.claim)).join(' | ')}`,
      );
    }

    const toVerify = sourced.slice(0, MAX_FINDINGS_PER_ANGLE);
    if (sourced.length > toVerify.length) {
      findingsDropped += sourced.length - toVerify.length;
      log(
        `[${angle.title}] capped at ${MAX_FINDINGS_PER_ANGLE} findings for verification. ` +
          `Dropped unverified: ` +
          `${sourced.slice(MAX_FINDINGS_PER_ANGLE).map((f) => snippet(f.claim)).join(' | ')}`,
      );
    }

    if (!toVerify.length) return [];

    return parallel(toVerify.map((finding) => () => verifyFinding(finding, angle)));
  },
);

// ---------------------------------------------------------------------------
// REDUCE. Plain JavaScript. No agent, no tokens.
// Count what came back against what we sent at every fan-in, so a dead node
// cannot pass as a clean run.
// ---------------------------------------------------------------------------

const anglesReturned = perAngle.filter(Boolean).length;
if (anglesReturned < ANGLES.length) {
  log(`WARNING: ${ANGLES.length - anglesReturned} of ${ANGLES.length} angles returned nothing.`);
}

if (lensesReturned < lensesSent) {
  log(
    `WARNING: ${lensesSent - lensesReturned} of ${lensesSent} skeptics returned nothing across ` +
      `the run. Missing verdicts were counted as NOT upheld — this graph fails closed, so a ` +
      `dead verifier can only cost a true finding, never admit a false one.`,
  );
}

const verified = perAngle.filter(Boolean).flat().filter(Boolean);

// The third fan-in, and the easiest one to miss: a verifyFinding() call that dies
// outright resolves to null inside parallel() and is dropped by the filter above.
// That finding is then absent from the report entirely — not refuted, not thin,
// just gone. Every angle that reached the counters below incremented all three on
// the same path, so raised minus unsourced minus capped is exactly what was sent.
const findingsSentToVerify = findingsRaised - findingsUnsourced - findingsDropped;
if (verified.length < findingsSentToVerify) {
  log(
    `WARNING: ${findingsSentToVerify - verified.length} of ${findingsSentToVerify} finding(s) ` +
      `sent to verification came back with no verdict record at all. They are missing from the ` +
      `report entirely rather than refuted — treat this run as having a coverage hole, not a ` +
      `clean negative.`,
  );
}

const shortVerified = verified.filter((f) => f.verdictsReturned < LENS_COUNT);
if (shortVerified.length) {
  log(
    `WARNING: ${shortVerified.length} finding(s) were judged on fewer than ${LENS_COUNT} lenses. ` +
      `They needed ${MAJORITY} upheld votes anyway.`,
  );
}

// Majority survives: 2 of 3 lenses. A finding that is true, current, but
// misattributed still fails on one lens and lives — which is the intended
// behaviour, because the synthesizer is told to re-cite from the surviving
// lens evidence. A finding that fails two lenses is gone.
const survived = verified.filter((f) => f.votes >= MAJORITY);
const refuted = verified.length - survived.length;

const ranked = rankByConfidence(dedupeBySource(survived));
const duplicates = survived.length - ranked.length;

log(
  `${ranked.length} finding(s) survived a majority of ${LENS_COUNT} lenses, out of ` +
    `${verified.length} verified and ${findingsRaised} raised. ${refuted} refuted, ` +
    `${duplicates} duplicate(s) merged.`,
);

// The anchoring check, called out separately from the vote count. These findings
// cleared a majority on correctness and currency while their citation went
// unconfirmed. They are reported, never suppressed, but they are never allowed to
// read as strong — and a figure carrying an unconfirmed citation is exactly the
// number that must not reach a model.
const citationUnverified = ranked.filter((f) => !f.attributionUpheld);
if (citationUnverified.length) {
  log(
    `WARNING: ${citationUnverified.length} of ${ranked.length} surviving finding(s) cleared the ` +
      `majority WITHOUT their citation being stood up (attribution lens failed or never ` +
      `returned). They are marked thin and pushed into open questions, not dropped: ` +
      `${citationUnverified.map((f) => snippet(f.claim)).join(' | ')}`,
  );
}

const counts = {
  question: QUESTION,
  asOf: AS_OF || 'not supplied',
  cap: CAP,
  anglesRequested: requestedAngles.length,
  anglesSent: ANGLES.length,
  anglesReturned: anglesReturned,
  anglesDropped: droppedAngles.length,
  findingsRaised: findingsRaised,
  findingsUnsourced: findingsUnsourced,
  findingsDroppedByCap: findingsDropped,
  findingsVerified: verified.length,
  lensesSent: lensesSent,
  lensesReturned: lensesReturned,
  findingsRefuted: refuted,
  duplicatesMerged: duplicates,
  findingsSurviving: ranked.length,
  citationUnverified: citationUnverified.length,
  uniqueSources: unique(ranked.map((f) => normalizeUrl(f.sourceUrl))).length,
};

if (!ranked.length) {
  return {
    headline: 'Nothing survived verification.',
    bottomLine:
      `No finding on "${QUESTION}" survived ${MAJORITY} of ${LENS_COUNT} independent lenses. ` +
      `That is a result, not a failure: on this evidence the question is not yet answerable ` +
      `to a standard a model should be built on.`,
    claims: [],
    contradictions: [],
    openQuestions: [],
    screeningView: 'Insufficient verified evidence to form a screening view.',
    markdown: '',
    citations: [],
    savedTo: null,
    counts: counts,
    humanGate: HUMAN_GATE,
  };
}

// ---------------------------------------------------------------------------
// SYNTHESIZE. One node, the whole surviving set, on the strong tier.
//
// Model tiering, stage 3: this is the only node in the graph that sees all five
// angles at once, and therefore the only one that can spot two verified findings
// that contradict each other — which on an investment question is usually the
// most valuable thing in the run. It runs exactly once and it is the node a human
// actually reads, so opus / high is cheap here. Do not economise on this one.
// ---------------------------------------------------------------------------

phase('Synthesize');

const report = await agent(
  `Write one decision-grade research note answering this question for an investment screen.\n\n` +
    `QUESTION: ${QUESTION}\n` +
    `${AS_OF ? `AS OF: ${AS_OF}\n` : ''}` +
    `\n` +
    `Every finding below already survived three independent skeptics on three lenses: ` +
    `whether the claim is correct, whether it is still current, and whether the cited ` +
    `source actually says it. Do not re-litigate them.\n\n` +
    `RULES, in priority order:\n` +
    `1. Every entry in claims MUST carry a citation built ONLY from the finding it came ` +
    `from, formatted exactly: "sourceTitle, publicationDate — sourceUrl". Copy those three ` +
    `fields verbatim. Never construct, guess, or tidy a URL.\n` +
    `2. Do not introduce a single number that is not in the findings below. Do not convert, ` +
    `annualize, sum, or otherwise derive new figures from them. If a figure needs work to be ` +
    `useful, say so in openQuestions instead of doing the arithmetic here.\n` +
    `3. Where two findings disagree, do not average them and do not silently pick one. Put ` +
    `both in contradictions with both citations and say which source is closer to primary.\n` +
    `4. strength is about evidence, not conviction: "strong" is a primary source with 3/3 ` +
    `lenses upheld, "moderate" is 2/3 or a secondary source, "thin" is a single dated ` +
    `secondary source. The votes and lens verdicts on each finding tell you which.\n` +
    `5. Any finding with attributionUpheld:false MUST be strength "thin" and MUST also ` +
    `appear in openQuestions naming the source that needs to be opened by hand. It cleared ` +
    `correctness and currency, but nobody stood its citation up. Never write it as settled ` +
    `and never let its figure carry the argument.\n` +
    `6. openQuestions is what a human still has to go check before this can support a ` +
    `decision. Be specific and name the missing evidence.\n` +
    `7. screeningView states what this evidence does and does not support, in the language ` +
    `of a first-pass screen. It is not a recommendation to transact, and it must not imply ` +
    `more certainty than ${ranked.length} verified finding(s) across ${anglesReturned} angle(s) ` +
    `can carry.\n\n` +
    `Coverage actually achieved: ${anglesReturned} of ${ANGLES.length} angle(s) returned; ` +
    `${findingsRaised} finding(s) raised, ${verified.length} verified, ${refuted} refuted, ` +
    `${ranked.length} surviving. Let that denominator show in how strongly you write.\n\n` +
    `Output the note only. Do not create or modify any file.\n\n` +
    `VERIFIED FINDINGS (ranked by surviving-vote confidence):\n${JSON.stringify(ranked)}`,
  { label: 'synthesize', phase: 'Synthesize', schema: REPORT, model: 'opus', effort: 'high' },
);

if (!report) {
  log('WARNING: 1 synthesizer sent, 0 returned. Returning the verified findings raw.');
  return {
    headline: 'Synthesis failed.',
    bottomLine:
      `${ranked.length} finding(s) survived verification but the synthesis node returned ` +
      `nothing. The verified findings are returned raw, each with its own citation.`,
    claims: ranked.map((f) => ({
      statement: f.claim,
      citation: citationFor(f),
      strength: !f.attributionUpheld ? 'thin' : f.votes >= LENS_COUNT ? 'strong' : 'moderate',
    })),
    contradictions: [],
    openQuestions: [],
    screeningView: 'Not formed. Synthesis node returned nothing.',
    markdown: '',
    citations: ranked,
    savedTo: null,
    counts: counts,
    humanGate: HUMAN_GATE,
  };
}

// The markdown is assembled in plain JS, not asked for from the model. That is
// what guarantees the SAVE line of the spec — every claim carrying its citation —
// rather than hoping a generator remembered to attach them.
const markdown = buildMarkdown(report, ranked, counts);

// ---------------------------------------------------------------------------
// HUMAN GATE.
//
// The report is the return value. A file is written only when the caller named a
// path in args, and only that path. No default location, no "helpful" second copy,
// nothing under the repo root. If args.reportPath is absent this workflow touches
// the filesystem zero times.
// ---------------------------------------------------------------------------

let savedTo = null;

if (REPORT_PATH) {
  // Model tiering: this node copies a string into a file. There is no judgment in
  // it at all, and giving it a stronger model only buys the chance that it decides
  // to improve the text on the way through. haiku / low, deliberately.
  const wrote = await agent(
    `Write the markdown below VERBATIM to exactly one file:\n${REPORT_PATH}\n\n` +
      `Constraints, all of them hard:\n` +
      `- Write that path and nothing else. Create no other file, modify no other file, ` +
      `delete nothing, run no other command, commit nothing.\n` +
      `- Do not edit, reformat, summarise, or "improve" the content. It is already final ` +
      `and its citations are load-bearing.\n` +
      `- If the path is not writable, stop and say so. Do not fall back to another location.\n\n` +
      `Reply with the path you wrote and nothing more.\n\n` +
      `<<<MARKDOWN\n${markdown}\nMARKDOWN`,
    { label: 'save-report', phase: 'Synthesize', model: 'haiku', effort: 'low' },
  );

  if (!wrote) {
    log(
      `WARNING: 1 writer sent, 0 returned. The report was NOT saved to ${REPORT_PATH}. ` +
        `The full markdown is in the return value below — nothing is lost.`,
    );
  } else {
    savedTo = REPORT_PATH;
    log(`Report written to the one path you passed: ${REPORT_PATH}`);
  }
} else {
  log('No args.reportPath supplied. Nothing written to disk. The report is the return value.');
}

return {
  headline: report.headline,
  bottomLine: report.bottomLine,
  claims: report.claims,
  contradictions: report.contradictions,
  openQuestions: report.openQuestions,
  screeningView: report.screeningView,
  markdown: markdown,
  citations: ranked,
  savedTo: savedTo,
  counts: counts,
  humanGate: HUMAN_GATE,
};

// ---------------------------------------------------------------------------
// Verification. Three skeptics, three DISTINCT lenses.
//
// Each lens is given one job and told to fail closed. They are deliberately not
// interchangeable:
//   1 CORRECTNESS  — is the claim true? Corroborate AWAY from the cited source.
//   2 CURRENCY     — is it still true now, or has it been superseded?
//   3 ATTRIBUTION  — does that document actually say this, in those words?
// Running the same skeptic three times would catch lens 1 three times and lens 3
// never, which is the failure mode that puts a hallucinated URL into a model.
//
// Every lens receives the FINDING ONLY — never the researcher's transcript, and
// never its `relevance` field, which is the researcher's ARGUMENT for the finding
// rather than the finding itself. Passing reasoning across this boundary is the
// one way to defeat the fresh context each agent already has, and it turns an
// independent check into an echo.
// ---------------------------------------------------------------------------

async function verifyFinding(finding, angle) {
  const card = JSON.stringify({
    claim: finding.claim,
    figure: finding.figure,
    period: finding.period,
    sourceTitle: finding.sourceTitle,
    sourceUrl: finding.sourceUrl,
    publicationDate: finding.publicationDate,
    quote: finding.quote,
  });

  const today = AS_OF
    ? `Treat ${AS_OF} as today's date.`
    : `Establish today's date yourself from a dated source before you judge, and state the ` +
      `date you used in the "why" field.`;

  lensesSent += LENS_COUNT;

  const verdicts = await parallel([
    // LENS 1 — CORRECTNESS.
    // Model tiering: the only lens doing open-ended judgment about the world.
    // Sonnet / medium is the floor for an adversarial read worth anything.
    () =>
      agent(
        `LENS 1 of 3 — CORRECTNESS. Your only question: is this claim TRUE?\n\n` +
          `Assume it is false until you prove otherwise. Corroborate it AWAY from the cited ` +
          `source — go find independent evidence of your own. Whether the cited document ` +
          `contains this sentence is a different lens's job and is not your concern.\n\n` +
          `If the claim is materially wrong, cherry-picked, missing the context that reverses ` +
          `its meaning, or you simply cannot corroborate it independently, return upheld:false. ` +
          `Uncertainty is upheld:false. confidence is how sure you are of YOUR verdict.\n\n` +
          `evidence: the independent corroboration or contradiction you found, with its URL.\n\n` +
          `Read only. Do not create or modify any file.\n\n` +
          `FINDING:\n${card}`,
        {
          label: `lens1-correct:${angle.title}`,
          phase: 'Verify',
          schema: VERDICT,
          model: 'sonnet',
          effort: 'medium',
        },
      ),

    // LENS 2 — CURRENCY.
    // Model tiering: date arithmetic against a stated threshold plus one check for
    // a newer print. Bounded, repetitive, mechanical. haiku / low.
    () =>
      agent(
        `LENS 2 of 3 — CURRENCY. Your only question: is this still true NOW?\n\n` +
          `${today}\n\n` +
          `Do not re-argue whether the claim was ever true; that is a different lens. Judge ` +
          `only whether it still holds today.\n\n` +
          `Return upheld:false if any of these hold:\n` +
          `- a newer filing, print, revision, or announcement supersedes this figure;\n` +
          `- the publication date is more than ${MAX_AGE_MONTHS} months before today and the ` +
          `claim is about something that moves (pricing, share, headcount, rates, guidance);\n` +
          `- the publication date is missing, ambiguous, or is clearly a retrieval date rather ` +
          `than a publication date;\n` +
          `- you cannot establish whether something newer exists.\n\n` +
          `A dated historical fact about a closed period stays current, and stale is not the ` +
          `same as wrong — say which one you mean in the "why" field.\n\n` +
          `evidence: the newer source that supersedes it, with its URL and date, or the check ` +
          `you ran that found nothing newer.\n\n` +
          `Read only. Do not create or modify any file.\n\n` +
          `FINDING:\n${card}`,
        {
          label: `lens2-current:${angle.title}`,
          phase: 'Verify',
          schema: VERDICT,
          model: 'haiku',
          effort: 'low',
        },
      ),

    // LENS 3 — ATTRIBUTION. The lens that catches the fabricated URL, which is
    // exactly the failure a cheap researcher is most likely to produce.
    // Model tiering: open one document, find one sentence, compare two strings.
    // A lookup, not a judgment. haiku / low.
    () =>
      agent(
        `LENS 3 of 3 — ATTRIBUTION. Your only question: does the cited source ACTUALLY SAY this?\n\n` +
          `Open sourceUrl yourself and read it. Whether the claim is true in the world is a ` +
          `different lens's job — a true claim attached to a source that never made it is still ` +
          `a fabricated citation, and you must fail it.\n\n` +
          `Return upheld:false if any of these hold:\n` +
          `- the URL 404s, redirects elsewhere, or does not resolve to a real document;\n` +
          `- the quoted sentence does not appear in it, in substance;\n` +
          `- the figure in the finding differs from the figure printed there, including by ` +
          `rounding, unit, currency, or period;\n` +
          `- the document is paywalled or otherwise unreadable, so you cannot confirm;\n` +
          `- the publication date on the document is not the date claimed.\n\n` +
          `evidence: the sentence as it actually appears in the document, copied verbatim, or ` +
          `a precise statement of what you found there instead.\n\n` +
          `Read only. Do not create or modify any file.\n\n` +
          `FINDING:\n${card}`,
        {
          label: `lens3-attribution:${angle.title}`,
          phase: 'Verify',
          schema: VERDICT,
          model: 'haiku',
          effort: 'low',
        },
      ),
  ]);

  const lensNames = ['correctness', 'currency', 'attribution'];
  const back = verdicts.filter(Boolean);
  lensesReturned += back.length;

  // agent() returns null when the user skips it or it dies after retries. A missing
  // verdict is not a vote in favour. Fail closed: it costs a true finding at worst,
  // and admitting a false one into an investment model costs a great deal more.
  const votes = verdicts.filter((v) => Boolean(v) && v.upheld === true).length;

  const confidences = back.map((v) => (Number.isFinite(v.confidence) ? v.confidence : 0));
  const meanConfidence = confidences.length
    ? Math.round((confidences.reduce((s, c) => s + c, 0) / confidences.length) * 100) / 100
    : 0;

  // Attribution is tracked separately from the vote count, because the three lenses
  // are not interchangeable at the reporting stage even though they are at the
  // survival stage. A finding can clear a majority on lenses 1 and 2 while lens 3
  // failed or never returned — true, current, and hung on a citation nobody
  // confirmed. Majority still decides survival (that is the spec), but a claim
  // whose citation was never stood up must not be presented as if it were.
  const attribution = verdicts[2];

  return {
    claim: finding.claim,
    figure: finding.figure,
    period: finding.period,
    sourceTitle: finding.sourceTitle,
    sourceUrl: finding.sourceUrl,
    publicationDate: finding.publicationDate,
    quote: finding.quote,
    sourceType: finding.sourceType,
    angle: angle.title,
    corroboratingAngles: [],
    votes: votes,
    verdictsReturned: back.length,
    meanConfidence: meanConfidence,
    attributionChecked: Boolean(attribution),
    attributionUpheld: Boolean(attribution) && attribution.upheld === true,
    lenses: verdicts.map((v, i) => ({
      lens: lensNames[i],
      upheld: Boolean(v) && v.upheld === true,
      why: v ? v.why : 'No verdict returned. Counted as not upheld.',
      evidence: v ? v.evidence : '',
    })),
  };
}

// ---------------------------------------------------------------------------
// Plumbing. Plain JS, no agents. Flatten, dedupe, rank and format all happen
// here — none of it is worth a token.
// ---------------------------------------------------------------------------

function hasSource(f) {
  if (!f || typeof f.sourceUrl !== 'string' || typeof f.publicationDate !== 'string') return false;
  const url = f.sourceUrl.trim().toLowerCase();
  const date = f.publicationDate.trim();
  // A URL, not a placeholder and not a search results page.
  const looksLikeUrl = url.indexOf('http://') === 0 || url.indexOf('https://') === 0;
  const isPlaceholder =
    url.indexOf('example.com') !== -1 || url.indexOf('n/a') !== -1 || url.length < 12;
  // YYYY, YYYY-MM or YYYY-MM-DD. Anything vaguer is not a publication date.
  const looksLikeDate = /^\d{4}(-\d{2}(-\d{2})?)?$/.test(date);
  return looksLikeUrl && !isPlaceholder && looksLikeDate;
}

function normalizeUrl(url) {
  if (typeof url !== 'string') return '';
  let u = url.trim().toLowerCase();
  const hash = u.indexOf('#');
  if (hash !== -1) u = u.slice(0, hash);
  while (u.length > 1 && u.charAt(u.length - 1) === '/') u = u.slice(0, -1);
  return u;
}

function normalizeClaim(claim) {
  if (typeof claim !== 'string') return '';
  return claim
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

// Dedupe by source. Note the key is source URL PLUS a claim fingerprint, not the
// URL alone: one 10-K legitimately supports several distinct claims, and keying on
// the URL by itself would silently delete all but one of them. Two angles landing
// on the same claim from the same document is the case this actually merges, and
// that independent rediscovery is signal, so it is recorded rather than discarded.
function dedupeBySource(items) {
  const seen = new Map();
  const out = [];
  for (const f of items) {
    const key = `${normalizeUrl(f.sourceUrl)}::${normalizeClaim(f.claim)}`;
    const prior = seen.get(key);
    if (prior) {
      if (prior.angle !== f.angle && prior.corroboratingAngles.indexOf(f.angle) === -1) {
        prior.corroboratingAngles.push(f.angle);
      }
      // Keep the stronger read of the same claim. Attribution ORs upward: if either
      // pass actually opened the document and stood the quote up, the citation is
      // confirmed, and one confirmation is all that claim needs.
      if (f.votes > prior.votes) prior.votes = f.votes;
      if (f.meanConfidence > prior.meanConfidence) prior.meanConfidence = f.meanConfidence;
      if (f.attributionUpheld) prior.attributionUpheld = true;
      if (f.attributionChecked) prior.attributionChecked = true;
      continue;
    }
    seen.set(key, f);
    out.push(f);
  }
  return out;
}

// Rank by surviving-vote confidence: how many lenses upheld it first, then how
// sure those lenses were, then whether a second angle found it independently,
// then recency. Deterministic — no clocks, no randomness.
function rankByConfidence(items) {
  const typeRank = {
    filing: 0,
    regulator: 1,
    company: 2,
    analyst: 3,
    trade: 4,
    press: 5,
    other: 6,
  };
  return items.slice().sort((a, b) => {
    if (a.votes !== b.votes) return b.votes - a.votes;
    if (a.meanConfidence !== b.meanConfidence) return b.meanConfidence - a.meanConfidence;
    const ca = a.corroboratingAngles.length;
    const cb = b.corroboratingAngles.length;
    if (ca !== cb) return cb - ca;
    // A confirmed citation outranks an unconfirmed one at equal vote counts.
    if (a.attributionUpheld !== b.attributionUpheld) return a.attributionUpheld ? -1 : 1;
    const ta = typeRank[a.sourceType] === undefined ? 7 : typeRank[a.sourceType];
    const tb = typeRank[b.sourceType] === undefined ? 7 : typeRank[b.sourceType];
    if (ta !== tb) return ta - tb;
    // ISO dates sort correctly as strings; newer first.
    if (a.publicationDate !== b.publicationDate) return a.publicationDate < b.publicationDate ? 1 : -1;
    return 0;
  });
}

function citationFor(f) {
  return `${f.sourceTitle}, ${f.publicationDate} — ${f.sourceUrl}`;
}

function snippet(text) {
  if (typeof text !== 'string') return '(no claim text)';
  return text.length > 70 ? `${text.slice(0, 70)}…` : text;
}

function unique(items) {
  const seen = new Set();
  return items.filter((i) => {
    if (seen.has(i)) return false;
    seen.add(i);
    return true;
  });
}

// Assembled here rather than asked for from the model, so that "every claim
// carries its citation" is a property of the code and not of a prompt.
function buildMarkdown(report, findings, c) {
  const lines = [];
  lines.push(`# ${report.headline}`);
  lines.push('');
  lines.push(`**Question:** ${c.question}`);
  lines.push(`**As of:** ${c.asOf}`);
  lines.push('');
  lines.push('## Bottom line');
  lines.push('');
  lines.push(report.bottomLine);
  lines.push('');
  lines.push('## Screening view');
  lines.push('');
  lines.push(report.screeningView);
  lines.push('');
  lines.push('## Claims');
  lines.push('');
  for (const claim of report.claims || []) {
    lines.push(`- **[${claim.strength}]** ${claim.statement}`);
    lines.push(`  - Source: ${claim.citation}`);
  }
  lines.push('');

  if ((report.contradictions || []).length) {
    lines.push('## Contradictions between verified sources');
    lines.push('');
    for (const x of report.contradictions) lines.push(`- ${x}`);
    lines.push('');
  }

  if ((report.openQuestions || []).length) {
    lines.push('## Open questions before this supports a decision');
    lines.push('');
    for (const q of report.openQuestions) lines.push(`- ${q}`);
    lines.push('');
  }

  lines.push('## Evidence table');
  lines.push('');
  lines.push('| Claim | Figure | Period | Lenses upheld | Citation stood up | Source | Published |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const f of findings) {
    lines.push(
      `| ${cell(f.claim)} | ${cell(f.figure) || '—'} | ${cell(f.period) || '—'} | ` +
        `${f.votes}/${LENS_COUNT} | ${f.attributionUpheld ? 'yes' : '**NO — verify by hand**'} | ` +
        `[${cell(f.sourceTitle)}](${f.sourceUrl}) | ${f.publicationDate} |`,
    );
  }
  lines.push('');
  lines.push('## Verification log');
  lines.push('');
  for (const f of findings) {
    lines.push(`- **${snippet(f.claim)}** — ${f.votes}/${LENS_COUNT} upheld, mean confidence ${f.meanConfidence}`);
    for (const l of f.lenses) {
      lines.push(`  - ${l.lens}: ${l.upheld ? 'upheld' : 'not upheld'} — ${cell(l.why)}`);
    }
  }
  lines.push('');
  lines.push('## Count check');
  lines.push('');
  lines.push(
    `Angles sent ${c.anglesSent}, returned ${c.anglesReturned}, dropped by cap ${c.anglesDropped}. ` +
      `Findings raised ${c.findingsRaised}, discarded for missing source or date ${c.findingsUnsourced}, ` +
      `dropped by per-angle cap ${c.findingsDroppedByCap}, verified ${c.findingsVerified}. ` +
      `Skeptics sent ${c.lensesSent}, returned ${c.lensesReturned}. ` +
      `Refuted ${c.findingsRefuted}, duplicates merged ${c.duplicatesMerged}, ` +
      `surviving ${c.findingsSurviving} across ${c.uniqueSources} unique source(s), ` +
      `of which ${c.citationUnverified} carry a citation that was never stood up.`,
  );
  lines.push('');
  lines.push(`> ${HUMAN_GATE}`);
  lines.push('');
  return lines.join('\n');
}

function cell(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

function emptyCounts() {
  return {
    question: QUESTION,
    asOf: AS_OF || 'not supplied',
    cap: CAP,
    anglesRequested: 0,
    anglesSent: 0,
    anglesReturned: 0,
    anglesDropped: 0,
    findingsRaised: 0,
    findingsUnsourced: 0,
    findingsDroppedByCap: 0,
    findingsVerified: 0,
    lensesSent: 0,
    lensesReturned: 0,
    findingsRefuted: 0,
    duplicatesMerged: 0,
    findingsSurviving: 0,
    citationUnverified: 0,
    uniqueSources: 0,
  };
}
