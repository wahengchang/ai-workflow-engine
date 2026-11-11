# AWE implementation plan

## Goal

Build a reusable, filesystem-first AI workflow interpreter accessed via a CLI named `awe`. A workflow author supplies an `ENTRY.md` and numbered Markdown steps; the engine performs deterministic routing and saves every artifact and event.

## Milestone 0 — Executable foundation (first repository delivery)

- [x] Node.js ESM package exposing `awe` executable without runtime dependencies
- [x] `ENTRY.md` loader and numeric folder / prompt resolver
- [x] `sequence`, `parallel`, `if` and bounded `loop` groups (`FLOW.json`)
- [x] Strict prompt variables for inputs and step outputs / artifact paths
- [x] `echo` smoke executor and arbitrary command-argv executor with stdin/stdout transport *(v0.2: echo removed; the executor is a command string, see below)*
- [x] State, events and artifacts persisted per run
- [x] CLI `validate`, `plan`, `explain`, `run`, `status`, `inspect` *(v0.2: replaced by `init`, `run`, `show`, `check`)*
- [x] AI content generation reference workflow and CLI Skill instructions
- [x] Node built-in test suite for routing and failure behavior

## Milestone 0.2 — CLI redesign ([RFC 0002](rfc-0002-cli-redesign.md))

- [x] Four commands: `init`, `run [step]`, `show`, `check`; removed commands report their replacement
- [x] One execution path with a single cache switch (`--cache` / `--no-cache`), stated on every run
- [x] Executor as one command string in `awe.json` (`{prompt}`, `{prompt_file}`, stdin; long prompts become a file path; no shell)
- [x] Named executors, per-step `executor` and `timeout`, `--executor`, `--timeout`
- [x] No echo executor: `awe run --dry` previews prompts, a run without a command fails with examples
- [x] Actionable errors: valid values listed, stderr tail kept, next-command hints, exit code 2 for usage
- [x] Legacy `executor` block read with a deprecation warning
- [ ] Verified on the macOS and Windows CI matrix and against real Claude/Codex/OpenCode/omp installs

## Milestone 1 — Operational reliability

- [ ] Resume/pause and crash recovery with checkpoint-safe re-entry
- [x] Per-step timeout (v0.2)
- [ ] Retry policy, run-wide budgets, cancellation
- [ ] Structured artifact / result contracts, JSON schema validation
- [ ] Snapshot resolved plan, source file hashes, inputs and runtime environment
- [ ] Better failure isolation and testing of concurrent branches
- [ ] Production-tested adapters for Codex, Claude Code and OpenCode

## Milestone 2 — Cross-project reuse

- [ ] Versioned workflow/component packages and reproducible lockfile
- [ ] Customization and override layering without copying templates
- [ ] Optional YAML authoring, strict schema and validation
- [ ] Explicit script/tool step contracts and controlled permissions
- [ ] Regression/evaluation tests for prompt quality across sample projects

## Explicit non-goals for the first commit

No dashboard, arbitrary LLM-written code execution, n8n replacement, distributed worker service, automatic content-quality guarantee, unrestricted dynamic jumps or publishing connectors. Prioritize predictable runtime semantics before expanding flexibility.
