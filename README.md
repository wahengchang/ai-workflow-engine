# AWE — AI Workflow Engine

**Filesystem-first, prompt-first AI workflow interpreter.** Create an `ENTRY.md`, put numbered Markdown prompts in folders, and run them via a CLI named **`awe`**. Designed for content research → planning → writing → review, but the engine does not contain content-specific rules.

> **v0.2:** a four-command CLI (`init`, `run`, `show`, `check`) over a deterministic workflow engine. AWE never pretends to
> have called an AI: without a configured command, `awe run` stops and tells you how to set one; `awe run --dry` previews
> the prompts. This is not yet a durable, production-ready workflow service.

## Installation: CLI vs Agent Skill

**Engine installation and Skill installation are two separate actions.** The CLI executes workflows; the Skill only teaches compatible AI agents to call that already-installed CLI. AWE requires Node.js 20+; the independently maintained Skills CLI has its own Node requirements.

| Route | Use case | Current status |
| --- | --- | --- |
| Clone + `npm link` | Local development and testing | Documented v0.1 path |
| `npm install -g github:wahengchang/ai-workflow-engine` | Install CLI from GitHub source | npm-supported mechanism; clean-machine verification pending |
| `npm install -g @wahengchang/ai-workflow-engine` | Published registry CLI | **Future target; publication not confirmed** |
| `npx skills add wahengchang/ai-workflow-engine --skill awe` | Optional Agent Skill | Instructions only; verify remote discovery/install |

See the detailed [installation, update and uninstall guide](docs/installation.md) and [long-term maintenance/release policy](docs/maintenance.md). Run `npm run test:distribution` to test isolated local/global tarball installs, source linking and offline one-off `npm exec` with a local tarball. It checks help, validation and planning without downloading an AI model or touching your global CLI prefix. Remote GitHub/registry and interactive Agent Skill installation remain separate release checks.

## Quick start

Requires Node.js >=20. Clone this repository and enter it first, unless it is already checked out.

```sh
git clone https://github.com/wahengchang/ai-workflow-engine.git
cd ai-workflow-engine
npm install         # no external runtime dependencies
npm link            # exposes `awe` locally

awe init coffee     # creates the workflow; writes the first AI CLI found on PATH into awe.json
cd coffee
awe run --dry       # preview every prompt; calls nothing
awe run 1.1         # run step 1.1, then look at it:  awe show 1.1
awe run 1.2         # 1.1 comes from the cache, only 1.2 runs
awe run             # the whole workflow, from the start
```

The AI command is one line in `awe.json`:

```json
{ "version": 2, "run": "claude -p {prompt}", "timeout": 300 }
```

`{prompt}` is the rendered prompt (a very long one becomes a file path automatically), `{prompt_file}` is the path of the
saved prompt, and a command with neither receives the prompt on stdin. Different steps can use different commands and
time limits. Every `awe run` states whether it used the cache, and what it ran or reused.

Everything about the commands, the cache rules, per-step executors, output files and crash recovery is in
[docs/cli.md](docs/cli.md).

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
Or a declared output file: {{ steps["1.1"].files["report"] }}
```

`awe.json` provides defaults and `--var key=value` overrides them for one run. Run state and step outputs are stored in `.awe/runs/<run-id>/` (gitignored), and valid results are cached in `.awe/cache/`. No implicit cross-step model memory; state moves through declared values and artifact paths.

`ENTRY.md` is rendered with the same placeholder syntax and prepended to **every** step prompt, using that step's available context. (Behavior change from v0.1: ENTRY.md used to be passed through verbatim, so a literal `{{ ... }}` there must now be escaped as `\{{`.) Template errors name the file (or step, or `FLOW.json` expression) and line. Use `{{ input.audience }}`, rather than `{{ audience }}`. `check`, `run` and `run --dry` check template syntax in ENTRY, prompts, and control expressions before execution; they also reject unknown/forward step references, references between parallel siblings before their join, and branch-only outputs used after an IF. Checks conservatively cover every branch and the first loop iteration; even a currently fixed input gate does not make a branch-only output unconditional. LOOP exit expressions can read body results. Input declarations/required values are not statically checked because `--var` can supply them later. Previously these structural mistakes failed during execution; CLI commands now fail before creating a run or calling an executor. Direct `runWorkflow` library callers retain runtime checks.

Input and step-output values are inserted verbatim, including any `{{ ... }}` they contain. To write literal braces in template source, escape the opening delimiter: `\{{first_name}}` renders as `{{first_name}}`, and `$\{{ secrets.X }}` renders as `${{ secrets.X }}`. In JSON strings, write the backslash as `\\`. An unescaped unsupported or unclosed expression is an `INVALID_TEMPLATE` error.

Rendered prompts are saved next to each step's output (`awe show 1.2 --prompt`). Set `"storePrompts": false` in `awe.json` to keep them only for the moment a command needs them: prompts can contain private inputs. Outputs and inputs are stored in run state/artifacts either way; protect the whole `.awe` directory.

### Connecting an AI CLI

```json
{ "version": 2, "run": "claude -p {prompt}" }
```

The command is split into arguments and started directly: **no shell evaluation is performed**. It must print a complete step result to **stdout**. Common choices: `claude -p {prompt}`, `codex exec {prompt}`, `opencode run {prompt}`, `omp -p` (prompt on stdin). Every provider has different arguments and output conventions: verify the CLI's behaviour before connecting it. Commands inherit the invoker's permissions and may incur model charges. Never execute an untrusted workflow with a privileged agent. No live AI calls are part of the automated tests.

Run output and errors show the executable and plain flags only; other arguments appear as `…`. Executor errors redact exact argument strings and `--option=value` payloads before truncating stderr, so provider diagnostics cannot copy those values into the CLI or saved errors/events. This is exact-value redaction, not a general secret scanner: transformed credentials, environment-only secrets, inputs, successful outputs and saved prompts may still contain sensitive data. Supply credentials through the tool's own authentication mechanism or the environment rather than command-line arguments.

SIGINT/SIGTERM/SIGHUP stop active commands and save the run and active steps as `INTERRUPTED`, with `finishedAt` and a `RUN_INTERRUPTED` error. The CLI exits with 130/143/129 respectively (SIGHUP covers a closed terminal or dropped SSH session; executors run in their own process group and would otherwise keep running). On POSIX, interruption and timeout kill the command's process group, including ordinary wrapper descendants; Windows currently kills only the direct child. SIGKILL cannot be trapped. When prompts include customer messages or other untrusted material, explicitly frame that text as data in your instructions.

## CLI reference

| Command | Purpose |
|---|---|
| `awe init DIR` | Create a content workflow in a new folder and configure the AI CLI found on PATH |
| `awe run [DIR] [STEP]` | Run the workflow, or one step (earlier steps come from the cache). Flags: `--var`, `--cache`/`--no-cache`, `--dry`, `--executor`, `--timeout`, `--retry`, `--json` |
| `awe show [DIR] [STEP]` | Latest run summary; a step's output (`--prompt`, `--err` for its prompt or stderr) |
| `awe check [DIR]` | Validate the workflow, print the plan, check that executors exist |

Exit codes: 0 ok, 1 a step failed, 2 usage/configuration problem, 129/130/143 interrupted. Upgrading from v0.1 (`simulate`, `dev`, `validate`, `plan`, `status`, `inspect`, `explain`, `--executor command --command`): see the [mapping](docs/cli.md#upgrading-from-v01).

A compatible Skill wrapper is provided at `.agents/skills/awe/SKILL.md`.

## Development

```sh
npm test
npm run check
npm run test:distribution
```

See the [CLI guide](docs/cli.md), [architecture](docs/architecture.md) and [implementation plan](docs/plan.md). Key limitations: no automatic crash-time `resume` (an interrupted command is retried explicitly with `--retry`, never exactly-once), no dynamic `goto`, no arbitrary YAML config, no distributed execution, and no guaranteed subjective review quality in v0.1.
