# Dev mode: partial execution and result reuse

`awe dev` lets you iterate on **one step of a long workflow** without paying for the rest again. It runs the
steps that are missing or out of date, executes the step you name, and stops. Valid results from earlier dev
commands are reused without calling the executor.

`awe run` is unchanged: every run is independent, saves its own record, and never reads dev results. `awe dev`
never imports results from `awe run` either.

## Quick start

```sh
awe init --out demo                      # six-step example, echo executor (no AI calls)
awe dev demo --step 1.2                  # no history yet: runs 1.1, then 1.2, then stops
awe dev demo --step 1.2                  # edit 1.2's prompt first: 1.1 is reused, only 1.2 runs
awe dev demo                             # finishes the workflow: 1.1 and 1.2 reused, the rest runs
awe dev demo                             # everything is valid: nothing runs
```

The output tells you what happened:

```text
Run: 2026-11-09T03-22-04-417Z-3a2162bf
Status: COMPLETED
Execution: SIMULATED (echo; no AI calls)
Dev: session dev-2026-11-09T03-22-04-359Z-c1bfda69; scope step 1.2 (stopped after the target)
Executed: 1, reused: 1
```

Step IDs are the real ones from your files (`1.50`, `3.1.2`, ...). For a 100-step workflow whose steps are
`1.1` ... `1.100`: `awe dev . --step 1.50` runs `1.1`-`1.49` once, then `1.50`; editing `1.50`'s prompt and running
the same command again reuses `1.1`-`1.49`; `awe dev .` then runs only `1.51`-`1.100`.

## Command

```text
awe dev <ENTRY.md|directory> [--step <id> [--invocation <loop>=<n>[,...]]] [--fresh]
        [--acknowledge <address> ...] [--var name=value ...] [--executor ... --command ... --arg ...] [--json]
```

| Option | Meaning |
| --- | --- |
| `--step <id>` | Test this prompt step: reuse valid upstream results, run what is missing or stale, **always run the step itself**, then stop. Downstream steps are not touched. |
| no `--step` | Walk the whole workflow, reusing every valid result and running the rest. |
| `--invocation` | Which pass through an enclosing LOOP to test, for example `1.1-outer=2,1.1-outer/1.1.2-inner=1` (loop directory path, `=`, iteration, outer to inner). Required only when the step has several known occurrences; the error lists them. |
| `--fresh` | Start a new, empty dev session instead of continuing the latest compatible one. |
| `--acknowledge <address>` | Allow one invocation whose earlier outcome is unknown to run again (see [Recovery](#interruptions-crashes-and-unknown-outcomes)). Repeat for several. |
| `--var`, `--executor`, `--command`, `--arg`, `--json` | As for `awe run`. |

Exit code is `0` when the command completed (a partial run that reached its target counts), `1` otherwise.
`awe status <run-id>` and `awe inspect <run-id> [--step id]` work on dev runs.

## What is reused, and when it stops being valid

Dev results live in a **session** (`.awe/dev/<session-id>/session.json`). By default `awe dev` continues the
newest session that has the same workflow root, the same inputs (`awe.json` input plus `--var`) and the same
executor: the type **and every argument** (a different `--model` is a different executor). Timeouts are ignored
because they do not change a successful result. Anything else gets its own session, and `--fresh` forces a new one.

A stored result is reused only if all of this still holds:

- the step's fingerprint is unchanged: its prompt file, `ENTRY.md`, inputs, executor, declared output files, its
  position in the workflow (including the IF branch and LOOP iteration it ran in), and **the exact results it
  could see from earlier steps**;
- the stored output and every saved output file still exist and match the recorded size and SHA-256.

Consequences:

| You change... | Effect |
| --- | --- |
| a step's prompt | that step and everything after it in sequence run again; earlier steps are kept |
| `ENTRY.md` | every step is stale (it is part of every prompt) |
| an input value (`--var`, `awe.json` input) or the executor command | a different session; the old one is kept |
| rerun a step (`--step`) | everything that could see its result is stale, **even if the new output is identical** |
| nothing | nothing runs |
| a stored file or artifact was edited or deleted | `CACHE_INVALID` is recorded, that step and its dependents run again |

Control flow behaves as in `awe run`, with these rules for partial execution:

- **sequence**: prerequisites run in order; a rerun invalidates all later steps.
- **IF**: the gate is evaluated from the (reused or fresh) results every time. If a gate flips, the new branch runs and
  the step after the IF reruns. A `--step` target in the branch the gate did not select is **not executed**: the
  command fails with `TARGET_UNREACHABLE`.
- **LOOP**: each iteration is its own occurrence of a step (`1.2@stage-2/2.1-loop=3`) and each execution of an
  occurrence is an attempt. Retesting iteration *k* keeps iterations before *k*; later iterations are stale even if
  their values would match, because they only existed since the earlier iteration did not satisfy the gate. If the gate
  now passes earlier, the remaining occurrences are simply never reached.
- **PARALLEL**: branches see the same upstream snapshot and publish together at the join. `--step` on a step inside a
  branch runs only that branch's prerequisites. If one branch fails, siblings that succeeded are kept, so the next command
  repeats only the failed branch and the steps after the join. The join itself is never cached; steps after it are
  stale whenever any branch result changed.

### A failed rerun blocks old results

The moment a step starts executing, its previous success is retired. If the rerun fails, `awe dev` will not quietly fall
back to the earlier success: steps after it cannot be run or reused until it succeeds again. Old attempts stay on disk for
inspection (`awe inspect`), but there is no picker and no promote command.

### Sources are pinned per command

Each `awe dev` command reads `ENTRY.md`, `awe.json` and all prompt files once at the start. Edits made while the command
runs (for example by an executor that rewrites a prompt) apply to the next command. Between commands you can edit freely.

## Output files

Besides text, a step can produce files such as PDFs or images. Declare them per step in `awe.json`:

```json
{
  "version": 1,
  "executor": { "type": "command", "argv": ["node", "make-report.js"] },
  "steps": {
    "1.1": { "outputs": [{ "name": "report", "path": "out/report.pdf" }] }
  }
}
```

and reference the saved copy by name from later steps (and from IF/LOOP expressions):

```md
Review the PDF at {{ steps["1.1"].files["report"] }}
```

`steps[id].output` and `.artifact` keep their meaning (the step's text output). `.files[name]` inserts the absolute path of an
**immutable copy** that AWE made.

How it works:

1. The executor still runs with the workflow directory as its working directory and writes the file at the declared path.
2. Before the executor starts, AWE notes what is at the declared path. After it succeeds, the file must exist, be a regular
   file inside the workflow (symlinks that leave it are refused), and **must have been written by this attempt**. A file that is
   unchanged since before the step started fails the attempt with `OUTPUT_STALE`; a missing file fails it with
   `OUTPUT_MISSING`. A failed attempt is never reusable.
3. AWE copies each file into `.awe/runs/<run-id>/artifacts/files/<step>/attempt-<n>/<name><ext>`, records its size and
   SHA-256, and makes it read-only. Copies are created exclusively, so a later attempt never overwrites an earlier one.
   Downstream steps read the copy. Editing the workspace file afterwards does not change it.
4. Reuse re-verifies the copies. A tampered, resized or missing copy invalidates the cache entry.

Validation (`validate`, `plan`, `run`, `simulate`, `dev`) happens before any executor starts: paths must be relative,
forward-slash, inside the workflow and outside `.awe`; names must be unique per step; every `files[...]` reference must
name a declared output of a step that is guaranteed to have run. **Parallel steps may not declare the same location**
(or one inside another's): `OUTPUT_CONFLICT`.

Declared locations are skipped during step discovery, so a generated `out/` folder or `notes.md` never counts as a
malformed step. Declared outputs also work with `awe run`. With the `echo` executor (including `simulate`) no file can be
produced, so `files[...]` renders `[simulated file: name]` and the run is labelled `SIMULATED`.

## Interruptions, crashes and unknown outcomes

Writes happen in a fixed order so that a crash can never produce a result that looks valid:

1. A durable **intent** for the attempt is committed to the session (this also retires the previous result).
2. The executor runs.
3. The text artifact and output files are written to the attempt's own location.
4. The attempt is recorded in the run's `state.json`.
5. A single atomic file replace commits the result to the session. Only this step makes it reusable.

A session is locked while a command uses it, so two writers can't interleave; a second `awe dev` on the same session fails
with `DEV_SESSION_BUSY` (use `--fresh` for an independent session). The lock of a dead process on the same host is taken over
automatically.

If a command is stopped after the executor may have started but before its result was committed (Ctrl-C, timeout,
`SIGKILL`, power loss), the effects of an external command are **unknown**. AWE never resends such a command by itself,
and it does not claim exactly-once execution. The next `awe dev` stops with `UNKNOWN_EFFECT` and prints the address to
acknowledge once you have checked what the command may have changed:

```sh
awe dev . --acknowledge 1.2
```

The acknowledgement allows that one invocation to run once. A plain non-zero exit is a known failure and needs no
acknowledgement. With the `echo` executor nothing can have happened, so an orphaned attempt is just run again. A run
that a crash left with an unfinished attempt is marked `FAILED` (`RUN_ABANDONED`) the next time that session is opened.

## What is stored

```text
.awe/
  dev/.salt                             random per-workspace key (mode 0600)
  dev/<session-id>/session.json         cache records and a short history per address; lock while in use
  runs/<run-id>/state.json              one run per command: executed/reused invocations, inputs, errors
  runs/<run-id>/artifacts/...           text artifacts and saved output files, one location per attempt
```

`state.json` of a dev run has `mode: "dev"`, a `dev` summary, and an `invocations` list. Each invocation records its address,
attempt, whether it was `EXECUTED` or `REUSED` (and from which run/attempt), its fingerprint, a digest of the upstream results it
saw, the referenced inputs with their result IDs, outputs and errors. Run state is otherwise the v1 format, so existing tools can
read it.

AWE does **not** store executor arguments or credentials in the dev cache: executor and input identity are keyed digests (HMAC
with the per-workspace salt). Compiled prompts are stored only with `"storePrompts": true`, as for `awe run`. Run states and
artifacts still contain inputs and outputs, as before; protect the whole `.awe` directory.

## Compatibility

- `awe run`, `simulate`, `status`, `inspect`, `validate`, `plan`, `explain` keep their behavior and the v1 run format.
  Older runs stay readable. They are never used as dev cache, because they have no trusted dependency records.
- Session files carry a schema version; unknown, malformed or hand-made session files are ignored.
- `awe.json` gains an optional `steps` key. Existing workflows without it are unaffected.

## Limits

- Only **named files** are supported as outputs: no directories and no wildcards.
- AWE does not track other files a step reads, environment variables, or external services. If something outside the
  declared inputs changes, rerun the step with `--step`, or start over with `--fresh`.
- Cache identity trusts the executor command line as written; the behavior of the program it launches is not versioned.
- The lock uses process IDs, so it protects one machine (and a shared filesystem only against processes on the same host).
- Mid-step output is not resumable: an interrupted step runs again from its start.

## Errors

| Code | Meaning |
| --- | --- |
| `DEV_TARGET_NOT_FOUND` | `--step` is not a prompt step |
| `INVOCATION_REQUIRED` / `INVOCATION_INVALID` | `--invocation` is ambiguous, malformed or out of range |
| `TARGET_UNREACHABLE` | the gate or loop never reaches that step/occurrence; it was not executed |
| `UNKNOWN_EFFECT` / `ACKNOWLEDGE_UNKNOWN` | see [recovery](#interruptions-crashes-and-unknown-outcomes) |
| `DEV_SESSION_BUSY` | another `awe dev` holds this session |
| `OUTPUT_MISSING`, `OUTPUT_STALE`, `OUTPUT_INVALID` | a declared file was not produced, was not written by this attempt, or is not a regular file inside the workflow |
| `OUTPUT_CONFLICT` | parallel steps declare overlapping output locations |
