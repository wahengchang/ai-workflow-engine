---
name: awe
description: Run, check, preview and inspect filesystem-defined AI workflows with the AWE CLI. Use when the user provides a workflow folder (an awe.json with numbered Markdown prompt steps), or asks to automate a research, writing, review or similar pipeline.
compatibility: Requires the separately installed awe CLI and Node.js 20 or newer. Optional real AI command executor must be configured by the user.
---

# AWE Workflow CLI

AWE is the executable workflow interpreter; this Skill is **instructions only** and does not install AWE or any AI model.

## Before using AWE

1. Check whether `awe` is available (`awe --help`). If missing, stop and explain the CLI installation options in the [installation guide](https://github.com/wahengchang/ai-workflow-engine/blob/main/docs/installation.md). Do not assume adding this Skill installs the CLI.
2. Locate the user's workflow folder (it contains `awe.json`) and confirm it is trusted. Run `awe check` first: it validates the workflow, lists the steps and tells you whether the configured AI command exists.
3. A real run needs a user-configured AI command in `awe.json` (`"run": "claude -p {prompt}"`). Without one, `awe run` stops with examples. External commands inherit the user's machine permissions and may incur costs: tell the user before running.

## Commands

- `awe init <dir>` — create a six-step content workflow; writes the first AI CLI found on PATH into `awe.json`. Refuses existing destinations.
- `awe check [dir]` — validate, print the plan, check that each executor exists (a missing one is reported as `NOT READY`; `--json` has `ready`). Exit 2 = the workflow is invalid.
- `awe run --dry [step]` — print the rendered prompts; calls nothing, writes nothing. Use it to review wiring before spending money. It says nothing about what a model would answer.
- `awe run [dir] [step]` — run the workflow. **Naming a step** (`awe run 1.2`) runs only that step: earlier steps come from the cache (and run first if missing), later steps are untouched. A whole run (`awe run`) starts from the first step and ignores the cache unless `--cache` is given; `--no-cache` forces everything to rerun. The output states which mode ran and which steps were `cached` or `ran`.
- `awe run … --var key=value`, `--executor <name>`, `--timeout <seconds>`, `--json` — override an input, use a named executor from `awe.json`, set a per-step time limit, get machine-readable state. Exit codes: 0 ok, 1 a step failed, 2 usage/configuration problem, 129/130/143 interrupted.
- `awe show [dir] [step]` — latest run summary; `awe show 1.2` prints a step's output, `--prompt` the prompt that was sent, `--err` its last stderr lines. Works from any sub-folder of the workflow.
- `"common"` in `awe.json` (a string, or an array of lines) is reusable text that is **not** added automatically: a prompt includes it by writing `{{ common }}` where it wants it, and a step sends exactly its own prompt file, rendered, with no headers. `common` may use `{{ input.* }}` but not step outputs. Each step is its own AI call, so every step that writes `{{ common }}` pays for it; editing it reruns exactly those steps. If several prompts need the same text, put it in `common`; if one does, write it in that prompt; if it changes between runs, use `input`. When adding `common`, also add `{{ common }}` to the prompts that need it (`awe check` says which steps use it, and warns when none does). A step that reruns although the cache is on says why in brackets, e.g. `(the common text changed)`. There is no `ENTRY.md` or `COMMON.md` file any more: a leftover `ENTRY.md` is not used (awe warns), so offer to move its text into `"common"` and add `{{ common }}` to the prompts, then delete it. The command a step runs gets `AWE_STEP`, `AWE_ADDRESS` and `AWE_RUN_ID` in its environment.
- Advice for building a workflow: run steps one at a time (`awe run 1.1`, read it with `awe show 1.1`, edit, rerun, then `awe run 1.2`), and finish with a whole `awe run`.
- If AWE reports `UNKNOWN_EFFECT`, an earlier command was interrupted (Ctrl-C, timeout, crash): tell the user what it may have affected and only run the same command again with `--retry <step>` after they agree.
- Steps may declare named output files (PDF, images) in `awe.json` under `steps.<id>.outputs`; later prompts reference the saved copy as `{{ steps["1.1"].files["name"] }}`. Steps may also set `executor` and `timeout` there. See `docs/cli.md`.

AWE owns step order, routing, outputs, attempt artifacts and trace. Do **not** interpret `FLOW.json` or reroute steps yourself when AWE is installed. Do not claim a dry run produced content. Do not promise crash-time resume or exactly-once command execution, publication, subjective quality guarantees, or auto-installation of AI dependencies. The v0.1 commands `simulate`, `dev`, `validate`, `plan`, `status`, `inspect` and `explain` no longer exist; each reports its replacement.

## JSON step output

When later steps need fields from an answer, declare `steps.<id>.json` in `awe.json`. `true` accepts any JSON; a schema
checks its shape before the step succeeds. For three role assignments, merge this into the existing configuration:

```json
{
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

1. Tell the producing prompt: "Reply with only the JSON, no code fence, no explanation." The whole stdout must be JSON.
2. Declare the types and required fields consumers need. Supported keywords are `type`, `minItems`, `maxItems`, `items`,
   `required`, `properties`, `enum`; unsupported keywords are configuration errors. `required` checks presence; `properties`
   checks a present field's shape. Include `type` at each level where shape matters. Extra fields are allowed.
3. Read values with `{{ steps["1.1"].json[0].role }}`. Paths support `.key`, `[0]`, `["key"]`, with no expressions or calls.
   Strings are inserted as is, numbers and booleans as text, `null` as `null`, and arrays/objects as compact JSON. Missing
   fields, wrong shapes and out-of-range indexes are errors. Use fixed indexes for the branches declared in `FLOW.json`;
   JSON arrays do not create branches automatically.
4. Run `awe check`, then `awe run --dry` to inspect the wiring. These check reference syntax and upstream declarations;
   they cannot prove that a future model answer will have the expected fields.
5. On `OUTPUT_NOT_JSON` or `OUTPUT_JSON_INVALID`, inspect `awe show <step>` for the rejected raw answer and
   `awe show <step> --json` for its error and `rejectedArtifact` path. For loops use the occurrence, e.g. `1.1.1@2`.
   Fix the prompt or declaration, rerun `awe run <step>` without `--retry`, then use `awe run --cache` to continue.
   Downstream steps and the join do not run after a rejection; already-started parallel siblings finish independently.
   A rejection does not roll back command effects. Changing a JSON declaration invalidates that step and its dependents;
   upgrading from a pre-JSON build reruns cached steps once (`awe was upgraded`).

See [JSON output](https://github.com/wahengchang/ai-workflow-engine/blob/main/docs/cli.md#json-output) for the full contract.

## Maintenance

CLI distribution and Skill distribution have independent installation/update lifecycles. Follow [installation](https://github.com/wahengchang/ai-workflow-engine/blob/main/docs/installation.md) and [maintenance](https://github.com/wahengchang/ai-workflow-engine/blob/main/docs/maintenance.md) guidance. When modifying AWE CLI commands, update this Skill in the same PR.
