# Runnable versions of the four graph specs

The [four specs](../README.md) are prompts. These are the same four jobs as executable
orchestration scripts, checked against [`API_CONTRACT.md`](../../API_CONTRACT.md).

| File | `meta.name` | Job | Caps |
|---|---|---|---|
| `multi-site-audit.js` | `multi-site-audit` | Audit a URL list for a named defect class | 90 sites × 10 findings + 1 → 991 |
| `decision-grade-research.js` | `decision-grade-research` | One question, 5 angles, 3-lens verify | 10 angles × 6 findings × 3 lenses |
| `catalog-copy-audit.js` | `catalog-copy-audit` | Product copy vs. the SKU spec sheet | 400 pages |
| `repo-sweep.js` | `repo-sweep` | Defect hunt of unknown size, loop-until-dry | 8 rounds × 12 new per round |

---

## Read this before you install one

**These have not been run.** They parse, they were reviewed line by line against the API
contract, and a review pass caught real defects in them — including one script whose stated
cap of 100 would have spawned 1,101 agents against a 1,000-agent backstop, demonstrated with a
stub run. But reviewed is not the same as run, and none of these has spent a real dollar yet.

That matters because of what [§15](../../README.md#15-build-one-in-ten-minutes) actually says:

> Run one scoped. Watch what it costs. Then widen. When a run comes out good, save its script
> into `.claude/workflows/` and it becomes a single command you launch by name.

The saved workflow is the **end** of that sentence. It is the artifact of a run that already
happened and already had its cost measured. Copying an unrun script into your workflows
directory skips the calibration step the advice exists to protect, and converts an unmeasured
fleet into one keystroke.

So treat this directory as **worked examples to read and adapt**, not as an install kit. The
honest path is still: paste the spec with the word `workflow` in your prompt, watch what the
one scoped run costs, then save the script *that run* produced.

If you do install one anyway, read its cap block first and set the numbers to your own job.

## What they demonstrate

Each one is deliberately more defensive than the [teaching reference](../demo-site-audit.workflow.js),
which is optimized to be read in one sitting. These are optimized to not surprise you:

- **A total-agent worst case computed and logged before anything spawns**, with a refusal
  rather than a silent overrun.
- **An explicit `model` on every single `agent()` call.** Omitting it inherits your session
  tier, which is not a neutral default — see §13 guardrail 4.
- **Returned-vs-sent counts at every fan-in**, so a dead node cannot pass as a clean run.
- **Verifiers that fail closed.** A `null` verdict is not a vote in favour.
- **Caps on every axis**, each logging what it dropped.

## Launching one

```js
Workflow({ name: 'multi-site-audit', args: { sites: [...], defect: 'stale pricing', cap: 20 } })
```

Or point at a file directly without installing it:

```js
Workflow({ scriptPath: 'workflows/runnable/multi-site-audit.js', args: { ... } })
```
