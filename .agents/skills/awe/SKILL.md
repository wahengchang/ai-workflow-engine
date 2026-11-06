---
name: awe
summary: Operate the AI Workflow Engine CLI to validate, plan, run and inspect filesystem-defined workflows.
---

# AWE CLI skill

Use `awe` to run a workflow beginning at `ENTRY.md`. Do not interpret numbered prompts yourself when AWE is installed: the engine is the authority for flow order, IF/LOOP/PARALLEL routing and outputs.

1. `awe validate path/to/ENTRY.md` to check conventions.
2. `awe plan path/to/ENTRY.md` to inspect the execution layout.
3. `awe run path/to/ENTRY.md --var topic="..."` to execute. Default `echo` mode only tests wiring.
4. Use `--executor command --command <AI_CLI> --arg <ARG>` only when explicitly configured and permitted by the user.
5. `awe status <run-id>` and `awe inspect <run-id> --step 1.2` are run from the workflow root.

AWE cannot guarantee content quality, perform arbitrary external publication, or resume a mid-run crash in v0.1. Never claim otherwise.
