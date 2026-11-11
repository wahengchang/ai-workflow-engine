# Architecture / v0.1

## Core contract

- **Workflow** = directory containing `ENTRY.md` and numbered prompts/groups.
- **Step** = `N.N-slug.md`. Every prompt step has a unique numeric ID and a versioned source file (via Git).
- **Group** = numbered folder or `stage-N-*` folder. Default behavior is sequential.
- **Control group** = folder containing `FLOW.json` with `type: sequence | parallel | if | loop`.
- **Input** = immutable `input.key` variables provided by `awe.json` or `--var`.
- **Step output** = content emitted by a command executor, stored as a separate artifact.
- **Run** = immutable run identifier with state + event trace under `.awe/runs/<run-id>`.
- **Execution mode** = additive run-state `executionMode: SIMULATED | COMMAND`, derived from the effective executor. Success/failure remains in `status`; command execution does not prove that an AI model was used.

## Execution boundary

- The engine does not semantically judge content. A user-authored prompt may return `PASS` or `FAIL`; IF and LOOP only match exact strings.
- A numbered prompt is a black-box task. The CLI executor is an adapter; no per-step shared conversation is assumed.
- A sequence walks children in numeric order. A parallel group forks a snapshot of its upstream context, waits for all branches, then publishes only entries changed from that snapshot (join barrier). Writes from distinct branches must have distinct IDs; replacing an earlier loop iteration's result is allowed.
- IF reads a rendered `test` expression and chooses one of two named subdirectories. LOOP runs its children up to `maxIterations`, then compares the rendered `until` expression with `equals`.
- Control routing is deterministic. Unsupported expressions fail rather than evaluate arbitrary code.
- `awe simulate` forces echo regardless of configured executor and rejects executor CLI overrides. It uses the regular runtime and control conditions; it does not invent model output or bypass failed gates. Legacy `awe run` executor selection and exit codes remain supported, with an explicit execution label.
- `ENTRY.md` is rendered and prepended to every step's prompt. `awe.json` and `FLOW.json` are the only machine-enforced configuration. This avoids conflicting rules in prose.

## Variable grammar

Supported placeholders: `{{ input.topic }}`, `{{ steps["1.2"].output }}`, `{{ steps["1.2"].artifact }}`. The output reference inserts full text; the artifact reference inserts a file path. Use `artifact` for large material. No arbitrary JavaScript evaluation.

Only template source is parsed; inserted values never become template syntax. `\{{` in source emits a literal `{{`. Unsupported and unclosed expressions fail syntax checks before CLI execution. Reference existence and control-flow availability remain runtime checks.

IF and LOOP default to exact comparison after whitespace trimming. Optional `match: first-line` strips one Markdown wrapper from the first non-blank line; `caseInsensitive` folds case. IF's optional `elseEquals` enforces a known negative verdict, failing with `IF_NO_MATCH` for unexpected text.

The CLI passes an AbortSignal to the runtime and executors for SIGINT/SIGTERM. Active steps and the run become `INTERRUPTED`; POSIX executors run in their own process groups for timeout/interruption cleanup. Executor metadata omits argument values. Compiled prompts are persisted only with `awe.json` `storePrompts: true`.

## Interfaces

`awe` CLI → Entry Loader → Directory Resolver → Flow Controller → Prompt Executor → RunStore. `awe explain` shows resolved location/configuration; `awe status` and `awe inspect` expose state and events.

## Partial rerun

`awe run PATH --from ID --reuse RUN_ID` executes an exact atomic suffix of a previous run of the same workflow: each prompt is one unit and each IF/LOOP/PARALLEL group is one atomic unit; sequence folders stay transparent and numbered sequence group ids are alias for their first executed step. New runs record additive `fingerprints` (topology, ENTRY bytes, resolved input, prompt/FLOW hashes, per-completed-step artifact hashes and declared-output-file hashes) plus `parentRunId`/`from`/`reusedSteps`; reused steps carry `reused: true`, `originRunId` and artifact and output-file copies created inside the new run. Verification is read-only until the new run directory is created: workflow identity (realpath), run-ID identity, terminal status allowlist (COMPLETED/FAILED/INTERRUPTED; FAILED/INTERRUPTED only when each required upstream unit completed), fingerprint completeness, resolved-cut validity, topology/ENTRY/input-defaults/upstream-prompt/upstream-FLOW equality, suffix-reference visibility (IF contributes only its chosen branch; PARALLEL joins; LOOP final completed iteration only), artifact and output-file existence/containment/hash, and execution-mode equality. Input defaults are snapshotted separately (`inputSource.defaults`/`vars`) so defaults drift is detectable while source `--var` values carry over verbatim.

## Security and compatibility

- The engine does not follow symlinked workflow entries during discovery.
- Command executor invokes a known binary through `spawn(..., shell:false)`, not a shell expression. It inherits the user's execution permissions.
- **Only execute trusted workflows and binaries.** Prompts can instruct an external AI agent to call its own tools; AWE does not sandbox that agent.
- Version 0.1 uses `FLOW.json` to avoid implementing a partial, ambiguous YAML parser. A future YAML adapter can be added without changing flow semantics.
- No distributed workers, dynamic `goto`, auto-resume, cancellation API, credentials management, or transactional external side effects in v0.1.

## Dev mode and output files (`awe dev`)

Details and user rules: [dev-mode.md](dev-mode.md). Engineering contract:

- **Reused, not forked.** `awe dev` walks the same AST (`discover.js`), gate logic (`gateValue`), prompt builder (`buildPrompt`),
  executor, template renderer and `RunStore` as `awe run`. Only `src/dev.js` (walk, fingerprints, reuse) and `src/dev-store.js`
  (session file, lock, intent/commit) are new; `src/outputs.js` holds named-file declaration, capture and verification.
- **Identity.** An *address* (`<step>[@<loop>=<n>,...]`) names one occurrence of a step; an *attempt* is one execution of it. A result's
  fingerprint covers the step's plan path, source, ENTRY, inputs, executor identity, declared outputs, control path (IF branch, LOOP
  iteration plus a digest of the previous iteration, PARALLEL branch), the rendered prompt, and the `resultId`s of every earlier
  step it could see (`precontext`: lower workflow order only, so never itself or later steps). Every execution gets a new `resultId`,
  so a rerun invalidates dependents by cause, not by value.
- **One session file** per input/executor combination, replaced atomically (temp file, fsync, rename), guarded by a per-session
  lock file. Executor/input identity is stored as an HMAC keyed by a per-workspace salt, never as argv.
- **Commit order:** intent (retires the previous result) → executor → artifact/files (exclusive create) → run state → atomic commit.
  Leftover intents are *unknown outcomes* for command executors and require a per-address `--acknowledge`.
- **Run isolation.** Dev runs are ordinary run directories with `mode: "dev"`; `awe run` neither reads `.awe/dev` nor writes dev
  fields, and dev never reads results from a run.
- **Output files.** Declared in `awe.json` `steps.<id>.outputs`, referenced as `steps[id].files[name]`, captured after success into
  an attempt-specific directory and re-verified (size + SHA-256) on every reuse. Parallel overlaps are rejected in preflight.
- **Test seam.** `cli(argv, cwd, { hooks })` accepts `afterIntent | afterExecute | afterArtifact | afterFiles | beforeCommit |
  afterCommit` callbacks used by the crash tests; they are not a public API.
