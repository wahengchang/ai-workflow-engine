# AWE implementation plan

## Goal

Build a reusable, filesystem-first AI workflow interpreter accessed via a CLI named `awe`. A workflow author supplies an `ENTRY.md` and numbered Markdown steps; the engine performs deterministic routing and saves every artifact and event.

## Milestone 0 — Executable foundation (first repository delivery)

- [x] Node.js ESM package exposing `awe` executable without runtime dependencies
- [x] `ENTRY.md` loader and numeric folder / prompt resolver
- [x] `sequence`, `parallel`, `if` and bounded `loop` groups (`FLOW.json`)
- [x] Strict prompt variables for inputs and step outputs / artifact paths
- [x] `echo` smoke executor and arbitrary command-argv executor with stdin/stdout transport
- [x] State, events and artifacts persisted per run
- [x] CLI `validate`, `plan`, `explain`, `run`, `status`, `inspect`
- [x] AI content generation reference workflow and CLI Skill instructions
- [x] Node built-in test suite for routing and failure behavior

## Milestone 1 — Operational reliability

- [ ] Resume/pause and crash recovery with checkpoint-safe re-entry
- [ ] Step-level timeout/retry policy, run-wide budgets, cancellation
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
