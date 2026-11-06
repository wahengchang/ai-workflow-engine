# Architecture / v0.1

## Core contract

- **Workflow** = directory containing `ENTRY.md` and numbered prompts/groups.
- **Step** = `N.N-slug.md`. Every prompt step has a unique numeric ID and a versioned source file (via Git).
- **Group** = numbered folder or `stage-N-*` folder. Default behavior is sequential.
- **Control group** = folder containing `FLOW.json` with `type: sequence | parallel | if | loop`.
- **Input** = immutable `input.key` variables provided by `awe.json` or `--var`.
- **Step output** = content emitted by a command executor, stored as a separate artifact.
- **Run** = immutable run identifier with state + event trace under `.awe/runs/<run-id>`.

## Execution boundary

- The engine does not semantically judge content. A user-authored prompt may return `PASS` or `FAIL`; IF and LOOP only match exact strings.
- A numbered prompt is a black-box task. The CLI executor is an adapter; no per-step shared conversation is assumed.
- A sequence walks children in numeric order. A parallel group forks a snapshot of its upstream context, waits for all branches, then publishes only entries changed from that snapshot (join barrier). Writes from distinct branches must have distinct IDs; replacing an earlier loop iteration's result is allowed.
- IF reads a rendered `test` expression and chooses one of two named subdirectories. LOOP runs its children up to `maxIterations`, then compares the rendered `until` expression with `equals`.
- Control routing is deterministic. Unsupported expressions fail rather than evaluate arbitrary code.
- `ENTRY.md` is rendered and prepended to every step's prompt. `awe.json` and `FLOW.json` are the only machine-enforced configuration. This avoids conflicting rules in prose.

## Variable grammar

Supported placeholders: `{{ input.topic }}`, `{{ steps["1.2"].output }}`, `{{ steps["1.2"].artifact }}`. The output reference inserts full text; the artifact reference inserts a file path. Use `artifact` for large material. No arbitrary JavaScript evaluation.

Only template source is parsed; inserted values never become template syntax. `\{{` in source emits a literal `{{`. Unsupported and unclosed expressions fail syntax checks before CLI execution. Reference existence and control-flow availability remain runtime checks.

IF and LOOP default to exact comparison after whitespace trimming. Optional `match: first-line` strips one Markdown wrapper from the first non-blank line; `caseInsensitive` folds case. IF's optional `elseEquals` enforces a known negative verdict, failing with `IF_NO_MATCH` for unexpected text.

The CLI passes an AbortSignal to the runtime and executors for SIGINT/SIGTERM. Active steps and the run become `INTERRUPTED`; POSIX executors run in their own process groups for timeout/interruption cleanup. Executor metadata omits argument values. Compiled prompts are persisted only with `awe.json` `storePrompts: true`.

## Interfaces

`awe` CLI → Entry Loader → Directory Resolver → Flow Controller → Prompt Executor → RunStore. `awe explain` shows resolved location/configuration; `awe status` and `awe inspect` expose state and events.

## Security and compatibility

- The engine does not follow symlinked workflow entries during discovery.
- Command executor invokes a known binary through `spawn(..., shell:false)`, not a shell expression. It inherits the user's execution permissions.
- **Only execute trusted workflows and binaries.** Prompts can instruct an external AI agent to call its own tools; AWE does not sandbox that agent.
- Version 0.1 uses `FLOW.json` to avoid implementing a partial, ambiguous YAML parser. A future YAML adapter can be added without changing flow semantics.
- No distributed workers, dynamic `goto`, auto-resume, cancellation API, credentials management, or transactional external side effects in v0.1.
