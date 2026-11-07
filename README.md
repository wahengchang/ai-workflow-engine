# AWE — AI Workflow Engine

**Filesystem-first, prompt-first AI workflow interpreter.** Create an `ENTRY.md`, put numbered Markdown prompts in folders, and run them via a CLI named **`awe`**. Designed for content research → planning → writing → review, but the engine does not contain content-specific rules.

> **v0.1 foundation:** Working CLI and deterministic routing. The default `echo` executor is a wiring-only simulator, **not an LLM**. For real content generation, supply a compatible command-line AI agent. This is not yet a durable, production-ready workflow service.

## Quick start

Requires Node.js >=20.

```sh
npm install         # no external runtime dependencies
npm link            # exposes `awe` locally

awe validate examples/content-generation/ENTRY.md
awe plan examples/content-generation/ENTRY.md
awe simulate examples/content-generation/ENTRY.md --var topic="Choosing coffee beans"
```

To inspect a run, `cd` into the workflow directory and use the run ID printed by the command:

```sh
awe status <run-id>
awe inspect <run-id> --step 1.2
awe outputs <run-id>
```

From another directory, add `--workflow path/to/workflow` to `status`, `inspect`, or `outputs`.

`awe explain examples/content-generation/ENTRY.md --step 3.1.1` shows how a step is located and configured.

### Simulation and command execution

`awe simulate PATH` always uses the built-in echo executor, even when `awe.json` configures an external AI command. It accepts `--var name=value` and `--json`; executor options (`--executor`, `--command`, `--arg`) are rejected. No external executor is started, and an AI CLI does not need to be installed or authenticated.

Simulation renders ENTRY and step templates, writes artifacts, and follows the same sequence/IF/LOOP/PARALLEL rules as a run. Its artifacts contain **rendered prompts**, not generated content or reviewer verdicts. An IF depending on an echoed prompt may choose a different branch than a real executor; a LOOP waiting for an AI-generated `PASS` can fail with `LOOP_EXHAUSTED`. Use `plan` to inspect all branches. Simulation does not prove content quality or exercise every possible route.

Both `run` and `status` display an execution label:

```text
Status: COMPLETED
Execution: SIMULATED (echo; no AI calls)
```

New run states store `executionMode: "SIMULATED"` for echo or `"COMMAND"` for an external command. `COMMAND` records how execution happened; it does not certify that a model was called. `awe run PATH --json` and `awe simulate PATH --json` return the stored run state, including this field, as does `awe status RUN_ID --json`.

Compatibility: `awe run` still respects CLI/configured executors and defaults to echo only when none is configured. Explicit `--executor echo` is also labeled `SIMULATED`. Existing status values (`COMPLETED`, `FAILED`, `INTERRUPTED`) and exit codes remain unchanged; execution mode is separate from success/failure. Text `status` infers the mode of older runs from their recorded executor, or shows `UNKNOWN` if it was not recorded, without rewriting their state.

## Workflow convention

```text
my-content-workflow/
├── ENTRY.md                   # entry instructions for the AI
├── awe.json                   # optional inputs and executor config
├── stage-1-research/
│   ├── 1.1-topic-research.md   # default: sequential in numeric order
│   └── 1.2-outline.md
├── stage-2-writing/
│   └── 2.1-draft.md
└── stage-3-review/
    ├── 3.1-checks/
    │   ├── FLOW.json          # { "type": "parallel" }
    │   ├── 3.1.1-facts.md
    │   └── 3.1.2-editorial.md
    └── 3.2-deliver.md
```

All prompt files must use `N.N[-or-.]slug.md` (deeper numbers are supported). Workflow directories must use a numeric prefix or `stage-N-*` name, except named IF branches. Folder order is numeric, not lexical. Plain folders are sequences; special control folders require `FLOW.json`.

### Flow syntax

```json
{ "type": "parallel" }
```

An IF group declares which subdirectories are branches; the matching test is typically the output of a prior user-authored review Prompt:

```json
{
  "type": "if",
  "test": "{{ steps[\"2.2\"].output }}",
  "equals": "PASS",
  "then": "approved",
  "else": "rework"
}
```

A bounded LOOP group owns its internal steps and checks its exit expression after each iteration:

```json
{
  "type": "loop",
  "until": "{{ steps[\"3.1.2\"].output }}",
  "equals": "PASS",
  "maxIterations": 3
}
```

The runtime knows how to route and limit loops. It **never** decides what good writing is; author your own prompts and control conditions. Branch and loop outputs are checked via exact string comparison.

For an LLM gate, use a dedicated verdict prompt: "Your entire reply must be exactly PASS or FAIL." Models may still reply with Markdown or explanations. Opt in to `"match": "first-line"` on an IF or LOOP to compare only the first non-blank line, stripping one surrounding Markdown emphasis or inline-code wrapper (for example, `**PASS**` or `` `PASS` ``). `"caseInsensitive": true` also ignores letter case. The default remains exact comparison after trimming whitespace.

On an IF, `"elseEquals": "FAIL"` makes the gate strict: output matching neither `equals` nor `elseEquals` fails with `IF_NO_MATCH`. Without `elseEquals`, every non-matching output selects the else branch. Use a human-review branch as the fallback when handling untrusted input.

### Variables and artifacts

```md
Research the topic: {{ input.topic }}
Use the prior result: {{ steps["1.1"].output }}
Or reference its file: {{ steps["1.1"].artifact }}
```

`awe.json` provides defaults and `--var key=value` overrides them for one run. Run state and step outputs are stored in `.awe/runs/<run-id>/` (gitignored). No implicit cross-step model memory; state moves through declared values and artifact paths.

`ENTRY.md` is rendered with the same placeholder syntax and prepended to **every** step prompt, using that step's available context. (Behavior change from v0.1: ENTRY.md used to be passed through verbatim, so a literal `{{ ... }}` there must now be escaped as `\{{`.) Template errors name the file (or step, or `FLOW.json` expression) and line. Use `{{ input.audience }}`, rather than `{{ audience }}`. `validate`, `plan`, and `run` check template syntax in ENTRY, prompts, and control expressions before execution; they do not yet check reference availability or input declarations.

Input and step-output values are inserted verbatim, including any `{{ ... }}` they contain. To write literal braces in template source, escape the opening delimiter: `\{{first_name}}` renders as `{{first_name}}`, and `$\{{ secrets.X }}` renders as `${{ secrets.X }}`. In JSON strings, write the backslash as `\\`. An unescaped unsupported or unclosed expression is an `INVALID_TEMPLATE` error.

To keep compiled prompts for debugging, set `"storePrompts": true` in `awe.json`. Each step then records a `prompt` path to `artifacts/prompt-<step>-attempt-N.md` in its state. This is off by default: compiled prompts can contain private inputs. Outputs and inputs are already stored in run state/artifacts; protect the whole `.awe` directory accordingly.

### Named deliverables

Declare final outputs in `awe.json` by mapping a name to its producing prompt step ID:

```json
{
  "version": 1,
  "outputs": { "article": "3.2" }
}
```

For mutually exclusive final steps, use candidate IDs: `"outputs": { "delivery": ["4.1.1", "4.1.2"] }`. Exactly **one** candidate must have completed in the run. An array is not an ordered fallback: no completed candidate fails with `OUTPUT_NOT_FOUND`; multiple completed candidates fail with `OUTPUT_AMBIGUOUS`. Candidates that both ran in different loop iterations are also ambiguous. This maps run deliverables only; it does not provide an IF alias to downstream templates.

`validate`, `plan`, and execution reject invalid output names, duplicate candidates, and IDs that do not identify prompt steps before starting an executor. Names use the same identifier convention as input keys. New runs snapshot the definitions as `outputDefinitions` and publish `outputs` in `state.json` only after the whole workflow succeeds. Each named output records `{ stepId, attempt, artifact }`, using the producing step's latest completed attempt. Configuring outputs is optional and leaves existing workflows unchanged.

```sh
awe outputs <run-id> --workflow ./my-workflow
awe outputs <run-id> --workflow ./my-workflow --json
```

The `run`/`simulate` text summary prints each named output's path; their JSON state contains the same map. `outputs --json` returns `{ runId, status, executionMode, complete, outputDefinitions, outputs, artifacts }`. The `artifacts` list contains one recorded path per step whose latest attempt completed, in numeric step order. Earlier attempt files remain on disk and are traceable through `inspect` events; a failed retry's stale artifact is excluded from this list.

`outputs` reads the saved run without reloading current workflow files, so changing `awe.json` does not change past deliverables. It reports recorded paths without opening or copying the files. Failed, interrupted, and active runs have `complete: false`, no final named outputs, and may expose completed step artifacts as partial results. Echo output stays labeled `SIMULATED`; a named simulated article is still a rendered prompt. Older runs without declarations list completed step artifacts and never guess a final deliverable from the last step. A successful inspection exits 0 even if the inspected run failed; read `status`/`complete` to assess the run.

### Real AI CLI executor

Configure a command that reads its prompt from **stdin** and prints a complete step result to **stdout**. No shell evaluation is performed:

```json
{
  "version": 1,
  "input": { "topic": "coffee" },
  "executor": {
    "type": "command",
    "argv": ["your-ai-cli", "--stdin"],
    "timeoutMs": 120000
  }
}
```

Or override it at invocation time:

```sh
awe run ./my-content-workflow --executor command --command your-ai-cli --arg --stdin --var topic="coffee"
```

`your-ai-cli` is a placeholder; every provider has different arguments and output conventions. Verify the CLI's stdin/stdout behavior before connecting it. Command executors inherit the invoker's permissions and may incur model charges. Never execute an untrusted workflow with a privileged agent.

For an installed and authenticated Claude Code CLI, a concrete configuration is:

```json
{
  "version": 1,
  "executor": {
    "type": "command",
    "argv": ["claude", "-p", "--model", "claude-haiku-5-5"],
    "timeoutMs": 120000
  }
}
```

This model/configuration was reported working in [issue #3](https://github.com/wahengchang/ai-workflow-engine/issues/3); choose a model available to your Claude account. `-p` reads the prompt from stdin and writes the answer to stdout. No live Claude calls are part of the automated tests.

`--command claude --arg -p` implies `--executor command`, including when `awe.json` defaults to echo. An explicit conflicting executor is rejected, and `--arg` requires `--command`. Multiline `--var` values are supported within your OS command-line size limit. Executor argument values are omitted from stored executor metadata; only type and executable are recorded. Supply credentials through the executor's supported authentication mechanism rather than command-line arguments.

SIGINT/SIGTERM/SIGHUP stop active commands and save the run and active steps as `INTERRUPTED`, with `finishedAt` and a `RUN_INTERRUPTED` error. The CLI exits with 130/143/129 respectively (SIGHUP covers a closed terminal or dropped SSH session; executors run in their own process group and would otherwise keep running). On POSIX, interruption and timeout kill the command's process group, including ordinary wrapper descendants; Windows currently kills only the direct child. SIGKILL cannot be trapped. When prompts include customer messages or other untrusted material, explicitly frame that text as data in your instructions.

## CLI reference

| Command | Purpose |
|---|---|
| `awe validate PATH` | Validate file conventions and control groups |
| `awe plan PATH` | Print statically resolved group and step order |
| `awe explain PATH --step 1.2` | Display a step's source and configuration |
| `awe simulate PATH [--var key=value] [--json]` | Use echo only; save rendered prompts and label the run SIMULATED |
| `awe run PATH ... [--json]` | Use the selected/configured executor; save artifacts and event trace |
| `awe outputs RUN_ID [--json] [--workflow DIR]` | Find named deliverables and latest completed step artifact paths |
| `awe status RUN_ID [--workflow DIR]` | Summarize stored run status |
| `awe inspect RUN_ID --step 1.2 [--workflow DIR]` | Inspect step state (without `--step`, full run trace) |

A compatible Skill wrapper is provided at `.agents/skills/awe/SKILL.md`.

## Development

```sh
npm test
npm run check
```

See [architecture](docs/architecture.md) and [implementation plan](docs/plan.md). Key limitations: no crash-time `resume`, no dynamic `goto`, no arbitrary YAML config, no distributed execution, and no guaranteed subjective review quality in v0.1.
