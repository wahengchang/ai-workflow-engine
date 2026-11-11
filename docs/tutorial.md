# Your first AWE workflow (15 minutes)

This tutorial uses the built-in `echo` executor: no AI account, no network, no cost. Every step "output" is the rendered prompt, so you can see exactly what the workflow sends to an executor.

## Before you start

- Node.js 20 or newer.
- Clone the repository and expose the CLI:

```sh
git clone https://github.com/wahengchang/ai-workflow-engine.git
cd ai-workflow-engine
npm install
npm link            # makes `awe` available
awe --help
```

If you do not want a global link, run `node /absolute/path/to/ai-workflow-engine/bin/awe.js` instead of `awe` everywhere below.

AWE stores run state inside the workflow directory under `.awe/`. Delete `.awe/` at any time to start fresh.

## 1. Create a workflow

```sh
mkdir awe-lab && cd awe-lab
awe init --out hello-awe
cd hello-awe
find . -not -path './.awe/*' -not -name '._*' | sort
```

Expected files:

```text
./ENTRY.md
./awe.json
./stage-1/1.1-research.md
./stage-1/1.2-outline.md
./stage-2/2.1-draft.md
./stage-3/3.1-checks/3.1.1-fact-check.md
./stage-3/3.1-checks/3.1.2-editorial-check.md
./stage-3/3.1-checks/FLOW.json
./stage-3/3.2-deliver.md
```

What you are looking at:

| Thing | Meaning |
| --- | --- |
| `ENTRY.md` | Instructions prepended to every step prompt |
| `awe.json` | Input defaults and the executor config (`echo` here) |
| `stage-*` folders | Plain sequences; order is numeric, not alphabetical |
| `1.1-research.md` | The `1.1` part is the step ID |
| `FLOW.json` | Turns `3.1-checks` into a PARALLEL group (both checks run together) |

## 2. Validate and plan

```sh
awe validate .
awe plan .
```

Expected:

```text
VALID /path/to/hello-awe/ENTRY.md (6 prompt steps)
```

```text
sequence  -        .
sequence  -        stage-1
prompt    1.1      stage-1/1.1-research.md
prompt    1.2      stage-1/1.2-outline.md
sequence  -        stage-2
prompt    2.1      stage-2/2.1-draft.md
sequence  -        stage-3
parallel  3.1      stage-3/3.1-checks
prompt    3.1.1    stage-3/3.1-checks/3.1.1-fact-check.md
prompt    3.1.2    stage-3/3.1-checks/3.1.2-editorial-check.md
prompt    3.2      stage-3/3.2-deliver.md
```

`plan` is the execution order the runtime will use.

## 3. Simulate (safe, no AI)

```sh
awe simulate .
```

Expected shape:

```text
Run: 2026-11-11T02-05-43-635Z-884e7735
Status: COMPLETED
Execution: SIMULATED (echo; no AI calls)
Steps: 6
State: /path/to/hello-awe/.awe/runs/<run-id>/state.json
```

Inspect that run:

```sh
RUN=$(ls -t .awe/runs | grep -v '^\.' | head -1)
awe status "$RUN"
awe inspect "$RUN" --step 2.1
cat .awe/runs/"$RUN"/artifacts/2-1-attempt-1.md
```

The artifact is the **rendered prompt** for step `2.1`, with its templates filled in. `simulate` proves wiring; it does not generate content.

## 4. Run the workflow

```sh
awe run .
```

This creates another run. Because this workflow uses `echo`, the output looks the same as the simulation, but it is a normal run:

```sh
RUN=$(ls -t .awe/runs | grep -v '^\.' | head -1)
awe status "$RUN"
```

`simulate` and `run` never share state. Switch executors later by changing `awe.json` or passing `--executor`/`--command` flags.

## 5. Change one prompt

Open `stage-2/2.1-draft.md` and append this line:

```md
Write for {{ input.audience }} in a friendly tone.
```

Templates can reference:

| Reference | Value |
| --- | --- |
| `{{ input.topic }}` | A value from `awe.json` input defaults or `--var` |
| `{{ steps["1.1"].output }}` | An earlier step's text result |
| `{{ steps["1.1"].artifact }}` | Path to the earlier step's attempt artifact |
| `{{ steps["1.1"].files["report"] }}` | Path to a declared output file copy, if that step declares one |

`awe validate .` or `awe plan .` will reject unknown, forward or out-of-scope references before anything runs.

## 6. Rerun only the changed suffix

```sh
BASE=$(ls -t .awe/runs | grep -v '^\.' | head -1)
awe run . --from 2.1 --reuse "$BASE"
NEW=$(ls -t .awe/runs | grep -v '^\.' | head -1)
awe status "$NEW"
```

Expected status includes:

```text
Partial: from 2.1 of <base-run-id> (reused 2 steps)
```

What happened:

- Steps `1.1` and `1.2` were **reused** from the base run; they did not execute again.
- `2.1` and everything after it ran fresh, because the cut starts there.
- The base run is untouched. The new run records `parentRunId`, `from` and `reusedSteps`.
- A cut may target a prompt ID or a whole numbered control group (`3.1`), never the inside of a control group.
- Partial runs inherit the source input; `--var` is rejected. Use a fresh full run to change inputs.

Reused steps are marked:

```sh
awe inspect "$NEW" --step 1.1   # "reused": true, "originRunId": ...
awe inspect "$NEW" --step 2.1   # fresh attempt, no reused flag
```

## 7. What next

- Change an input for a fresh run:

  ```sh
  awe run . --var topic="Sourdough for busy people"
  ```

- Try the IF and LOOP examples:

  ```sh
  cd /path/to/ai-workflow-engine/examples
  awe run request-routing --json
  awe run bounded-review --json
  ```

- Iterate on a single step of a long workflow with `awe dev --step 2.1`; see [dev mode](dev-mode.md).
- Use a real AI CLI by configuring a command executor:

  ```sh
  awe run . --executor command --command <your-ai-cli> --arg <argument>
  ```

  The rendered prompt goes to the command's stdin; stdout becomes the step output.
- Read [the partial rerun section](../README.md#partial-rerun) and [architecture](architecture.md) when you want the exact reuse rules.

## Cheat sheet

| Command | Purpose |
| --- | --- |
| `awe init --template content --out DIR` | Copy the starter workflow |
| `awe validate PATH` | Check conventions and references |
| `awe plan PATH` | Show resolved execution order |
| `awe simulate PATH` | Echo-only dry run; artifacts are rendered prompts |
| `awe run PATH` | Execute with the configured executor |
| `awe run PATH --from ID --reuse RUN_ID` | Rerun one suffix of an earlier run |
| `awe dev PATH --step ID` | Reuse valid dev results around one step |
| `awe status RUN_ID` | Summarize a stored run |
| `awe inspect RUN_ID --step ID` | Show one step's state and artifact path |
| `awe explain PATH --step ID` | Show how a step is located and configured |

## Troubleshooting

- `PARTIAL_SOURCE_NOT_FOUND`: run `awe run` from the workflow directory and check the ID with `awe status`.
- `PARTIAL_LEGACY_SOURCE`: the source run predates reuse fingerprints; take a fresh full run first.
- `PARTIAL_TOPOLOGY_MISMATCH`: the workflow structure, ENTRY, prompt content or control config changed outside the suffix; start from the earliest changed step or take a fresh run.
- `MISSING_REFERENCE`: a template points at a step that is not guaranteed to have run yet.
- Errors and full event traces are in `.awe/runs/<run-id>/state.json`.
