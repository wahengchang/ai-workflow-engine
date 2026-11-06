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
awe run examples/content-generation/ENTRY.md --var topic="Choosing coffee beans"
```

To inspect a run, `cd` into the workflow directory and use the run ID printed by the command:

```sh
awe status <run-id>
awe inspect <run-id> --step 1.2
```

`awe explain examples/content-generation/ENTRY.md --step 3.1.1` shows how a step is located and configured.

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

`ENTRY.md` is rendered with the same placeholder syntax and prepended to **every** step prompt, using that step's available context. Use `{{ input.audience }}`, rather than `{{ audience }}`. `validate`, `plan`, and `run` check template syntax in ENTRY, prompts, and control expressions before execution; they do not yet check reference availability or input declarations.

Input and step-output values are inserted verbatim, including any `{{ ... }}` they contain. To write literal braces in template source, escape the opening delimiter: `\{{first_name}}` renders as `{{first_name}}`, and `$\{{ secrets.X }}` renders as `${{ secrets.X }}`. In JSON strings, write the backslash as `\\`. An unescaped unsupported or unclosed expression is an `INVALID_TEMPLATE` error.

To keep compiled prompts for debugging, set `"storePrompts": true` in `awe.json`. Each step then records a `prompt` path to `artifacts/prompt-<step>-attempt-N.md` in its state. This is off by default: compiled prompts can contain private inputs. Outputs and inputs are already stored in run state/artifacts; protect the whole `.awe` directory accordingly.

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

SIGINT/SIGTERM stop active commands and save the run and active steps as `INTERRUPTED`, with `finishedAt` and a `RUN_INTERRUPTED` error. The CLI exits with 130/143 respectively. On POSIX, interruption and timeout kill the command's process group, including ordinary wrapper descendants; Windows currently kills only the direct child. SIGKILL cannot be trapped. When prompts include customer messages or other untrusted material, explicitly frame that text as data in your instructions.

## CLI reference

| Command | Purpose |
|---|---|
| `awe validate PATH` | Validate file conventions and control groups |
| `awe plan PATH` | Print statically resolved group and step order |
| `awe explain PATH --step 1.2` | Display a step's source and configuration |
| `awe run PATH ...` | Run from `ENTRY.md`, save artifacts and event trace |
| `awe status RUN_ID` | Summarize stored run status |
| `awe inspect RUN_ID --step 1.2` | Inspect step state (without `--step`, full run trace) |

A compatible Skill wrapper is provided at `.agents/skills/awe/SKILL.md`.

## Development

```sh
npm test
npm run check
```

See [architecture](docs/architecture.md) and [implementation plan](docs/plan.md). Key limitations: no crash-time `resume`, no dynamic `goto`, no arbitrary YAML config, no distributed execution, and no guaranteed subjective review quality in v0.1.
