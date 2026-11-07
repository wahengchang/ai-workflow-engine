# Install AWE: CLI Engine + optional Agent Skill

**Status:** AWE is currently a v0.1 foundation, not a published production release. This document separates **verified source behavior**, **candidate install routes**, and **future publishing commands**. A workflow using the default `echo` executor does **not** invoke an LLM.

## Which installation do I need?

| I want to... | Install | Meaning |
| --- | --- | --- |
| Run an AWE workflow from a terminal | **AWE CLI** using npm, or clone + `npm link` | Provides the actual `awe` command |
| Tell Codex / Claude Code / OpenCode how to operate AWE | **Agent Skill** using `npx skills add` | Installs instructions; **does not** install the CLI |
| Run a single command without a global CLI | `npm exec` / `npx` | Planned once a registry release is verified |
| Create a new content workflow | `awe init` | Available from source; creates a new directory with the content template |

## Prerequisites

AWE CLI requires **Node.js 20+** and npm. Check with `node --version` and `npm --version`. A real AI run also requires a **separately installed and authenticated** command-line AI executor whose stdin/stdout behavior AWE supports.

The independently maintained Skills CLI has its **own Node requirement** (its docs currently specify Node **22.20+**). Installing the Skill is optional; using AWE alone does not require Skills CLI. Verify current requirements before upgrading environments.

## 1. Local source installation (supported development path)

```sh
git clone https://github.com/wahengchang/ai-workflow-engine.git
cd ai-workflow-engine
npm install --ignore-scripts
npm run check
npm run test:distribution
npm link

awe --help
awe validate examples/content-generation/ENTRY.md
awe plan examples/content-generation/ENTRY.md
```

`npm install` in the repository does **not** create the global `awe` command on its own; `npm link` links that checkout into your PATH. To unlink later, run `npm unlink -g @wahengchang/ai-workflow-engine` (or `npm uninstall -g @wahengchang/ai-workflow-engine` as appropriate).

## 2. Global installation from GitHub (candidate; clean-machine check required)

npm supports installing a package directly from GitHub:

```sh
npm install -g github:wahengchang/ai-workflow-engine
awe --help
```

Prefer a pinned Git tag or **full commit SHA** for automation:

```sh
npm install -g 'github:wahengchang/ai-workflow-engine#<full-commit-sha>'
```

This route relies on your npm/Git environment. The repository's CI includes a local tarball install smoke test, but does **not** prove that a remote GitHub install works on every end-user machine. Treat this as a supported npm mechanism pending the explicit release checklist.

## 3. Official npm registry install (future; not confirmed published)

The intended package name is `@wahengchang/ai-workflow-engine`. Do **not** use the following as proof the package is live until a maintainer has published and verified it:

```sh
npm install -g @wahengchang/ai-workflow-engine
awe --help

# After a registry release is verified, one-off alternative:
npm exec --package=@wahengchang/ai-workflow-engine -- awe --help
```

The GitHub repository being public does not automatically publish this npm package.

## 4. Optional Agent Skill installation (separate from Engine)

The repository includes `.agents/skills/awe/SKILL.md`. The Skills CLI supports GitHub sources, skill discovery, project/local scope and global scope.

```sh
# Discover from GitHub without installing
npx skills add wahengchang/ai-workflow-engine --list

# Project-local skill, in the current project
npx skills add wahengchang/ai-workflow-engine --skill awe --agent codex

# Cross-project user-level skill
npx skills add wahengchang/ai-workflow-engine --skill awe --agent codex --global

# Choose an alternative agent (installed separately)
npx skills add wahengchang/ai-workflow-engine --skill awe --agent claude-code
npx skills add wahengchang/ai-workflow-engine --skill awe --agent opencode

# Inspect installed skills
npx skills list
```

Use a **pinned Git ref** when reproducibility matters, for example `wahengchang/ai-workflow-engine@v0.2.0` **after that tag exists**. These Skills CLI commands reflect its documented interface; actual remote discovery/install in Codex, Claude Code and OpenCode must pass the release verification matrix. This PR statically tests Skill metadata but does not install those agents.

**Important:** after installing a Skill, `awe --help` must still work. If it does not, install the CLI separately. Installing/removing the Skill is independent of CLI installation/removal.

## 5. First workflow test (safe; no paid AI calls)

```sh
awe init --template content --out my-workflow
awe validate my-workflow/ENTRY.md
awe plan my-workflow/ENTRY.md
awe simulate my-workflow/ENTRY.md --var topic="Choosing coffee beans"
```

The default executor is `echo`; the run's `COMPLETED` status means **the wiring ran**, **not** that AI generated an article. To run real AI, explicitly configure an approved command executor in `awe.json` or on the CLI, such as `--executor command --command <agent-binary> --arg <arg>`. See [README](../README.md) for the stdin/stdout contract and warnings about costs and permissions.

## 6. Upgrade and uninstall

- **Clone + npm link:** `git pull`, `npm run check`, `npm run test:distribution`; relink only if the executable path changes. Prefer checking out a release tag.
- **GitHub npm install:** reinstall using an explicit newer tag/commit; do not rely on moving `main` for production.
- **Future npm registry:** use an explicit version, e.g. `npm install -g @wahengchang/ai-workflow-engine@<version>` after publication. Track CLI behavior and migration notes.
- **Skills CLI:** use `npx skills update awe` (or reinstall with pinned ref) and confirm `npx skills list`; update the Skill **separately** from the Engine.
- **Uninstall Engine:** `npm uninstall -g @wahengchang/ai-workflow-engine`.
- **Remove Skill:** `npx skills remove awe` (use `--global` if installed globally).

If an old global `awe` shadows a local install, inspect `command -v awe` on macOS/Linux or `where awe` on Windows, and `npm list -g --depth=0`.

## 7. Troubleshooting and safety

| Symptom | Check |
| --- | --- |
| `awe: command not found` | Install/link the CLI; verify PATH, Node/npm location |
| `npx skills` does not start | Check its current Node requirement; this is **not** an AWE runtime failure |
| Skill installed but `awe` absent | Expected: Skill only installs instructions; install CLI separately |
| `COMPLETED` but output contains prompts | Default `echo` executor; configure a real AI CLI |
| Agent command not found / authentication error | Install/authenticate that external agent and verify it reads stdin |
| `npm pack` includes unexpected files | Run `npm run test:distribution`; review `package.json#files` before release |
| Canceled/failed run | Inspect `.awe/runs/<id>/state.json`; v0.1 cannot resume automatically |

Only run trusted workflows and external commands: AWE does **not** sandbox an agent and the command executor inherits your operating-system permissions. Keep `.awe/runs` private because artifacts and inputs may contain sensitive content. Do not put API keys in command-line arguments.

## Official references

- [npm package installation and package metadata](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)
- [npm pack](https://docs.npmjs.com/cli/v11/commands/npm-pack/)
- [Agent Skills specification](https://agentskills.io/specification)
- [Skills CLI command reference](https://github.com/vercel-labs/skills/blob/main/docs/commands.md)

See [maintenance and release policy](maintenance.md) for ongoing CI, versioning, manual compatibility tests and release gating.
