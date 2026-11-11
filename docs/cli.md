# The awe CLI

Four commands. Only `awe run` ever calls an AI command; everything else is read-only.

```text
awe init <dir>                  create a workflow (detects an AI CLI on your PATH)
awe run  [dir] [step] [flags]   run the workflow, or just one step of it
awe show [dir] [step] [flags]   look at results: output, prompt, stderr
awe check [dir]                 validate, list the steps, check the executor
```

`dir` is a workflow folder. Leave it out and awe uses the current folder, or the nearest parent that contains
`ENTRY.md`, so every command also works from a sub-folder. `step` is a step address: `1.2`, `3.1.2`, or `2.1.1@2`
(see [LOOPs](#loops-and-parallel-groups)). A word that looks like `1.2` is always a step, never a folder; write `./1.2`
for a folder with that name.

## Build a workflow one step at a time

A workflow grows from its first step. Run it, read the result, edit the prompt, run it again, then move on:

```sh
awe init coffee && cd coffee
awe run --dry        # preview every prompt; calls nothing
awe run 1.1          # run step 1.1
awe show 1.1         # read its output
awe run 1.1          # not happy? edit 1.1-research.md and run it again
awe run 1.2          # 1.1 comes from the cache, only 1.2 runs
awe run 1.3
awe run              # when it is ready: the whole workflow, from the start
```

Every `awe run` prints what it did:

```text
$ awe run 1.2
Workflow  coffee (6 steps)    Executor  claude -p {prompt}
Cache     on — upstream reused, 1.2 always runs (--no-cache reruns everything)

  1.1     cached   14:02
  1.2     ran      18s   -> .awe/runs/2026-11-11T14-05-01-912Z-3a2162bf/artifacts/1-2-attempt-1.md
Reused 1 step · Ran 1 step
Next  awe show 1.2   ·   awe run 2.1
```

## Configure the AI command

In `awe.json`:

```json
{
  "version": 2,
  "input": { "topic": "How to choose coffee beans" },
  "run": "claude -p {prompt}",
  "timeout": 300
}
```

`run` is one command line. awe splits it into arguments (quotes work: `agent --system "be brief" {prompt}`) and starts the
program directly. **No shell is involved**, so nothing inside a prompt can be interpreted as shell syntax.

| In the command | What the program receives |
| --- | --- |
| `{prompt}` | the rendered prompt as that argument |
| `{prompt_file}` | the absolute path of the saved prompt file (`.awe/runs/<run>/artifacts/prompt-<step>-attempt-<n>.md`) |
| neither | the prompt on **stdin** |

A prompt is a Markdown file with variables; awe fills them in and saves the result before running. When it is too long to
pass as an argument (over 64 KB; 16 KB on Windows) `{prompt}` automatically becomes one line, `Read and follow the
instructions in the file: <path>`, so there is no need to write a wrapper script.

Common commands:

```text
"run": "claude -p {prompt}"
"run": "codex exec {prompt}"
"run": "opencode run {prompt}"
"run": "omp -p"                  # reads the prompt from stdin
```

`awe init` writes the first of `claude`, `codex`, `opencode`, `omp` it finds on PATH. Without a command, `awe run` stops
and shows these examples. It never pretends to have run; use `awe run --dry` to see what would be sent.

Run lines and error messages show the executable and plain flags only; other arguments appear as `…` so a key passed
on a command line never reaches your terminal or logs. Prefer environment variables for credentials.

### Different commands for different steps

```json
{
  "version": 2,
  "run": "claude -p {prompt}",
  "timeout": 300,
  "executors": {
    "search": { "run": "omp -p", "timeout": 900 }
  },
  "steps": {
    "1.1": { "executor": "search" },
    "2.1": { "timeout": 600 }
  }
}
```

Precedence, highest first: CLI flag (`--executor`, `--timeout`) → `steps.<id>` → the named executor → top-level `run` /
`timeout`. The default time limit is 300 seconds per step. A step that times out reports the limit, keeps the last lines
the command wrote to stderr, and suggests `awe run <step> --timeout <longer>`.

## `awe run`

| Flag | Meaning |
| --- | --- |
| `--var key=value` | override an input from `awe.json` (repeatable) |
| `--cache` / `--no-cache` | the one cache switch, see below |
| `--dry` | print the rendered prompts; call nothing, write nothing |
| `--executor <name>` | use a named executor for every step this time |
| `--timeout <sec>` | time limit for each step this time |
| `--retry <step>` | run again a step whose outcome is unknown ([recovery](#interruptions-crashes-and-unknown-outcomes)) |
| `--json` | print the run state as JSON |

Exit codes: `0` finished, `1` a step failed, `2` awe could not start (usage, configuration, workflow files), `130`/`143`
interrupted.

### Cache

One switch. Its default follows what you asked for, and the first lines of the output always say which mode ran:

| Command | Default | What happens |
| --- | --- | --- |
| `awe run 1.2` | cache **on** | steps before 1.2 are reused (run first if missing); **1.2 itself always runs** |
| `awe run` | cache **off** | the whole workflow reruns from the start |
| `--cache` | on | valid results are reused, even in a whole run |
| `--no-cache` | off | everything runs again, including the steps before the one you named |

Whatever the mode, every run stores its results, so a later `awe run 1.3` can use them.

A stored result is reused only if all of this still holds:

- the step's fingerprint is unchanged: its prompt file, `ENTRY.md`, inputs (`awe.json` plus `--var`), its command line
  (every argument: another `--model` is another result; timeouts are ignored), declared output files, its position
  in the workflow (including the IF branch and LOOP iteration), and **the exact results it could see from earlier steps**;
- the stored output and every saved output file still exist and match the recorded size and SHA-256.

| You change… | Effect |
| --- | --- |
| a step's prompt | that step and everything after it in order run again; earlier steps are kept |
| `ENTRY.md` | every step is stale (it is part of every prompt) |
| an input (`--var`, `awe.json`) | everything is stale, and the old results are kept under the old input |
| rerun a step (`awe run 1.2`) | everything that could see its result is stale, **even if the new output is identical** |
| a stored file or artifact | `CACHE_INVALID` is recorded; that step and its dependents run again |

If a rerun fails, awe does not quietly fall back to the older success: later steps cannot be reused until that step
succeeds again. Old attempts stay on disk (`awe show`).

### Loops and parallel groups

- **sequence**: prerequisites run in order; a rerun invalidates all later steps.
- **IF**: the gate is evaluated from the (reused or fresh) results each time. If it flips, the new branch runs. Naming a
  step in the branch the gate did not select fails with `TARGET_UNREACHABLE`; nothing is executed.
- **LOOP**: every iteration is its own occurrence. `awe run 2.1.1@2` is step 2.1.1 in iteration 2 of its loop; with nested
  loops list the iteration of each loop, outer to inner: `1.1.2.1@2.1`. Without `@`, awe uses the only occurrence it has
  seen, or asks you to choose and lists them. Rerunning iteration *k* keeps the iterations before *k*; later ones are stale.
- **PARALLEL**: branches share one upstream snapshot and publish together at the join. Naming a step inside a branch runs
  only that branch's prerequisites. If a branch fails, the siblings that succeeded are kept.
- A group such as `3.1` is not a step; awe lists the steps inside it.

Each `awe run` reads `ENTRY.md`, `awe.json` and every prompt once at the start; edits made while it runs apply to the next
run.

## `awe show`

```text
awe show                  the latest run: status, one line per step, stderr of a failed step
awe show 1.2              the output of step 1.2 (from whichever run last produced it)
awe show 1.2 --prompt     the rendered prompt that was sent
awe show 1.2 --err        the last lines the command wrote to stderr
awe show --run <id>       a specific run (default: the latest)
awe show ... --json       the stored state
```

## `awe check`

Validates `ENTRY.md`, every prompt and flow file (template syntax, references to steps that are not guaranteed to
exist, IF/LOOP settings, output declarations), prints the plan, and looks each configured executable up on PATH. A
workflow with a problem fails with exit `2`. A missing executor is reported (`NOT READY`, and `"ready": false` with `--json`) but does not fail the check, so a CI machine without an AI CLI can still validate workflows.

## `awe run --dry`

Renders every prompt without calling anything. References to earlier results show as `[output of 1.1]` and
`[file report of 1.1]`; every IF branch is shown, and a LOOP body once. Nothing is written: no run, no cache. A dry run
checks wiring and wording; it says nothing about what a model will answer.

## Workflow files

Unchanged: `ENTRY.md` (prepended to every prompt), numbered `N.N-name.md` prompts, `FLOW.json` for `parallel` / `if` /
`loop` groups, and `{{ input.x }}` / `{{ steps["1.1"].output }}` / `{{ steps["1.1"].artifact }}` /
`{{ steps["1.1"].files["name"] }}` references. See the [README](../README.md).

## Output files

Besides text, a step can produce files such as PDFs or images. Declare them per step in `awe.json`:

```json
{
  "version": 2,
  "run": "node make-report.js",
  "steps": {
    "1.1": { "outputs": [{ "name": "report", "path": "out/report.pdf" }] }
  }
}
```

and reference the saved copy by name from later steps (and from IF/LOOP expressions):

```md
Review the PDF at {{ steps["1.1"].files["report"] }}
```

How it works:

1. The command runs with the workflow directory as its working directory and writes the file at the declared path.
2. Before it starts, awe notes what is at that path. After it succeeds the file must exist, be a regular file inside the
   workflow (symlinks that leave it are refused) and **must have been written by this attempt**: an unchanged file fails
   the attempt with `OUTPUT_STALE`, a missing file with `OUTPUT_MISSING`.
3. awe copies each file to `.awe/runs/<run-id>/artifacts/files/<step>/attempt-<n>/<name><ext>`, records its size and
   SHA-256 and makes it read-only. Copies are created exclusively, so a later attempt never overwrites an earlier one.
   Later steps read the copy.
4. Reuse re-verifies the copies; a tampered, resized or missing copy invalidates the cache entry.

Everything is validated before any command starts: paths are relative, forward-slash, inside the workflow and outside
`.awe`; names are unique per step; every `files[...]` reference names an output of a step that is guaranteed to have run.
Parallel steps may not declare the same location (`OUTPUT_CONFLICT`, also through symlinks). A declared output may not go
through a symlink at all (`OUTPUT_INVALID`). Discovery skips each declared file and the generated folders leading to it,
so generated files never count as steps. Only named files are supported: no directories, no wildcards.

## Interruptions, crashes and unknown outcomes

Writes happen in a fixed order so that a crash can never produce a result that looks valid:

1. A durable **intent** for the attempt is committed to the cache (this also retires the previous result).
2. The command runs.
3. The text artifact and output files are written to the attempt's own location.
4. The attempt is recorded in the run's `state.json`.
5. A single atomic file replace commits the result to the cache. Only this makes it reusable.

One `awe run` uses the cache at a time; a second one fails with `CACHE_BUSY` (the lock of a dead process on the same host
is taken over automatically).

If a run stops after the command may have started but before its result was committed (Ctrl-C, a timeout, a signal from
outside such as the OOM killer, a crash or power loss), the effects of an external command are **unknown**. awe never resends
such a command on its own, and does not claim exactly-once execution. The next run stops with `UNKNOWN_EFFECT` and prints
what to do once you have checked what the command may have changed:

```sh
awe run --cache --retry 1.2
```

`--retry` lets that one step run once. A plain non-zero exit is a known failure and needs no `--retry`; a command killed by
a signal is not (its error says `terminated by signal …`). A run that a crash left unfinished is marked `FAILED`
(`RUN_ABANDONED`) the next time the cache is opened.

## What is stored

```text
.awe/
  cache/.salt                           random per-workspace key (mode 0600)
  cache/<session>/session.json          cached results and a short history per step; a lock while in use
  runs/<run-id>/state.json              one record per `awe run`: executed/reused steps, inputs, errors, stderr tail
  runs/<run-id>/artifacts/...           text outputs, prompts and saved output files, one location per attempt
```

`.awe/` is for you: add it to `.gitignore`. It holds inputs, rendered prompts and outputs, so keep it private.
awe does **not** store command lines or credentials in the cache: the executor and the inputs are keyed digests (HMAC with
the per-workspace salt). Set `"storePrompts": false` in `awe.json` to keep prompts only for the moment a command needs them
(`awe show <step> --prompt` then has nothing to show).

## Limits

- awe does not track other files a step reads, environment variables or external services. If something outside the
  declared inputs changes, rerun the step by name (`awe run 1.2`), or start over with `--no-cache`.
- The cache identity trusts the command line as written; the behaviour of the program it launches is not versioned.
- The lock uses process IDs, so it protects one machine only.
- Mid-step output is not resumable: an interrupted step runs again from its start.
- There is no built-in search or token budget. Put one in your prompt ("at most 5 searches") and give slow, tool-using
  steps a longer `timeout`.

## Errors

| Code | Meaning |
| --- | --- |
| `CLI_USAGE` | a flag or argument is wrong; the message lists the valid forms |
| `NO_EXECUTOR`, `UNKNOWN_EXECUTOR` | no command configured, or `--executor` named one that does not exist (lists the names) |
| `INVALID_CONFIG` | `awe.json` has a problem; the message names the key |
| `ENTRY_NOT_FOUND` | not inside a workflow; use `awe init <dir>`, `cd` into one, or pass the folder |
| `STEP_NOT_FOUND` | no such step, or the address names a group (lists the valid steps) |
| `ITERATION_REQUIRED` / `ITERATION_INVALID` | `step@n` is ambiguous, malformed or out of range |
| `TARGET_UNREACHABLE` | the gate or loop never reaches that step; it was not executed |
| `UNKNOWN_EFFECT` / `RETRY_UNKNOWN` | see [recovery](#interruptions-crashes-and-unknown-outcomes) |
| `CACHE_BUSY` | another `awe run` is using this workflow's cache |
| `EXECUTOR_TIMEOUT`, `EXECUTOR_FAILED`, `EXECUTOR_ERROR` | the command timed out, exited non-zero, or could not start |
| `OUTPUT_MISSING`, `OUTPUT_STALE`, `OUTPUT_INVALID`, `OUTPUT_CONFLICT` | see [output files](#output-files) |
| `RUN_NOT_FOUND`, `PROMPT_NOT_STORED` | `awe show` has nothing to show |

## Upgrading from v0.1

| v0.1 | Now |
| --- | --- |
| `awe simulate`, `--executor echo`, the default echo executor | `awe run --dry`; a run without an executor fails with examples |
| `awe dev … --step 1.2` | `awe run 1.2` |
| `awe dev` (finish the workflow) | `awe run --cache` |
| `--fresh` | `--no-cache` |
| `--executor command --command X --arg Y` | `"run": "X Y"` in `awe.json` |
| `--acknowledge <step>` | `--retry <step>` |
| `--invocation loop=2` | `step@2` |
| `awe status`, `awe inspect`, `awe explain` | `awe show` |
| `awe validate`, `awe plan` | `awe check` |
| `awe init --template content --out DIR` | `awe init DIR` |

The old `executor: { type, argv, timeoutMs }` block in `awe.json` still works and prints a deprecation warning with the
replacement; `"type": "echo"` no longer exists. Old `.awe/runs` and `.awe/dev` folders are neither read nor deleted.
