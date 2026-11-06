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

All prompt files must use `N.N[-or-.]slug.md` (deeper numbers are supported). `stage-N-*` directories organize work. Folder order is numeric, not lexical. Plain folders are sequences; special control folders require `FLOW.json`.

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

### Variables and artifacts

```md
Research the topic: {{ input.topic }}
Use the prior result: {{ steps["1.1"].output }}
Or reference its file: {{ steps["1.1"].artifact }}
```

`awe.json` provides defaults and `--var key=value` overrides them for one run. Run state and step outputs are stored in `.awe/runs/<run-id>/` (gitignored). No implicit cross-step model memory; state moves through declared values and artifact paths.

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
