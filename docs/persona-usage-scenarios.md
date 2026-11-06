# Two user scenarios — AWE usability acceptance

Status: proposal and acceptance scenarios for RFC 0001. These are **design cases**, not claims that v0.1 already runs all of these exact contracts.

## Scenario A — beginner: five prompts, one article

Persona: writer who has research, outline, draft, fact-check and final-edit prompts as Markdown files.

Goal: write about `How to choose coffee beans` without a YAML/JSON workflow tutorial.

**Desired authoring structure**

```text
coffee/
├── ENTRY.md
├── 1.1-research.md
├── 1.2-outline.md
├── 2.1-write.md
├── 3.1-fact-check.md
└── 3.2-final-edit.md
```

**Desired actions** (future CLI):

```sh
awe init --template content --out coffee
awe plan coffee
awe simulate coffee --var topic="How to choose coffee beans"
awe run coffee --executor <configured-real-ai-adapter> --var topic="How to choose coffee beans"
awe outputs <run-id>
```

Success: the writer sees ordered steps, knows simulation did not generate a real article, can locate the final artifact, and can inspect a failure without reading engine source.

**v0.1 status:** numbered prompts, `plan`, `run`, artifacts and `inspect` exist; no `init`, `simulate` distinction, explicit final output map or provider-specific adapter yet.

## Scenario B — senior engineer: a small but non-trivial content workflow

Goal: an SEO comparison article. Route based on target audience, then do a bounded revision loop with parallel fact and editorial checks. Stop on qualified result, fail clearly after two attempts, preserve all attempted drafts.

**Proposed file tree**

```text
comparison/
├── ENTRY.md
├── awe.json
├── stage-1/
│   ├── 1.1-research.md
│   └── 1.2-audience-if/
│       ├── FLOW.json                 # IF input.audience == beginner
│       ├── beginner/
│       │   └── 1.2.1-beginner-brief.md
│       └── expert/
│           └── 1.2.2-expert-brief.md
├── stage-2/
│   └── 2.1-revision-loop/
│       ├── FLOW.json                 # LOOP verdict == PASS, maxIterations 2
│       ├── 2.1.1-draft.md
│       ├── 2.1.2-checks/
│       │   ├── FLOW.json             # PARALLEL: all children JOIN
│       │   ├── 2.1.2.1-facts.md
│       │   └── 2.1.2.2-editorial.md
│       └── 2.1.3-verdict.md
└── stage-3/
    └── 3.1-deliver.md
```

**AWE v0.1-compatible control definitions**

`stage-1/1.2-audience-if/FLOW.json`:
```json
{
  "type": "if",
  "test": "{{ input.audience }}",
  "equals": "beginner",
  "then": "beginner",
  "else": "expert"
}
```

`stage-2/2.1-revision-loop/FLOW.json`:
```json
{
  "type": "loop",
  "until": "{{ steps[\"2.1.3\"].output }}",
  "equals": "PASS",
  "maxIterations": 2
}
```

`stage-2/2.1-revision-loop/2.1.2-checks/FLOW.json`:
```json
{ "type": "parallel" }
```

The user-authored `2.1.3-verdict.md` must emit exactly `PASS` for success with v0.1. A future structured result contract might return `{"fields":{"verdict":"PASS"}}` instead.

### Required trace

1. `1.1` completes research.
2. `1.2` selects exactly one audience branch.
3. `2.1.1` writes draft attempt 1.
4. `2.1.2.1` and `2.1.2.2` execute independently and both finish before `2.1.3` starts.
5. `2.1.3` emits `REWORK`; LOOP begins iteration 2.
6. `2.1.1` draft attempt 2; parallel checks join again; `2.1.3` emits `PASS`.
7. `3.1` runs once and produces final delivery; the Run is `COMPLETED`.

### Stress cases (must-have tests)

- `2.1.2.1` fails while `2.1.2.2` is still running; runner must describe its settle/cancel policy and not start `2.1.3`.
- Gate returns neither `PASS` nor `REWORK` or returns invalid JSON: cannot silently treat nonsense as approved.
- Gate never returns `PASS`: exactly two loop iterations, then `LOOP_EXHAUSTED`, and no final delivery.
- A crash after draft attempt 2, before verdict: resumed run must not silently use a new source version or duplicate side effects.
- Beginner branch and expert branch publish distinct output IDs: `3.1` needs an explicit common output mapping or conditional reference; no implicit selection based on guessing.

### Current v0.1 limitations exposed by this example

- IF chooses a branch, but output of differently numbered branches is not automatically merged into one named `brief`. **New proposal:** group output mappings/aliases, strictly validated.
- The revision loop can re-execute its own child steps, but initial prompt references cannot safely read an optional *previous iteration* artifact. **New proposal:** optional iteration-aware reference with explicit first-iteration fallback, not silent missing keys.
- Parallel work has a join barrier, but no configurable `maxConcurrency`.
- There is no durable resume, source snapshot, real adapter preset, or structured named result yet.
- The example is conceptually compatible with the v0.1 grammar, but does not claim its future aliases/recovery behavior is already implemented.

## Design question resolved

This is **not** two workflow engines. The novice writes only sequential Markdown; the senior developer opts into explicitly typed group folders. Both execute through the same compiled plan, run store, and step-result contract.

## Suggested test matrix

| Case | Novice | Engineer | Expected |
|---|---|---|---|
| Straight-line article | ✓ | ✓ | Complete with final artifact |
| Missing input variable | ✓ | ✓ | Compile-time/preflight error |
| IF branch selection | — | ✓ | Exactly one branch runs |
| Parallel reviewer join | — | ✓ | Wait for all required siblings |
| Review loop within budget | — | ✓ | Retain attempts, eventually complete |
| Exhausted review loop | ✓ | ✓ | Bounded, inspectable failure |
| Command executor missing | ✓ | ✓ | Doctor/preflight reports it |
| Simulate with echo | ✓ | ✓ | Clearly marked SIMULATED |
| Resume interrupted run | — | ✓ | Safe replay or explicit blocker |
| Changed source mid-run | — | ✓ | Immutable plan or stop |
