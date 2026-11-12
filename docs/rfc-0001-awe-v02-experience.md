# RFC 0001 — AWE v0.2: novice-first, composable-by-design

Status: **PROPOSED / NOT IMPLEMENTED**. The CLI surface it sketches (`simulate`, `doctor`, `outputs`, ...) is superseded by [RFC 0002](rfc-0002-cli-redesign.md); the compiler/runtime and recovery proposals below are unchanged.  
Baseline: `main` v0.1; see [Persona Review](persona-review-2026-11-06.md).

Implementation progress: **superseded.** The `awe simulate` command, the echo executor and the `executionMode: SIMULATED | COMMAND` field described in this line were removed by [RFC 0002](rfc-0002-cli-redesign.md) and the v0.2 CLI: `awe run --dry` previews prompts without calling anything, and a run without a configured command stops instead of echoing. The rest of this document is the design record, not current behaviour.

## 1. Problem and non-goals

AWE is a **filesystem-first prompt workflow interpreter**, not a content-quality judge or a distributed job orchestrator. The default experience must be small: an `ENTRY.md` and numbered Markdown steps should suffice for a linear process. A power user can opt in to nested parallel groups, IF, LOOP, deterministic tool steps, and reuse.

The v0.1 foundation supports deterministic routing, outputs, and traces. Gaps: first-run scaffolding, trusted real executor setup, results discoverability, static dataflow diagnostics, robust recovery, reusable packages, and transparent simulation.

**Non-goals:** unrestricted model-created graph jumps; secret or permission management inside prompts; automatic publication; speculative AI-generated dependencies; Kubernetes, cloud coordinator or GUI as a requirement.

## 2. Principles

1. **One mental model:** `ENTRY.md` is the human/agent entry point; numbered `.md` files are prompt work; `FLOW.json` exists only for exceptional control flow; `awe.json` is optional machine configuration.
2. **Convention for simple, explicit for complex:** linear numbered prompts run in order; branches, loops and parallelism must declare their semantics.
3. **Engine interprets structure, never business meaning.** Workflow authors define review tests and pass/fail.
4. **Outputs are the interface, not implicit session memory.** Shared context only through explicit inputs, structured results and artifacts.
5. **No invisible behavior:** compilation, effective configuration, execution source, active step and artifacts are inspectable.
6. **No surprise cost or side effects:** distinguish simulated from real; explicit adapters and command permissions.
7. **Failures are inspectable terminal outcomes, not endless retries.**
8. **Execution plans are immutable within a Run**, even if source files are modified while running.

## 3. User journeys

### A. New content author (target UX, future CLI)

```bash
awe init --template content --out coffee
cd coffee
awe doctor
awe plan .
awe simulate . --var topic="beginner coffee beans"
awe run . --executor codex --var topic="beginner coffee beans"
awe status <run-id>
awe outputs <run-id>
```

`init`, `doctor`, `outputs`, and `--executor codex` are **proposed v0.2+ commands, not currently available**. `simulate`, `run`, and `plan` exist; see the README for current options. `doctor` checks executable availability, auth readiness where detectable, output folder write access and dangerous commands; it does not authenticate automatically.

### B. Advanced workflow author (target UX)

```bash
awe validate . --strict
awe plan . --json
awe explain . --step 3.2
awe test . --fixture tests/review-rework.json
awe run . --executor command --command ./trusted-adapter
awe inspect <run-id> --step 3.2
awe resume <run-id>
```

`--strict`, `test` and `resume` are **proposals**. No implicit dynamic `goto` or fake continuation of partial AI sessions.

## 4. Proposed file convention

```text
coffee/
├── ENTRY.md                      # human/agent instructions; simple workflow works without config
├── awe.json                      # optional machine settings, input schemas, adapters, budgets
├── stage-1-research/
│   ├── 1.1-topics.md
│   └── 1.2-outline.md
├── stage-2-writing/
│   └── 2.1-draft.md
├── stage-3-review/
│   ├── 3.1-review-loop/
│   │   ├── FLOW.json             # explicit loop with bounded attempts
│   │   ├── 3.1.1-check.md
│   │   └── 3.1.2-revise.md
│   └── 3.2-deliver.md
└── .awe/                         # generated per-run state; ignored by Git
    └── runs/<run-id>/
        ├── plan.json             # immutable compiled plan
        ├── state.json            # status, step attempts, events, paths
        ├── artifacts/            # every attempt retained
        └── outputs.json          # named delivery output map
```

No extra file per ordinary step. Keep `FLOW.json` rather than adding YAML or duplicating executable rules in ENTRY prose. Named output location is opt-in, not implicit publication.

### Control group example

```json
{
  "type": "loop",
  "until": "{{ steps[\"3.1.1\"].output }}",
  "equals": "PASS",
  "maxIterations": 3
}
```

This is supported by **v0.1 today** (the example is illustrative). Later support a field selector on a structured result, without evaluating arbitrary JavaScript.

## 5. Compiler -> Runtime separation

```text
CLI / Skill
   ↓
Entry + Package Loader
   ↓
Workflow Compiler
  ├─ numeric discovery + stable path normalization
  ├─ nested group AST: sequence / parallel / if / loop
  ├─ preflight: duplicates, missing refs, unreachable/ambiguous output refs
  ├─ safety: executor / permissions / budgets
  └─ immutable execution plan + input/source digests
   ↓
Runtime Scheduler
  ├─ sequence, IF, bounded LOOP, structured parallel join
  ├─ deterministic state transitions
  ├─ Executor Adapter: echo(simulate), command, provider
  ├─ Artifact + Context Store
  └─ Checkpoint / Trace / Resume
   ↓
Output Map + Inspector
```

AWE v0.1 currently combines discovery and runtime concerns more tightly; this is a **target responsibility split**, not an assertion about the current code.

### Minimal internal contracts

`CompiledNode`: `id`, `type`, `source`, `children`, `config`, `inputs`, `outputs` (declarative; no LLM evaluation).

`StepInvocation`: `runId`, `stepId`, `attempt`, `compiledPrompt`, `inputs`, `artifactReferences`, `limits`, `executor`.

`StepResult`:
```json
{
  "status": "COMPLETED",
  "output": "Rendered text or a reference to artifact",
  "artifacts": [{ "name": "draft", "path": "artifacts/2-1-attempt-1.md" }],
  "fields": { "verdict": "PASS" }
}
```

`status` describes execution success/failure, **not business review PASS**. Workflow-authored `fields.verdict` may drive a declared IF/LOOP route after validation. Plain text remains the default and works without structured output. The engine never treats arbitrary prose as a control instruction.

### Runtime states

Run: `CREATED → RUNNING → COMPLETED | FAILED | BLOCKED | CANCELLED`, optionally `PAUSED` when a pause/resume boundary exists.

Step: `PENDING → RUNNING → COMPLETED | FAILED | SKIPPED`; a retry is a distinct **attempt**, not an overwrite of history.

The v0.1 runtime currently supports only a subset; state schema changes require migration tests.

## 6. Explicit simulation

Implemented slice: `awe simulate` always uses echo, rejects executor overrides, and labels CLI/state as `SIMULATED`. Echo `run` is labeled too. `status` remains an execution lifecycle field; `executionMode` is separate. Requiring real executor selection for `run` remains a future compatibility decision. Echo output still drives control flow literally, so simulation is not a model-quality or all-routes test.

**Problem in v0.1:** `echo` can finish with `COMPLETED` even though no AI executed.

**Proposed behavior:** `awe simulate` uses echo, prints `SIMULATED` on the run, and never implies an AI-generated artifact. For `awe run`, require explicit executor selection unless the project has a deliberately configured real executor. Upgrade must preserve v0.1 compatibility with a temporary deprecation warning and tests; do not silently break scripts.

## 7. Parallel, failure and retry semantics

- A parallel group shares an **upstream snapshot**, not the same mutable step context, and uses a **join barrier** before downstream execution.
- Sibling steps may finish in any order, but deterministic trace identity and unique output keys are required.
- Introduce `maxConcurrency` (per parallel group and global cap) to prevent unbounded forks.
- On branch failure, the default is **settle** then fail the group; fail-fast is optional only if child executor cancellation is reliable.
- Bounded `loop` is the only default rework mechanism. Free-form `goto` is rejected.
- `resume` resumes from an immutable plan and persisted completion records. Re-executing a command with side effects requires explicit idempotency policy or a human check. **No exact-once guarantee**.

## 8. Reuse and customization

Keep source workflows local and portable. P0 use **copyable starter templates**, but not silent mutable shared directories.

P2 allow explicit `use` of a **versioned** subworkflow/component, resolved into a lockfile. A project may override *inputs and selected steps*, but validation must detect broken references and record source provenance. No mandatory central registry or cloud service.

The folder number (e.g. `3.1.2`) is a **human execution address**, not an unchanging identity across renumbering. Add stable identifiers only when package reuse/upgrade requires them, preserving existing file conventions.

## 9. Sequenced delivery and acceptance tests

### P0 — ease of adoption (first implementation PR)

- `awe init` produces a ready-to-run two-stage content workflow.
- `awe doctor` shows executor configuration and permissions clearly.
- `awe simulate` and real `awe run` have distinguishable results.
- `awe status` shows ordered stage/step progress; `awe outputs` lists final artifacts.
- `validate --strict` rejects duplicate IDs, missing input/output refs, bad IF branches, unsupported flow config, and clear self/circular reference mistakes.
- Tests cover beginner path, no provider, malformed refs and simulated output semantics.

### P1 — operational correctness

- Compile immutable plan and source/input hashes; save at run start.
- StepResult schema with optional structured fields, text fallback.
- Concurrency limit, branch failure policy and bounded retries.
- Crash-safe resume and replay rules for safe vs side-effectful steps.
- Executor capability checks, bounded stdout/stderr and cancellation.
- Fault-injection tests: aborted command, partial artifacts, broken state, parallel failure, loop exhaustion, ambiguous branch reference.

### P2 — cross-project composition

- Referenced reusable stages / component packages with lockfile.
- Project-local overrides with explicit diff and provenance in `awe explain`.
- Compatibility tests and deterministic golden fixtures.
- Tested Codex/Claude/OpenCode command adapters.
- Optional Human Gate and tool plugin contract.

### Exit criteria

1. A beginner turns five prompts into a working content workflow without writing routing JSON.
2. A senior builder expresses nested parallel + IF + bounded LOOP without editing Engine source.
3. `plan` exposes the same reachable steps/control routes that `run` follows, subject to inputs and runtime results.
4. Every output/branch/attempt can be traced to source, executor and run.
5. Changing source during a Run cannot silently change subsequent steps.
6. A crashed run either resumes under a declared safe policy or stops with an intelligible blocker, never silently double-publishes.
7. Existing v0.1 fixtures remain supported or are migrated with deliberate compatibility notes.

## 10. Decision ledger

- **Keep:** numbered Markdown, `ENTRY.md`, `awe.json`, `FLOW.json`, strict variable syntax, command executor, offline local-first core.
- **Add first:** scaffold + doctor + simulate boundary + output discovery + compiler diagnostics.
- **Add next:** structured contracts + checkpoint/replay + concurrency budgets + reusable package resolution.
- **Reject:** unconditional web publishing, mandatory dashboard, LLM-generated arbitrary jumps, built-in content-quality claims, required hosted orchestration.
