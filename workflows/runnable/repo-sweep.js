/**
 * repo-sweep
 *
 * Spec 4 (engineering) from workflows/README.md, made runnable.
 * For jobs where you do not know how big the work is until you are inside it:
 * hunt a repo for one defect class, keep spawning finders until two consecutive
 * rounds turn up nothing new, then stop.
 *
 * Launch with:
 *   Workflow({ name: "repo-sweep", args: {
 *     target: "src/",                        // path, package, or repo description
 *     defect: "missing auth checks",         // or "broken error handling" / "dead code"
 *     maxAgents: 48                          // optional hard ceiling, defaults to 48
 *   }})
 *
 * The two lines that make this one work, and the two people get wrong:
 *   - DEDUPE against everything already SEEN, not against what was confirmed.
 *   - A hard agent counter, checked before every fan-out, so a loop that will not
 *     run dry stops costing money anyway.
 *
 * Notes for anyone adapting this:
 *   - `meta` must be a PURE LITERAL. No variables, no interpolation, no spreads.
 *   - This is plain JavaScript, not TypeScript. Type annotations will not parse.
 *   - Date.now(), Math.random(), and argless new Date() all throw. Pass time in via args.
 *   - `meta.phases[].title` must match every `phase()` / `opts.phase` string exactly.
 */

export const meta = {
  name: 'repo-sweep',
  description:
    'Hunt a repo for one defect class of unknown size: parallel finders on distinct search angles, looped until two consecutive rounds find nothing new, survivors verified by three lenses on majority rule, reported ranked by severity with everything that got dropped',
  whenToUse:
    'When you do not know how many instances of a defect exist until you are inside the codebase: missing auth checks, unhandled errors, dead code, a bad pattern copied around. Point it at the target, name the defect class, let it run until it runs dry.',
  phases: [
    { title: 'Sweep', detail: 'finders on four distinct angles, one round at a time' },
    { title: 'Verify', detail: 'three independent lenses per survivor, majority keeps' },
    { title: 'Report', detail: 'one ranked write-up on the strong tier' },
  ],
};

// ---------------------------------------------------------------------------
// Contracts. A node whose output is prose is a node only a human can read.
//
// Note what is NOT in FINDS: there is no free-text `rationale` or `notes` field.
// That is deliberate. The verifier downstream receives one of these objects and
// nothing else, so the schema itself is what keeps the finder's reasoning out of
// the check. You cannot leak a transcript through a field that does not exist.
// ---------------------------------------------------------------------------

const FINDS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string' },
          locator: { type: 'string' },
          defect: { type: 'string' },
          evidence: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        },
        required: ['file', 'locator', 'defect', 'evidence', 'severity'],
      },
    },
  },
  required: ['findings'],
};

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    holds: { type: 'boolean' },
    why: { type: 'string' },
  },
  required: ['holds', 'why'],
};

const REPORT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    systemic: { type: 'string' },
    fixOrder: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'systemic', 'fixOrder'],
};

// ---------------------------------------------------------------------------
// Search angles. Four finders per round, and they are genuinely different jobs,
// not four copies of the same grep with the temperature turned up. Four copies
// of one angle find the same things four times and the loop never runs dry
// because it never widened in the first place.
// ---------------------------------------------------------------------------

const ANGLES = [
  {
    key: 'by-file-type',
    brief:
      'BY FILE TYPE. Enumerate the file types and directories in the target first ' +
      '(handlers, models, migrations, config, scripts, templates, generated code). ' +
      'Then walk the categories the other angles never open, especially config, ' +
      'build scripts, and anything generated or vendored. Breadth of surface, not depth.',
  },
  {
    key: 'by-call-site',
    brief:
      'BY CALL SITE. Find the function, decorator, middleware, or helper that is ' +
      'supposed to prevent this defect, then enumerate every call site of the thing ' +
      'it guards and look for the ones that skipped it. Work from the API inward, ' +
      'not from the file list.',
  },
  {
    key: 'by-entrypoint',
    brief:
      'BY ENTRYPOINT. Start at the edges where untrusted input or control enters — ' +
      'routes, CLI commands, queue consumers, webhooks, cron jobs, event handlers — ' +
      'and trace each one forward until the defect appears or the path is provably ' +
      'clean. Reachability is what you are testing.',
  },
  {
    key: 'by-test-gap',
    brief:
      'BY TEST GAP. Read the test suite, not the source. Find behaviour that has no ' +
      'test covering this defect class, and code paths whose tests assert only the ' +
      'happy path. Untested branches are where this defect survives; report the ' +
      'source location, not the test file.',
  },
];

// Three lenses, not three identical skeptics. A finding can be wrong by being a
// misread of the code, by being real but harmless, or by being unreachable in
// practice. One skeptic asked three times gives you one opinion three times.
const LENSES = [
  {
    key: 'correctness',
    instruction:
      'LENS 1 of 3 — CORRECTNESS. Open the file yourself and read the code around ' +
      'the locator. Does the code actually do what the finding claims, or did ' +
      'whoever raised it misread a wrapper, a shadowed name, a base class, or a ' +
      'guard that lives one level up? You are checking the claim against the source, ' +
      'nothing else.',
  },
  {
    key: 'security',
    instruction:
      'LENS 2 of 3 — SECURITY AND BLAST RADIUS. Assume the finding is factually ' +
      'accurate. Does it matter? Name what an attacker or a bad input actually gets ' +
      'out of it, or what breaks in production. If the code is dead, unreachable, ' +
      'internal-only with no untrusted input, or already compensated for elsewhere, ' +
      'it does not hold.',
  },
  {
    key: 'reproduce',
    instruction:
      'LENS 3 of 3 — DOES IT REPRODUCE. Construct the concrete input, request, or ' +
      'state that triggers this, and say exactly what happens. Run it, write a ' +
      'failing test, or trace the exact line sequence. A story about what might ' +
      'happen is not a reproduction. No concrete trigger means it does not hold.',
  },
];

// ---------------------------------------------------------------------------
// Inputs. `args` may be undefined, and any key inside it may be missing or the
// wrong type. Nothing below is allowed to throw on that.
// ---------------------------------------------------------------------------

// Severity ordering, declared up here rather than down with the other plumbing:
// `publicFinding()` reads it inside the loop, and a `const` at the bottom of the
// file is still in its temporal dead zone at that point. Function declarations
// hoist; their captured consts do not.
const SEVERITY = { critical: 0, high: 1, medium: 2, low: 3 };

const INPUT = args || {};

const TARGET =
  typeof INPUT.target === 'string' && INPUT.target.trim() ? INPUT.target.trim() : '.';

const DEFECT = typeof INPUT.defect === 'string' ? INPUT.defect.trim() : '';

// Ceilings. The backstop is 1000 agents per workflow; none of these get near it.
const DEFAULT_AGENT_CAP = 48;
const MIN_AGENT_CAP = ANGLES.length * 2; // enough for one round plus its verification
const HARD_AGENT_CAP = 200;
const MAX_ROUNDS = 8; // a ceiling on top of the dry-streak exit, for the pathological case
const DRY_ROUNDS_TO_STOP = 2;
const MAX_NEW_PER_ROUND = 12; // one round cannot swamp the whole agent budget
const SEEN_BRIEF_CAP = 40; // how many known fingerprints get pasted into a finder prompt
const SYNTH_CAP = 40; // how many confirmed findings get pasted into the report prompt

const rawMax = Number(INPUT.maxAgents);
let AGENT_CAP =
  Number.isFinite(rawMax) && rawMax >= 1 ? Math.floor(rawMax) : DEFAULT_AGENT_CAP;
if (AGENT_CAP > HARD_AGENT_CAP) {
  log(`Requested maxAgents ${AGENT_CAP} exceeds the ${HARD_AGENT_CAP} ceiling. Using ${HARD_AGENT_CAP}.`);
  AGENT_CAP = HARD_AGENT_CAP;
}
if (AGENT_CAP < MIN_AGENT_CAP) {
  log(`Requested maxAgents ${AGENT_CAP} is below the ${MIN_AGENT_CAP} floor (one full round). Using ${MIN_AGENT_CAP}.`);
  AGENT_CAP = MIN_AGENT_CAP;
}

if (!DEFECT) {
  log('WARNING: no defect class given in args.defect. A sweep with no defect class is a browse, not a sweep.');
  return {
    summary: 'Nothing swept: args.defect was missing or empty. Name the defect class to hunt.',
    systemic: '',
    fixOrder: [],
    findings: [],
    dropped: [],
    counts: {
      target: TARGET,
      defect: '',
      rounds: 0,
      agentsUsed: 0,
      agentCap: AGENT_CAP,
      raised: 0,
      unique: 0,
      confirmed: 0,
      dropped: 0,
    },
  };
}

// The report node at the end is an agent too. Reserve its seat instead of
// letting the loop spend the whole cap and then quietly overrun it by one — a
// counter that the graph itself is allowed to exceed is not a cap.
const REPORT_RESERVE = 1;
const SWEEP_CAP = Math.max(AGENT_CAP - REPORT_RESERVE, ANGLES.length);

log(`Sweeping ${TARGET} for: ${DEFECT}`);
log(
  `Hard ceiling: ${AGENT_CAP} agents (${SWEEP_CAP} for the sweep, ${REPORT_RESERVE} reserved ` +
    `for the report), ${MAX_ROUNDS} rounds, stop after ${DRY_ROUNDS_TO_STOP} dry rounds.`,
);

// ---------------------------------------------------------------------------
// State that survives the loop. All plain JS — the reduce never costs a token.
// ---------------------------------------------------------------------------

// `seen` is EVERY fingerprint this run has ever produced, confirmed or refuted.
//
// Dedupe each new find against everything already SEEN, never against what was
// confirmed, or judge-rejected findings reappear every round and the loop never
// converges. A finder that keeps re-raising the same three false positives will
// look like a productive round forever, the dry-streak counter never reaches two,
// and the sweep runs until the agent cap stops it. Rejected still means seen.
const seen = new Set();
const seenOrder = []; // insertion-ordered mirror of `seen`, only for prompt building

const confirmed = [];
const dropped = [];

let agentsUsed = 0;
let round = 0;
let dryStreak = 0;
let raised = 0;
let stopReason = `${DRY_ROUNDS_TO_STOP} consecutive rounds found nothing new`;

// ---------------------------------------------------------------------------
// THE LOOP. Round = one fan-out of finders, dedupe against SEEN, verify what
// is new. Exits on the dry streak, the round ceiling, the agent counter, or the
// budget — whichever comes first, and it says which one.
// ---------------------------------------------------------------------------

while (dryStreak < DRY_ROUNDS_TO_STOP) {
  if (round >= MAX_ROUNDS) {
    stopReason = `hit the ${MAX_ROUNDS}-round ceiling before running dry`;
    log(`Stopping: ${stopReason}.`);
    break;
  }

  // The hard cap. Checked BEFORE the fan-out, against what the fan-out will
  // cost, not after the money is spent.
  const finderCost = ANGLES.length;
  if (agentsUsed + finderCost > SWEEP_CAP) {
    stopReason = `hit the ${AGENT_CAP}-agent cap (${agentsUsed} used) before running dry`;
    log(`Stopping: ${stopReason}.`);
    break;
  }

  // budget.remaining() is Infinity when budget.total is null, so this comparison
  // is meaningless unless it is guarded by budget.total &&. Without the guard the
  // loop happily runs to the 1000-agent backstop.
  if (budget.total && budget.remaining() < finderCost) {
    stopReason = `ran out of budget (${budget.spent()} of ${budget.total} spent) before running dry`;
    log(`Stopping: ${stopReason}.`);
    break;
  }

  round += 1;
  phase('Sweep');
  log(`Round ${round}: ${finderCost} finders, ${seen.size} finding(s) already seen.`);

  // -------------------------------------------------------------------------
  // FAN OUT. parallel() is a barrier, and that is exactly what is wanted here:
  // the dedupe below, and the decision about whether this round was dry, both
  // need every finder's result before the round can be scored. This is the one
  // place in the graph where a stage genuinely depends on all prior results.
  //
  // Model tiering: a finder works one narrow angle and fills a fixed schema.
  // Bounded, repetitive, no cross-finding judgment, and it runs four times per
  // round for as many rounds as it takes — it is the node whose cost multiplies.
  // haiku / low buys recall cheaply; the three-lens gate downstream buys the
  // precision back. Cheap finders plus a strict verifier beats expensive finders
  // that are still trusted on their own word.
  // -------------------------------------------------------------------------

  agentsUsed += finderCost;

  const roundRaw = await parallel(
    ANGLES.map((angle) => () =>
      agent(
        `Hunt this target for one defect class only: ${DEFECT}.\n\n` +
          `TARGET: ${TARGET}\n` +
          `ROUND: ${round}\n` +
          `YOUR ANGLE: ${angle.brief}\n\n` +
          `Work your angle and only your angle. Three other agents are sweeping this ` +
          `same target from different angles right now; your value is the ground they ` +
          `will not cover, not the ground you all share.\n\n` +
          `ALREADY FOUND — do not report any of these again:\n${seenBrief()}\n\n` +
          `Read the actual code. Every finding needs the file path, a locator ` +
          `(function, symbol, or line marker), and an evidence snippet copied from ` +
          `the source. If your angle turns up nothing new, return an empty findings ` +
          `array. An empty round is a real and useful answer and it is how this sweep ` +
          `terminates. Do not pad the list to look productive.`,
        {
          label: `find:${angle.key}:r${round}`,
          phase: 'Sweep',
          schema: FINDS,
          model: 'haiku',
          effort: 'low',
        },
      ),
    ),
  );

  // Fan-in count check. A dead finder is not a clean angle.
  const findersBack = roundRaw.filter(Boolean);
  if (findersBack.length < ANGLES.length) {
    log(
      `WARNING: ${ANGLES.length - findersBack.length} of ${ANGLES.length} finders returned ` +
        `nothing in round ${round}. Those angles are unswept, not clean.`,
    );
  }

  const roundFinds = findersBack
    .map((r) => (r && Array.isArray(r.findings) ? r.findings : []))
    .flat()
    .filter(Boolean)
    .filter((f) => f && typeof f.file === 'string' && typeof f.defect === 'string');

  raised += roundFinds.length;

  // -------------------------------------------------------------------------
  // DEDUPE against SEEN. Plain JS, no agent. See the comment on `seen` above:
  // this is checked against everything ever raised, not against `confirmed`.
  // -------------------------------------------------------------------------

  const fresh = [];
  let repeats = 0;
  for (const f of roundFinds) {
    const fp = fingerprint(f);
    if (seen.has(fp)) {
      repeats += 1;
      continue;
    }
    seen.add(fp);
    seenOrder.push(fp);
    fresh.push({ finding: publicFinding(f), fingerprint: fp, round: round });
  }

  log(
    `Round ${round}: ${roundFinds.length} raised, ${repeats} already seen, ` +
      `${fresh.length} new. Agents used: ${agentsUsed} of ${AGENT_CAP}.`,
  );

  if (!fresh.length) {
    dryStreak += 1;
    log(`Round ${round} was dry (${dryStreak} of ${DRY_ROUNDS_TO_STOP} consecutive).`);
    continue;
  }
  dryStreak = 0;

  // -------------------------------------------------------------------------
  // Cap what goes into verification, and say exactly what got dropped.
  // Anything dropped here is already in `seen`, so it will not come back next
  // round — which is correct for convergence but means it is never checked.
  // That is not allowed to vanish quietly: it lands in `dropped` with a reason.
  // -------------------------------------------------------------------------

  let toVerify = fresh;

  if (toVerify.length > MAX_NEW_PER_ROUND) {
    const overflow = toVerify.slice(MAX_NEW_PER_ROUND);
    toVerify = toVerify.slice(0, MAX_NEW_PER_ROUND);
    log(
      `Round ${round} capped at ${MAX_NEW_PER_ROUND} new findings for verification. ` +
        `${overflow.length} dropped unverified: ${overflow.slice(0, 5).map((x) => x.finding.file).join(', ')}` +
        `${overflow.length > 5 ? ` (+${overflow.length - 5} more)` : ''}.`,
    );
    for (const x of overflow) dropped.push(dropRecord(x, 'round-cap', 'Never verified: over the per-round cap.'));
  }

  const affordable = Math.floor((SWEEP_CAP - agentsUsed) / LENSES.length);
  if (toVerify.length > affordable) {
    const overflow = toVerify.slice(Math.max(affordable, 0));
    toVerify = toVerify.slice(0, Math.max(affordable, 0));
    log(
      `Agent cap allows only ${Math.max(affordable, 0)} verification(s) this round. ` +
        `${overflow.length} new finding(s) dropped unverified: ` +
        `${overflow.slice(0, 5).map((x) => x.finding.file).join(', ')}` +
        `${overflow.length > 5 ? ` (+${overflow.length - 5} more)` : ''}.`,
    );
    for (const x of overflow) dropped.push(dropRecord(x, 'agent-cap', 'Never verified: agent cap reached.'));
  }

  if (budget.total) {
    const budgetAffordable = Math.floor(budget.remaining() / LENSES.length);
    if (toVerify.length > budgetAffordable) {
      const overflow = toVerify.slice(Math.max(budgetAffordable, 0));
      toVerify = toVerify.slice(0, Math.max(budgetAffordable, 0));
      log(
        `Budget allows only ${Math.max(budgetAffordable, 0)} verification(s) this round. ` +
          `${overflow.length} new finding(s) dropped unverified.`,
      );
      for (const x of overflow) dropped.push(dropRecord(x, 'budget', 'Never verified: budget exhausted.'));
    }
  }

  if (!toVerify.length) continue;

  // -------------------------------------------------------------------------
  // VERIFY. pipeline(), not parallel(): finding B's lenses start the moment
  // finding B is ready, and nothing in the tally compares one finding to another,
  // so a barrier across the whole round would only make everything wait on the
  // slowest read for nothing.
  //
  // The inner parallel() IS a barrier, correctly: the majority vote needs all
  // three verdicts on that one finding before it can be scored.
  //
  // Each lens receives the FINDING ONLY — the five schema fields, stripped of
  // even the internal bookkeeping (which angle raised it, which round). Never
  // the finder's reasoning, never its transcript. Pasting either in is the one
  // way to defeat the fresh context every agent already gets by construction,
  // and it turns an independent check into an echo of the finder.
  //
  // Model tiering: this node decides what is true, and its expensive failure
  // mode is waving through a false positive that a human then chases. It does
  // not ride the cheap tier with the finders. sonnet / medium is the floor for
  // an adversarial read that is worth anything.
  // -------------------------------------------------------------------------

  agentsUsed += toVerify.length * LENSES.length;
  log(`Round ${round}: verifying ${toVerify.length} new finding(s) with ${LENSES.length} lenses each.`);

  const judged = await pipeline(
    toVerify,

    // stage 1: three independent lenses on one finding.
    (item) =>
      parallel(
        LENSES.map((lens) => () =>
          agent(
            `${lens.instruction}\n\n` +
              `Default to NOT holding. If you cannot establish it from the code in ` +
              `front of you, return holds:false. Uncertainty is a refutation.\n\n` +
              `This finding is the entire input you get. You are not reviewing a ` +
              `colleague's work and you have none of their reasoning — go look at the ` +
              `code yourself.\n\n` +
              `TARGET: ${TARGET}\n` +
              `DEFECT CLASS: ${DEFECT}\n` +
              `FINDING:\n${JSON.stringify(item.finding)}`,
            {
              label: `verify:${lens.key}:r${item.round}`,
              phase: 'Verify',
              schema: VERDICT,
              model: 'sonnet',
              effort: 'medium',
            },
          ).then((v) => ({ lens: lens.key, holds: Boolean(v) && v.holds === true, why: v ? v.why : null, answered: Boolean(v) })),
        ),
      ),

    // stage 2: tally the majority. Plain JS inside the stage — counting votes is
    // plumbing and plumbing never gets an agent.
    (verdicts, item) => {
      const back = (verdicts || []).filter(Boolean).filter((v) => v.answered);

      // Fan-in count check, per finding.
      if (back.length < LENSES.length) {
        log(
          `WARNING: ${LENSES.length - back.length} of ${LENSES.length} lenses returned nothing ` +
            `on ${item.finding.file}. A missing verdict is not a vote to keep.`,
        );
      }

      // Majority of three means two. Fewer than two answers cannot establish a
      // majority either way, so the finding is dropped, not confirmed.
      if (back.length < 2) {
        return { item: item, kept: false, reason: 'unverified', votes: back };
      }

      const held = back.filter((v) => v.holds);
      return {
        item: item,
        kept: held.length >= 2,
        reason: held.length >= 2 ? 'confirmed' : 'refuted',
        votes: back,
      };
    },
  );

  // Fan-in count check on the pipeline itself. Nulls are attributed by index so
  // a dropped item is named, not just counted.
  if (judged.filter(Boolean).length < toVerify.length) {
    log(
      `WARNING: ${toVerify.length - judged.filter(Boolean).length} of ${toVerify.length} findings ` +
        `fell out of the verification pipeline in round ${round}.`,
    );
  }

  for (let i = 0; i < toVerify.length; i += 1) {
    const j = judged[i];
    if (!j) {
      dropped.push(dropRecord(toVerify[i], 'pipeline-loss', 'Verification pipeline returned nothing for this finding.'));
      continue;
    }
    if (j.kept) {
      confirmed.push({
        file: j.item.finding.file,
        locator: j.item.finding.locator,
        defect: j.item.finding.defect,
        evidence: j.item.finding.evidence,
        severity: j.item.finding.severity,
        round: j.item.round,
        votes: j.votes.filter((v) => v.holds).length,
        lenses: j.votes.map((v) => `${v.lens}:${v.holds ? 'holds' : 'no'}`).join(' '),
      });
    } else {
      dropped.push(
        dropRecord(
          j.item,
          j.reason,
          j.votes.map((v) => `${v.lens}: ${v.holds ? 'holds' : 'refuted'}${v.why ? ` — ${v.why}` : ''}`).join(' | '),
        ),
      );
    }
  }

  log(`Round ${round} complete: ${confirmed.length} confirmed so far, ${dropped.length} dropped.`);
}

// ---------------------------------------------------------------------------
// REDUCE. Plain JavaScript. No agent, no tokens. The ranking is deterministic:
// severity, then vote count, then file. No clocks, no randomness.
// ---------------------------------------------------------------------------

const ranked = rankBySeverity(confirmed);

log(
  `Sweep finished after ${round} round(s): ${raised} raised, ${seen.size} unique, ` +
    `${ranked.length} confirmed, ${dropped.length} dropped. ` +
    `${agentsUsed} of ${AGENT_CAP} agents used.`,
);

const counts = {
  target: TARGET,
  defect: DEFECT,
  rounds: round,
  stopReason: stopReason,
  agentsUsed: agentsUsed,
  agentCap: AGENT_CAP,
  raised: raised,
  unique: seen.size,
  confirmed: ranked.length,
  dropped: dropped.length,
  droppedByReason: tally(dropped),
};

if (!ranked.length) {
  return {
    summary:
      `No ${DEFECT} findings survived three-lens verification in ${TARGET}. ` +
      `${seen.size} candidate(s) were raised and all of them were dropped. ` +
      `Sweep stopped because it ${stopReason}.`,
    systemic: '',
    fixOrder: [],
    findings: [],
    dropped: dropped,
    counts: counts,
  };
}

// ---------------------------------------------------------------------------
// REPORT. One node, the whole surviving set, on the strong tier.
//
// Model tiering: this is the only node in the graph doing cross-finding
// judgment — which of thirty confirmed instances are one root cause, what a
// human fixes first, what the sweep's own blind spots were. It runs exactly
// once, so opus / high effort costs almost nothing against a multi-round sweep,
// and it is the only output a human actually reads. Do not economise here.
// ---------------------------------------------------------------------------

phase('Report');

const forSynthesis = ranked.slice(0, SYNTH_CAP);
if (ranked.length > forSynthesis.length) {
  log(
    `Passing the top ${SYNTH_CAP} of ${ranked.length} confirmed findings to the report agent. ` +
      `The remaining ${ranked.length - forSynthesis.length} are still returned in full in \`findings\`, ` +
      `just not summarised.`,
  );
}

const report = await agent(
  `Write one engineering report on ${DEFECT} in ${TARGET}, ranked by severity, ` +
    `highest first. Every finding below already survived three independent lenses ` +
    `(correctness, security, reproduction) on a majority vote — do not re-litigate ` +
    `them, and do not add findings that are not in this list.\n\n` +
    `In "systemic", say whether these are one root cause showing up in many places ` +
    `or genuinely separate bugs, and name the cause if there is one. In "fixOrder", ` +
    `one line per item: file, locator, severity, and the fix. In "summary", lead ` +
    `with what a human should fix first and why, then state the sweep's coverage ` +
    `honestly — how many rounds ran, why it stopped, and what got dropped ` +
    `unverified, so nobody reads this as an exhaustive list when it is not.\n\n` +
    `SWEEP: ${round} round(s), stopped because it ${stopReason}. ` +
    `${raised} finding(s) raised, ${seen.size} unique, ${ranked.length} confirmed, ` +
    `${dropped.length} dropped (${JSON.stringify(counts.droppedByReason)}).\n\n` +
    `CONFIRMED FINDINGS:\n${JSON.stringify(forSynthesis)}`,
  { label: 'report', phase: 'Report', schema: REPORT, model: 'opus', effort: 'high' },
).catch(() => null);
// This is the only agent call not already wrapped by pipeline() or parallel(), both of
// which absorb a throw into null. Unguarded, a rejecting report node would discard every
// confirmed finding, the drop list, and the whole count check after a multi-round sweep
// has already been paid for. The `if (!report)` fallback below is the intended failure
// path, so route a rejection into it too.

// The report spends its reserved seat. Count it, so the number the user reads
// is the number of agents the run actually cost.
agentsUsed += REPORT_RESERVE;
counts.agentsUsed = agentsUsed;

if (!report) {
  log('WARNING: the report node returned nothing. Falling back to the raw ranked list.');
}

// The count check and the drop list ship next to the report, always. A ranked
// list without its denominator reads as complete even when a third of the fleet
// died or the cap cut the sweep short.
return {
  summary: report
    ? report.summary
    : `Report node failed. ${ranked.length} confirmed finding(s) are listed as returned.`,
  systemic: report ? report.systemic : '',
  fixOrder: report
    ? report.fixOrder
    : ranked.map((f) => `[${f.severity}] ${f.file} — ${f.locator}: ${f.defect}`),
  findings: ranked,
  dropped: dropped,
  counts: counts,
};

// ---------------------------------------------------------------------------
// Plumbing. Plain JS, no agents.
// ---------------------------------------------------------------------------

// The identity of a finding, for the SEEN set. Normalised so that two finders
// describing the same defect in the same place collide instead of both counting
// as new — a dedupe key that is too strict keeps the loop alive forever.
function fingerprint(f) {
  const file = String(f.file || '').trim().toLowerCase();
  const locator = String(f.locator || '').trim().toLowerCase();
  const defect = String(f.defect || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .split(' ')
    .slice(0, 8)
    .join(' ');
  return `${file}::${locator}::${defect}`;
}

// Exactly the five schema fields, nothing else. This is what a verifier sees.
function publicFinding(f) {
  return {
    file: String(f.file || ''),
    locator: String(f.locator || ''),
    defect: String(f.defect || ''),
    evidence: String(f.evidence || ''),
    severity: SEVERITY[f.severity] === undefined ? 'medium' : f.severity,
  };
}

function dropRecord(item, reason, why) {
  return {
    file: item.finding.file,
    locator: item.finding.locator,
    defect: item.finding.defect,
    severity: item.finding.severity,
    round: item.round,
    reason: reason,
    why: why,
  };
}

// Only the most recent fingerprints go into a finder prompt — the list grows
// every round and the prompt cannot. Anything omitted here may get re-reported,
// which costs a little recall but nothing in correctness: the JS dedupe above is
// the real guard, and it sees the whole set.
function seenBrief() {
  if (!seenOrder.length) return '(nothing yet — this is the first round)';
  const shown = seenOrder.slice(-SEEN_BRIEF_CAP);
  const omitted = seenOrder.length - shown.length;
  const lines = shown.map((s) => `- ${s}`).join('\n');
  return omitted > 0 ? `${lines}\n(+${omitted} older finding(s) omitted from this list)` : lines;
}

function rankBySeverity(items) {
  return items.slice().sort((a, b) => {
    const ra = SEVERITY[a.severity] === undefined ? 4 : SEVERITY[a.severity];
    const rb = SEVERITY[b.severity] === undefined ? 4 : SEVERITY[b.severity];
    if (ra !== rb) return ra - rb;
    if (a.votes !== b.votes) return b.votes - a.votes;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.locator !== b.locator) return a.locator < b.locator ? -1 : 1;
    return 0;
  });
}

function tally(items) {
  const out = {};
  for (const i of items) {
    const k = i.reason || 'unknown';
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}
