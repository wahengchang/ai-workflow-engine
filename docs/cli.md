# The awe CLI

Four commands. Only `awe run` ever calls an AI command; everything else is read-only.

```text
awe init <dir>                  create a workflow (detects an AI CLI on your PATH)
awe run  [dir] [step] [flags]   run the workflow, or just one step of it
awe show [dir] [step] [flags]   look at results: output, prompt, stderr
awe check [dir]                 validate, list the steps, check the executor
```

`dir` is a workflow folder. Leave it out and awe uses the current folder, or the nearest parent that contains
`awe.json`, so every command also works from a sub-folder. `step` is a step address: `1.2`, `3.1.2`, or `2.1.1@2`
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
Workflow  coffee (6 steps in plan)    Executor  claude -p {prompt}
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

The command also receives three environment variables: `AWE_STEP` (`1.2`), `AWE_ADDRESS` (`2.1.1@2` inside a loop) and
`AWE_RUN_ID`, so a wrapper script can tell which step it is serving. The prompt itself carries no step header.

Common commands:

```text
"run": "claude -p {prompt}"
"run": "codex exec {prompt}"
"run": "opencode run {prompt}"
"run": "omp -p"                  # reads the prompt from stdin
```

`awe init` writes the first of `claude`, `codex`, `opencode`, `omp` it finds on PATH. Without a command, `awe run` stops
and shows these examples. It never pretends to have run; use `awe run --dry` to see what would be sent.

Run lines, `awe check` and error messages show the executable, plain flags, `{prompt}` and any file that exists inside
the workflow (so `node agent.cjs {prompt}` shows which agent it is); other arguments appear as `…`, so a key passed on
a command line never reaches your terminal or logs. Prefer environment variables for credentials.

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

Exit codes: `0` finished, `1` a step failed, `2` awe could not start (usage, configuration, workflow files),
`129`/`130`/`143` interrupted by SIGHUP/SIGINT/SIGTERM.

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

- the step's fingerprint is unchanged: its prompt file, the common text, inputs (`awe.json` plus `--var`), its command line
  (every argument: another `--model` is another result; timeouts are ignored), declared output files, its JSON declaration, its position
  in the workflow (including the IF branch and LOOP iteration), and **the exact results it could see from earlier steps**;
- the stored output and every saved output file still exist and match the recorded size and SHA-256.

| You change… | Effect |
| --- | --- |
| a step's prompt | that step and everything after it in order run again; earlier steps are kept |
| the common text | the steps that write `{{ common }}` are stale; the others are kept |
| a step's JSON declaration | that step and everything that could see its result run again |
| an input (`--var`, `awe.json`) | everything is stale, and the old results are kept under the old input |
| rerun a step (`awe run 1.2`) | everything that could see its result is stale, **even if the new output is identical** |
| a stored file or artifact | `CACHE_INVALID` is recorded; that step and its dependents run again |

A step that runs although a cache is in use says why, in brackets: `(not cached yet)`, `(the common text changed)`, `(its prompt file
changed)`, `(an earlier step ran again)`, `(its command changed)`, `(its previous attempt failed)`. A step you named, or a run
with `--no-cache`, needs no reason.

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

Each `awe run` reads `awe.json` and every prompt once at the start; edits made while it runs apply to the next
run.

## `awe show`

```text
awe show                  the latest run: status, one line per step, stderr of a failed step
awe show 1.2              the output of step 1.2 (from whichever run last produced it)
awe show 1.2 --prompt     the rendered prompt that was sent
awe show 1.2 --err        the last lines the command wrote to stderr
awe show 2.1.1@2          one LOOP iteration (same address form as `awe run`)
awe show --run <id>       a specific run (default: the latest)
awe show ... --json       the stored state
```

## `awe check`

Validates the common text, every prompt and flow file (template syntax, references to steps that are not guaranteed to
exist, IF/LOOP settings, output declarations), prints the plan, and looks each configured executable up on PATH. A
workflow with a problem fails with exit `2`. A missing executor is reported (`NOT READY`, and `"ready": false` with `--json`) but does not fail the check, so a CI machine without an AI CLI can still validate workflows.

## `awe run --dry`

Renders every prompt without calling anything. References to earlier results show as `[output of 1.1]` and
`[file report of 1.1]`; every IF branch is shown, and a LOOP body once. Nothing is written: no run, no cache. A dry run
checks wiring and wording; it says nothing about what a model will answer.

## Common text (`"common"` in `awe.json`)

A workflow is a folder that holds `awe.json` (it can be as small as `{ "version": 2 }`); awe finds it from any sub-folder by
walking up. `"common"` is optional text you want to reuse in several prompts: who the AI is working as, the audience, tone,
rules ("never invent sources"), the output format. It is **not** added to anything automatically. A prompt includes it
where, and only where, it writes `{{ common }}`:

```json
{
  "version": 2,
  "input": { "topic": "tea" },
  "common": [
    "Only reply in zh-TW.",
    "You write for beginners about {{ input.topic }}."
  ]
}
```

```md
<!-- 1.3-final.md -->
{{ common }}

Write the final checklist, one step per line.
```

| | |
| --- | --- |
| **What a step sends** | its own prompt file, rendered, and nothing else: no header, no preamble. `awe show 1.3 --prompt` prints exactly that. With the example above the step sends `Only reply in zh-TW.` / `You write for beginners about tea.` / a blank line / `Write the final checklist…`. |
| **Form** | a string, or an array of lines (joined with newlines; easier to read than one long string). Leading and trailing whitespace is trimmed. |
| **Where** | anywhere in a prompt, any number of times, in any position: first line, last line, inside a sentence. The spelling is fixed: `{{ common }}` (spaces optional). |
| **Variables** | it is rendered like a prompt, so `{{ input.topic }}` works. It cannot use `{{ steps[...] }}` (any step may use it, including the first, where nothing has run yet) or `{{ common }}` itself. Put step references in the step's own prompt. |
| **Mistakes** | `{{ common }}` in a prompt but no `"common"` in `awe.json`: error at `awe check`. `"common"` defined but no prompt writes it: warning, because it is sent nowhere. |
| **Only the root one** | an `awe.json` in a sub-folder (`stage-2/awe.json`) is **not** used for that folder's steps. `awe check` / `awe run` warn about it. Running awe from inside `stage-2/` would treat that folder as its own, separate workflow. |

Every step is its own AI call with no memory of the others, so a step that writes `{{ common }}` sends it with that call: a
hundred such steps send it a hundred times, once per call, never accumulating. Steps that do not write it do not pay for it.
Keep it short because of that cost, not because of how it is written. `awe check` prints how many steps use it.

Lifecycle:

1. `awe init` writes a starting `"common"`, and its prompts start with `{{ common }}`.
2. `awe check` validates its syntax and references and prints its size and which steps use it. It warns above 4,000 characters.
3. Each `awe run` (and `awe run --dry`) reads it once at the start and renders it into the prompts that write `{{ common }}`.
4. Only those steps depend on it: **editing it, even a comma, makes exactly the steps that write `{{ common }}` stale**, and
   the next run that uses the cache says so on each one it reruns: `1.3  ran  18s  (the common text changed)`.
5. Run outputs keep the rendered prompt per attempt, so the exact text that was sent stays inspectable.

Rule of thumb: if several prompts need the same text, put it in `"common"` and write `{{ common }}` where it belongs; if one
prompt needs it, write it in that prompt; if it changes between runs, put it in `input` (`--var`).

There is no file for this on purpose: v0.1's `ENTRY.md` did two jobs under a misleading name (root marker and shared text),
and a `COMMON.md` would only rename the problem. A leftover `ENTRY.md` is not used; `awe check` / `awe run` warn about it, and a
folder that has an `ENTRY.md` but no `awe.json` is rejected with the ready-to-paste `awe.json` (its lines already
escaped as JSON). There is no `awe migrate` command: it is a one-time step, and the message already contains its result.
With `--json`, such warnings are also in the output as `"warnings"`.

## Order, and what a step receives

Steps run in numeric order, not file-name order: `1.1`, `1.2`, then everything in `stage-2/` (`2.1`, `2.2`), then `10.1` after
`9.1`. A plain folder is a sequence; `FLOW.json` turns it into `parallel`, `if` or `loop`. A folder needs a numeric
prefix (`2.1-review/`) or a `stage-N` name (`stage-2/`): a folder just called `2/` that holds prompts is rejected, with
the name to use instead.

A step receives exactly one thing: its own prompt, with `{{ … }}` filled in (including `{{ common }}`, if it writes it). It does not
receive earlier steps' prompts or outputs, and the AI keeps no memory between steps. To use an earlier result, name it in
the step's prompt: `{{ steps["1.1"].output }}` (the text) or `{{ steps["1.1"].artifact }}` (the file path).

## Workflow files

Unchanged: numbered `N.N-name.md` prompts, `FLOW.json` for `parallel` / `if` /
`loop` groups, and `{{ input.x }}` / `{{ steps["1.1"].output }}` / `{{ steps["1.1"].artifact }}` /
`{{ steps["1.1"].files["name"] }}` references. See the [README](../README.md).

A folder inside the workflow is part of it only if it is a numbered or `stage-N` folder, or holds a `FLOW.json` or a numbered
prompt somewhere below. Any other folder (`out/`, `state/`, a `notes/` folder of plain Markdown that a step created) is
ignored, so scratch space written by a command never turns a working workflow into one that cannot be checked or run. A
folder that does hold numbered prompts but is not itself numbered fails with `INVALID_STEP` and says how to rename it. Plain
files are different: a non-numbered `.md` file in a workflow folder is still an error, so declare files a step writes
there under `steps.<id>.outputs`, or write them into a dot-folder such as `.state/`.

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

## JSON output

A step can promise that its answer is JSON. awe parses and checks it **before the step counts as done**, so a later prompt
can read parts of it, and a bad answer stops the workflow where it happened. Declare it per step in `awe.json`:

```json
{
  "version": 2,
  "steps": {
    "1.1": {
      "json": {
        "type": "array",
        "minItems": 3,
        "maxItems": 3,
        "items": {
          "type": "object",
          "required": ["role", "perspective"],
          "properties": {
            "role": { "type": "string" },
            "perspective": { "type": "string" }
          }
        }
      }
    }
  }
}
```

`"json": true` means "any valid JSON". Omit `json` or set it to `false` to disable validation. Later prompts read it by key and index:

```md
Role: {{ steps["1.1"].json[0].role }}
View: {{ steps["1.1"].json[0].perspective }}
```

With three parallel steps `1.2.1`, `1.2.2`, `1.2.3` reading `[0]`, `[1]` and `[2]`, each branch gets its own role. Nothing
else changes: `{{ steps["1.1"].output }}` is still the raw text and `{{ steps["1.1"].artifact }}` the saved file.

**Reading values.** A path is `.key`, `[0]` or `["key with spaces"]`, one after another. A string is inserted as it is, a number
or boolean as its text, `null` as the literal text `null`, and an object or array as compact JSON (so `{{ steps["1.1"].json }}` is the whole value). There is no
arithmetic, no calls and no other syntax: a template cannot run code or read inherited properties. Own JSON keys named
`__proto__` or `constructor` are plain data and can be read like any other key. A
missing key or an index past the end is an error that names the place: `There is no "perspective" at json[1] (it has: role)`,
`Index 2 is out of range at json: the array has 2 items`. The same paths work in `FLOW.json` gates:
`"test": "{{ steps[\"2.1\"].json.verdict }}"`.

**What counts as JSON.** The **whole** output must be JSON. A Markdown code fence, or any text before or after it, is an
error (`OUTPUT_NOT_JSON`) that says which, and tells you to ask the model for the JSON alone. Ask for that in the prompt
("Reply with only the JSON, no code fence, no explanation").

**The declaration.** A small subset of JSON Schema; any other key is rejected when `awe.json` is read, so a typo is never
silently ignored:

| Key | Meaning |
| --- | --- |
| `type` | `object`, `array`, `string`, `number`, `integer`, `boolean`, `null` (or a list of them) |
| `minItems`, `maxItems` | array length; both `3` means exactly three |
| `items` | a declaration every array item must satisfy |
| `required` | field names an object must have; use `properties` to also check their types |
| `properties` | declarations for named fields, applied when the field is present |
| `enum` | the allowed JSON values; object key order does not matter, array order does |

Array keywords apply only to arrays; `required` and `properties` apply only to objects. Include `type` to reject the
wrong shape. Fields not listed in `properties` are allowed; this subset has no `additionalProperties` keyword.

A violation (`OUTPUT_JSON_INVALID`) lists what is wrong, with paths, for example `$ must have exactly 3 items, got 2` or
`$[1].perspective is required`. Either way the step fails and **its downstream steps do not start** (a parallel group after it
never forks). If the step is inside an already-started parallel group, siblings finish independently and successful sibling
results remain cached; the failing branch stops and the join does not run.

The model's raw output stays saved, so the failure shows where: `The model's raw output is saved in .awe/runs/…`.
`awe show 1.1` prints the latest raw answer, including a rejected one; `awe show 1.1 --json` includes its error and
`rejectedArtifact` path. Use `--run <id>` to inspect an older answer, or an occurrence such as `1.1.1@2` for a loop.
This is a known failure: inspect the answer, fix the prompt or declaration, and run `awe run 1.1` again without `--retry`.
That command stops after the named step; `awe run --cache` then continues the workflow using valid cached results.
JSON rejection does not undo any files or other effects produced by the command.

**Checks.** `awe check` verifies the syntax of every JSON reference and that the step it reads is declared (and runs earlier),
but not the data, which does not exist yet; that is checked when the step runs. `awe run --dry` shows
`[json of 1.1[0].role]` where a value would go.

**Cache.** The declaration is part of the step's fingerprint: changing or removing it reruns the step (and so the steps that
read it) and says `(its JSON declaration changed)`. A cached JSON step is parsed again when it is reused, so later steps still read
it, and a stored output that no longer fits its declaration is rerun instead of reused.

Upgrading from a build before JSON output invalidates existing step fingerprints once (`awe was upgraded`); the next
cached run executes those steps again. Existing `awe.json` files and raw artifacts remain readable.

**Limits.** The number of parallel branches is still written in `FLOW.json`: this reads values out of one answer, it does not
create a branch per array item (a dynamic `foreach` would be a separate feature).

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
- Nothing prunes `.awe/runs` or `.awe/cache`, and every run that executes steps writes new artifacts, prompts and saved files (a whole run ignores the cache by default, so it rewrites the same artifacts under a new run id). Delete `.awe/` to reclaim space; the next run starts a fresh cache. Cached results point into the run folders that produced them, so deleting only some old runs is safe but makes the steps that lived there run again.
- A step inside a `loop` cannot see which iteration it is in: there is no `{{ loop.iteration }}`. `@n` addresses an iteration from the outside (`awe run 2.1.1@2`), but a prompt that should behave differently in round 2 has to read the previous step's output. A template variable for it is a possible follow-up, not part of v0.2.
- There is no built-in search or token budget. Put one in your prompt ("at most 5 searches") and give slow, tool-using
  steps a longer `timeout`.

## Errors

| Code | Meaning |
| --- | --- |
| `CLI_USAGE` | a flag or argument is wrong; the message lists the valid forms |
| `NO_EXECUTOR`, `UNKNOWN_EXECUTOR` | no command configured, or `--executor` named one that does not exist (lists the names) |
| `INVALID_CONFIG` | `awe.json` has a problem; the message names the key |
| `WORKFLOW_NOT_FOUND` | not inside a workflow; use `awe init <dir>`, `cd` into one, or pass the folder |
| `STEP_NOT_FOUND` | no such step, or the address names a group (lists the valid steps) |
| `ITERATION_REQUIRED` / `ITERATION_INVALID` | `step@n` is ambiguous, malformed or out of range |
| `TARGET_UNREACHABLE` | the gate or loop never reaches that step; it was not executed |
| `UNKNOWN_EFFECT` / `RETRY_UNKNOWN` | see [recovery](#interruptions-crashes-and-unknown-outcomes) |
| `CACHE_BUSY` | another `awe run` is using this workflow's cache |
| `EXECUTOR_TIMEOUT`, `EXECUTOR_FAILED`, `EXECUTOR_ERROR` | the command timed out, exited non-zero, or could not start |
| `OUTPUT_MISSING`, `OUTPUT_STALE`, `OUTPUT_INVALID`, `OUTPUT_CONFLICT` | see [output files](#output-files) |
| `OUTPUT_NOT_JSON`, `OUTPUT_JSON_INVALID` | a step declared as JSON answered with something else, or with JSON that does not fit; see [JSON output](#json-output) |
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
| `ENTRY.md` (root marker, and text added to every prompt) | `awe.json` marks the root; the shared text is its `"common"` field, which a prompt includes with `{{ common }}` (nothing is added automatically). `ENTRY.md` is no longer used: a leftover one is reported, and a v0.1 folder without `awe.json` is rejected with the migration steps |

The old `executor: { type, argv, timeoutMs }` block in `awe.json` still works and prints a deprecation warning with the
replacement; `"type": "echo"` no longer exists. Old `.awe/runs` and `.awe/dev` folders are neither read nor deleted; `.awe/dev` (the v0.1 cache) is no longer used and is safe
to delete.
