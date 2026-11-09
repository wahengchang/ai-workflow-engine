---
name: awe
description: Run, plan, validate, explain and inspect filesystem-defined AI workflows with the AWE CLI. Use when the user provides an ENTRY.md, numbered Markdown prompt steps, or asks to automate a research, writing, review or similar pipeline.
compatibility: Requires the separately installed awe CLI and Node.js 20 or newer. Optional real AI command executor must be configured by the user.
---

# AWE Workflow CLI

AWE is the executable workflow interpreter; this Skill is **instructions only** and does not install AWE or any AI model.

## Before using AWE

1. Check whether `awe` is available (`awe --help`). If missing, stop and explain the CLI installation options in the [installation guide](https://github.com/wahengchang/ai-workflow-engine/blob/main/docs/installation.md). Do not assume adding this Skill installs the CLI.
2. Locate the user's workflow `ENTRY.md` and confirm it is trusted. Use `awe validate <path>` then `awe plan <path>` before execution.
3. Warn that a workflow with the default `echo` executor only echoes assembled prompts. **A successful echo run is not an AI-generated result.** A real run requires a user-configured, authenticated AI CLI/command executor. External commands inherit the user's machine permissions and may incur costs.

## Workflow commands (currently supported)

- `awe init --template content --out <new-directory>` — create a six-step content workflow using echo; refuses existing destinations.
- `awe simulate path/to/ENTRY.md` — test wiring with echo, regardless of configured real executor; no AI calls.
- `awe validate path/to/ENTRY.md` — check file conventions, control groups and guaranteed availability of step references before execution.
- `awe plan path/to/ENTRY.md` — inspect numeric step ordering and IF/LOOP/PARALLEL groups.
- `awe explain path/to/ENTRY.md --step 1.2` — inspect the selected step's source and config.
- `awe run path/to/ENTRY.md --var topic="..."` — run with the configured executor; default is echo.
- `awe run path/to/ENTRY.md --executor command --command <approved-agent-cli> --arg <argument>` — invoke a separately installed command-line AI executor. Verify its stdin/stdout contract before running it.
- `awe dev path/to/ENTRY.md --step 1.50` — iterate on one step of a long workflow: reuse valid earlier dev results, run missing/stale prerequisites, execute that step, stop. `awe dev path/to/ENTRY.md` finishes the workflow from the cache. Dev results are separate from `awe run`; `--fresh` starts over. If AWE reports `UNKNOWN_EFFECT`, an earlier command was interrupted: tell the user what may have been affected and only rerun with `--acknowledge <address>` after they agree. See `docs/dev-mode.md`.
- Steps may declare named output files (PDF, images) in `awe.json` under `steps.<id>.outputs`; later prompts reference the saved copy as `{{ steps["1.1"].files["name"] }}`.
- From the workflow directory: `awe status <run-id>` and `awe inspect <run-id> --step 1.2`.

AWE owns step order, routing, outputs, attempt artifacts and trace. Do **not** interpret `FLOW.json` or reroute steps yourself when AWE is installed. Do not claim a completed simulation produced content. Do not promise crash-time resume or exactly-once command execution, publication, subjective quality guarantees, or auto-installation of AI dependencies.

## Maintenance

CLI distribution and Skill distribution have independent installation/update lifecycles. Follow [installation](https://github.com/wahengchang/ai-workflow-engine/blob/main/docs/installation.md) and [maintenance](https://github.com/wahengchang/ai-workflow-engine/blob/main/docs/maintenance.md) guidance. When modifying AWE CLI commands, update this Skill in the same PR.
