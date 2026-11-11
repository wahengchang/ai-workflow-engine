# AWE design review — two user personas (2026-11-06)

> Historical (v0.1): the commands it mentions (`simulate`, `validate`, `plan`, `inspect`, `init --out`) were replaced in v0.2, see [RFC 0002](rfc-0002-cli-redesign.md).
>
> Status: role-based reviews prepared by the assistant. **These are not claims of independent subagent executions or interviews.** The environment did not provide a delegatable subagent runner. Source baseline: `main` v0.1, audited through `README.md`, `src/{entry,discover,template,runtime,executor,storage,cli}.js`, and the test suite.

## Review method

Each persona independently evaluates the same promise: "Give AWE an entry point; execute a prompt-first, numbered-file workflow from start to terminal state." Use the **Gap Finder** framing to identify missing affordances, and the **Devil's Advocate** framing to challenge complexity and incorrect assumptions. Distinguish observed code facts from design proposals.

## Persona A — novice content author

Goal: Convert 5 Markdown prompts into research → outline → write → review, without learning an orchestration framework.

| ID | Question | Current answer | Decision |
|---|---|---|---|
| A1 | Can I make my first workflow with one command? | No `init` command | **Accept P0:** `awe init --template content --out DIR` |
| A2 | Must I understand ENTRY.md, awe.json and FLOW.json? | All are documented; config concepts are exposed | **Accept P0:** simple mode only requires ENTRY.md and numbered .md; scaffold more only when needed |
| A3 | Where do I choose a real AI provider? | Generic command argv; no tested provider presets | **Accept P0:** `awe doctor`, clear executor selection and preflight; provider adapters later |
| A4 | Can I reuse my existing Markdown prompts? | Yes, after renaming to numbered filenames | **Accept:** examples and migration guide, no auto-rewriting of prompt content |
| A5 | Can I understand progress at a glance? | `status` gives state count, not an ordered progress view | **Accept P0:** stage/step state and last event in status |
| A6 | Where is my final article? | Run artifacts are internal .awe files | **Accept P0:** final output mapping + `awe outputs` |
| A7 | What happens when Review fails? | IF/LOOP authoring is possible with exact string routing | **Accept P0:** branch/loop templates with visible limits; no built-in content score |
| A8 | Can I resume without rewriting everything? | No resume | **Accept P1:** checkpoint/recovery with side-effect warnings |
| A9 | Can I preview without consuming tokens? | `plan` and `validate` exist | **Keep; improve:** preflight missing vars, unreachable branches, version info |
| A10 | Can I use a ready-made content flow? | Example workflow exists, but not a reusable installer/template | **Accept P0:** versioned starter template |

## Persona B — senior software engineer / workflow builder

Goal: Compose nested parallel, IF and LOOP work, precise inputs/outputs, predictable recovery and tests.

| ID | Question | Current answer | Decision |
|---|---|---|---|
| B1 | Can I add an executor or step implementation? | Echo and arbitrary stdin/stdout command exist | **Accept P1:** stable executor + tool adapter contract; avoid arbitrary plugin mutation of state |
| B2 | Can workflow B reuse workflow A's Research stage? | Not yet; filesystem copy required | **Accept P2:** referenced subworkflow/component packages, version-locked |
| B3 | Does Step 6 await the whole Step 5 parallel group? | Yes: `Promise.allSettled` then join | **Keep, harden:** concurrency budget, failure semantics and isolation |
| B4 | Can IF/LOOP route on structured outputs? | Only literal rendered string equals expected string | **Accept P1:** optional JSON result schema and named field selectors |
| B5 | Can I declare inputs/outputs/dependencies beyond numeric order? | Input vars and output references exist; no static dependency validator | **Accept P1:** read/write contract and preflight reference validation |
| B6 | Can I retry/re-run one Step or scope? | LOOP repeats its own group; no run resume or arbitrary step retry | **Accept P1:** checkpoint-aware replay within explicitly allowed scope |
| B7 | What happens if a parallel branch fails? | All branches settle; state is shared/persisted; run fails | **Accept P1:** explicit fail-fast vs settle policy; do not promise rollback |
| B8 | What prevents versions drifting between runs? | Git versions source but no run-level lockfile/snapshot | **Accept P1:** plan snapshot/source hashes, package lock in P2 |
| B9 | Can restart avoid double execution or repeated side effects? | No restart recovery | **Accept P1:** resumable state + idempotency guidance for tool steps |
| B10 | Can I test routing and edge cases? | 9 built-in tests cover baseline | **Accept P0:** fixture matrix, static compiler diagnostics, deterministic fake executor |

## Architecture verdict

1. **Accept**: novice-first CLI experience, clear simulator vs real run, strict preflight, named output artifacts, inspectable failures.
2. **Accept**: typed, nested flow groups, prompt black boxes, bounded routing, structured result contracts, checkpoint/replay, stable adapter boundaries.
3. **Reject**: automatically extracting business semantics or step dependency from arbitrary LLM prose. This is unpredictable and not testable.
4. **Reject**: unrestricted LLM-directed `goto`, ad hoc graph rewrites, and unbounded loops. Branching remains a declared control construct.
5. **Reject**: mandatory global registry/cloud service. AWE should remain local, portable and usable offline except for the chosen model executor.
6. **Reject**: default publishing side effects and "AI approval = correctness". Evaluation is authored by the workflow and subject to permissions.
7. **Defer**: visual editor, distributed workers, live multi-agent chat, graphical process dashboard, and YAML authoring. Avoid growing beyond the core interpreter.

## Current-code observations (not proposals)

- `src/cli.js` defaults to `echo`, and `src/runtime.js` marks the resulting run `COMPLETED`: this can be confused with a real AI run. Proposed: explicit simulation and clear provenance.
- `src/discover.js` and `src/runtime.js` support `sequence`, `parallel`, `if`, `loop`; IF and LOOP compare exact text.
- `src/template.js` allows `input.key`, `steps["N.N"].output`, `steps["N.N"].artifact`, without evaluating JavaScript. Keep this strict model.
- `src/runtime.js` persists step artifacts and state but has no resume API.
- `src/executor.js` accepts an arbitrary executable with `spawn(shell:false)` and inherits the invoker's permissions; it is **not a sandbox**.
- `src/storage.js` snapshots state atomically via temporary rename but does not provide transactionally idempotent external actions.
- `README.md` and `docs/plan.md` explicitly acknowledge the v0.1 limitations. Do not change documentation to claim unimplemented capabilities.

## Next artifact

See [RFC 0001 — AWE v0.2 usability and execution contracts](../rfc-0001-awe-v02-experience.md) for the proposed implementation plan.
