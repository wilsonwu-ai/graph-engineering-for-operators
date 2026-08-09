# The dynamic-workflow script API, as verified

This is the long form of [§16 of the article](README.md#16-corrections-to-what-is-circulating).
§16 lists the corrections; this file is the whole contract, so you can check a script against
it line by line without reading the prose.

Checked against the dynamic-workflows tool definition shipping in Claude Code **v2.1.226**
(August 2026). This surface is moving quickly — verify against your own version before relying
on it. `claude --version` tells you which you have.

---

## Hard requirements

1. **File extension must be `.js`.** The loader rejects `.mjs`, `.cjs`, and `.ts`. It counts them
   as near-misses and skips them silently, so a `.ts` file in your workflows directory simply
   never appears and never explains why.
2. **First statement must be `export const meta = { ... }`, and it must be a PURE LITERAL.**
   No variables, no function calls, no spreads, no template interpolation anywhere inside it.
   It is parsed statically, before the script runs.
   - Required: `name` (string), `description` (string).
   - Optional: `whenToUse` (string), `phases` (array of `{title, detail?}`).
   - Every string you pass to `phase()` or `opts.phase` must match a `meta.phases[].title`
     exactly, or that phase gets its own separate progress group.
3. **Plain JavaScript only.** Type annotations, interfaces, generics, and `as` casts all fail
   to parse. This is not a TypeScript file that happens to be named `.js`.
4. **`Date.now()`, `Math.random()`, and argless `new Date()` all throw.** They would break
   resume. Pass timestamps in through `args`, or stamp results after the workflow returns. For
   per-item variation, vary the prompt or label by index.
5. **No filesystem or Node API access in the script body.** No `require`, no `fs`. The agents
   you spawn have tools; the orchestration script itself does not.
6. **The body runs in an async context.** Use bare `await`. No wrapper IIFE. The script
   `return`s its result.

## Globals

### `agent(prompt, opts?) => Promise<any>`

**The prompt is the first positional argument.** `agent({ task: "..." })` fails.

| Option | Values | Notes |
|---|---|---|
| `schema` | JSON Schema | Forces structured output, validated at the tool-call layer, so a mismatch retries instead of handing you prose. Without it you get the agent's final text as a string. |
| `label` | string | Display label. |
| `phase` | string | Assigns to a progress group. Prefer this over global `phase()` inside `pipeline()`/`parallel()` stages — it avoids races on the global. |
| `model` | `'haiku' \| 'sonnet' \| 'opus' \| 'fable'` | Not `'cheap'`/`'strong'`. **Omitting it inherits the session model**, which is not a neutral default. |
| `effort` | `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` | Omit to inherit session effort. |
| `isolation` | `'worktree'` | The string, not `worktree: true`. Costs ~200-500ms and disk per agent. Only when agents genuinely write files in parallel. |
| `agentType` | string | A custom subagent type, resolved from the same registry as the Agent tool. |

**`agent()` returns `null`** when the user skips it or it dies after retries. Always
`.filter(Boolean)` before consuming results — and decide deliberately whether a missing
verdict counts as a pass or a fail. For a verifier it should fail closed.

**There is no `freshContext` option.** Every subagent gets its own context by construction.
You cannot turn it on because it is never off. You *can* defeat it by pasting a worker's
transcript into a verifier's prompt. Pass the finding, not the transcript.

### `pipeline(items, stage1, stage2, ...) => Promise<any[]>`

No barrier between stages. Item A can be in stage 3 while item B is still in stage 1.
**This is the default for multi-stage work.**

Every stage callback receives **`(prevResult, originalItem, index)`**. That second argument is
how you label later stages without contorting stage one into carrying metadata it should not
have to carry. A stage that throws drops that item to `null` and skips its remaining stages.

### `parallel(thunks) => Promise<any[]>`

A **barrier** — it awaits everything before returning. It takes an array of *thunks*
(`() => agent(...)`), not promises. A thunk that throws resolves to `null`; the call itself
never rejects.

Reach for it only when a stage genuinely needs every prior result at once: deduping across the
complete set, early-exiting on a zero count, or a prompt that compares one finding against all
the others. "I need to flatten first" is not a reason — do that inside a pipeline stage.

### Others

- `log(message)` — a progress line shown to the user.
- `phase(title)` — starts a new progress group.
- `args` — the value passed as the Workflow tool's `args` input, verbatim. `undefined` if
  absent. Handle that; do not assume your keys exist.
- `budget` — `{ total: number|null, spent(), remaining() }`. **`remaining()` is `Infinity`
  when `total` is null**, so always guard budget loops with `budget.total &&` or they run to
  the 1000-agent backstop.
- `workflow(nameOrRef, args?)` — run another workflow inline. Nesting is one level only.

## Limits

| Limit | Value |
|---|---|
| Concurrency per workflow | `min(16, cores - 2)` — excess queues, it does not fail |
| Total agents per workflow | 1000 (hard backstop) |
| Items per single `parallel()`/`pipeline()` call | 4096 |

## Where workflows load from

| Location | Source label |
|---|---|
| `~/.claude/workflows/*.js` | `userSettings` — available in every project |
| `<project>/.claude/workflows/*.js` | `projectSettings` — version-controlled with the repo |

The workflow's name comes from `meta.name`, not the filename. Only `.js` is read; anything
else in the directory (a README, a house rule) is inert and safe to keep there.
