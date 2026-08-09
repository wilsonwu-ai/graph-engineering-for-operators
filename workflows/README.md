# Ready-to-paste graph specs

Four specs I actually use. Each one is the same diamond (fan out, reduce, verify, synthesize) aimed at a different job.

**How to run one:** paste the spec into Claude Code with the word **workflow** in your prompt. Claude writes the orchestration script and spawns the fleet. Swap the bracketed parts for your own.

**Before your first run:** keep the `CAP` line, and make sure it caps the axis that actually multiplies. A cap on the outer list while the per-item verify fan-out runs free is not a cap — twenty sites at fifteen findings each is 321 agents, not 20. See [§13 guardrail 2](../README.md#13-what-it-costs-honestly).

There is also a full runnable script in [`demo-site-audit.workflow.js`](demo-site-audit.workflow.js) if you would rather read the code than the prose, and executable versions of all four specs in [`runnable/`](runnable/) — read the caveat at the top of that README before installing one.

---

## 1. Multi-site audit (operations)

Breadth no single context could hold. One agent per site, a skeptic on every finding, and a count check so a dead node cannot quietly shrink the report.

```text
▸ GRAPH SPEC
GOAL:        audit every site listed in [file/list] for [stale pricing / broken links / wrong hours]

FAN OUT:     one agent per site, in parallel
CONTRACT:    every finding returns { site, issue, url, impact }
VERIFY:      an independent skeptic per finding, told to refute by default
REDUCE:      dedupe by url, rank by impact
CAP:         20 sites on this first run
ON FAIL:     report how many sites came back vs how many I sent, never skip silently
REPORT:      one ranked list, plus the count check
```

---

## 2. Decision-grade research (investing)

The verify step is doing the work here, not the research step. Three lenses, not three identical skeptics: a claim can be wrong by being false, by being stale, or by being attributed to a source that never said it.

```text
▸ GRAPH SPEC
GOAL:        decision-grade research on [question]

FAN OUT:     split into 5 distinct angles, one researcher per angle, in parallel
CONTRACT:    every finding needs a source URL and a publication date. no source, no finding.
VERIFY:      three skeptics per finding on distinct lenses:
             (1) is the claim correct
             (2) is it current
             (3) does the cited source actually say this
             keep only what survives a majority
REDUCE:      dedupe by source, rank by confidence
SAVE:        research-report.md with every claim carrying its citation
HUMAN GATE:  change nothing after that without asking me
```

---

## 3. Catalog copy audit (ecommerce)

The `ANCHOR` line is the important one. Without it the verifier is checking marketing copy against marketing copy, which is an echo, not a check.

```text
▸ GRAPH SPEC
GOAL:        check every product page in [store] for copy that misdescribes the actual garment

FAN OUT:     one agent per product page, in parallel
ANCHOR:      the SKU name and spec sheet are the source of truth, not the marketing copy
VERIFY:      independent checker on each flagged page, fresh look, must cite the exact line
CAP:         30 pages on this first run
REPORT:      flagged pages only, with the offending line quoted
HUMAN GATE:  propose edits, change nothing live
```

---

## 4. Repo sweep of unknown size (engineering)

For jobs where you do not know how big the work is until you are inside it. The `DEDUPE` line is the one people get wrong: dedupe against everything seen, not against what was confirmed, or rejected findings reappear every round and the loop never runs dry.

```text
▸ GRAPH SPEC
GOAL:        hunt [repo] for [missing auth checks / broken error handling / dead code]

FAN OUT:     run finders in parallel
DEDUPE:      each new find against everything already SEEN, not just against what was confirmed
VERIFY:      independent checker on the survivors
LOOP:        keep going until two consecutive rounds find nothing new, then stop
CAP:         a hard limit on total agents so it cannot run away
REPORT:      final list ranked by severity, plus what got dropped
```

---

## The lines worth keeping in every spec

| Line | Why it earns its place |
|---|---|
| `CONTRACT` | Forces validated structured output instead of prose the next node has to guess at. |
| `ANCHOR` | Gives the verifier something that cannot argue back. Without it you built an echo. |
| `VERIFY` | The worker never checks its own work. Pass the finding, not the transcript. |
| `CAP` | Your first run is a purchase of information, not of the result. Cap **every** axis — the outer list *and* the per-item fan-out beneath it — then state the worst-case agent count before anything spawns. |
| `MODEL` | Name the tier on every node. An omitted `model` inherits your session tier, so the node you forgot is usually the most multiplied one in the graph and now also the most expensive. |
| `ON FAIL` | A silent dead node turns a partial dataset into a report that reads as complete. |
| `HUMAN GATE` | Running wide without you is the point. Shipping without you is not. |
