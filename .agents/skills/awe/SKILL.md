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
- `awe check [dir]` — validate, print the plan, check that each executor exists (a missing one is reported as `NOT READY`; `--json` has `ready`). Exit 2 = the workflow is invalid; **exit 0 means the workflow is valid, not that it can run** — read `NOT READY` or `--json`'s `ready` before spending anything.
- `awe run --dry [step]` — print the rendered prompts; calls nothing, writes nothing. Use it to review wiring before spending money. It says nothing about what a model would answer.
- `awe run [dir] [step]` — run the workflow. **Naming a step** (`awe run 1.2`) runs only that step: earlier steps come from the cache (and run first if missing), later steps are untouched. A whole run (`awe run`) starts from the first step and ignores the cache unless `--cache` is given; `--no-cache` forces everything to rerun. The output states which mode ran and which steps were `cached` or `ran`. A step inside a LOOP is addressed as `2.1.1@2` (iteration 2); without `@`, awe uses the only occurrence it has seen or lists them.
- `awe run … --var key=value`, `--executor <name>`, `--timeout <seconds>`, `--retry <step>`, `--json` — override an input, use a named executor from `awe.json`, set a per-step time limit, acknowledge an unknown outcome, get machine-readable state. Exit codes: 0 ok, 1 a step failed, 2 usage/configuration problem, 129/130/143 interrupted. `awe --version` prints the CLI version; the `"version": 2` inside `--json` is the workflow schema version.
- `awe show [dir] [step]` — latest run summary; `awe show 1.2` prints a step's output, `--prompt` the prompt that was sent, `--err` its last stderr lines, `--run <id>` an earlier run. Works from any sub-folder of the workflow.
- `"common"` in `awe.json` (a string, or an array of lines) is text shared by **every** step: it is added to every step's prompt (each step is its own AI call, so it is paid for each time), may use `{{ input.* }}` but not step outputs, and editing it reruns every step. Put what is true for all steps there, what is true for one step in that step's prompt, and what changes between runs in `input`. Do not use it as a README. A step that reruns although the cache is on says why in brackets, e.g. `(the common text changed)`. There is no `ENTRY.md` or `COMMON.md` file any more: a leftover `ENTRY.md` is not used (awe warns), so offer to move its text into `"common"` and delete it.
- Advice for building a workflow: run steps one at a time (`awe run 1.1`, read it with `awe show 1.1`, edit, rerun, then `awe run 1.2`), and finish with a whole `awe run`.
- If AWE reports `UNKNOWN_EFFECT`, an earlier command was interrupted (Ctrl-C, timeout, crash): tell the user what it may have affected and only run the same command again with `--retry <step>` after they agree.
- Steps may declare named output files (PDF, images) in `awe.json` under `steps.<id>.outputs`; later prompts reference the saved copy as `{{ steps["1.1"].files["name"] }}`. Steps may also set `executor` and `timeout` there. See `docs/cli.md`.

AWE owns step order, routing, outputs, attempt artifacts and trace. Do **not** interpret `FLOW.json` or reroute steps yourself when AWE is installed. Do not claim a dry run produced content. Do not promise crash-time resume or exactly-once command execution, publication, subjective quality guarantees, or auto-installation of AI dependencies. The v0.1 commands `simulate`, `dev`, `validate`, `plan`, `status`, `inspect` and `explain` no longer exist; each reports its replacement.

## Maintenance

CLI distribution and Skill distribution have independent installation/update lifecycles. Follow [installation](https://github.com/wahengchang/ai-workflow-engine/blob/main/docs/installation.md) and [maintenance](https://github.com/wahengchang/ai-workflow-engine/blob/main/docs/maintenance.md) guidance. When modifying AWE CLI commands, update this Skill in the same PR.
