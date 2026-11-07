# AWE distribution maintenance & release policy

This policy defines how to keep the **CLI** and **Agent Skill** usable over time. The CLI is the execution engine; the Skill is an independent instruction package; neither one automatically updates the other. See [Issue #6](https://github.com/wahengchang/ai-workflow-engine/issues/6) and the [roadmap](https://github.com/wahengchang/ai-workflow-engine/issues/5).

## Source of truth

| Surface | Canonical file | Change rule |
| --- | --- | --- |
| CLI invocation contract | `src/cli.js`, `bin/awe.js` | Change tests, README, Skill and installation docs together |
| npm metadata / package boundary | `package.json` | Run pack+offline-install test; update supported Node matrix |
| Agent behavior | `.agents/skills/awe/SKILL.md` | Keep valid Agent Skills frontmatter; verify discoverability |
| Workflow syntax | `src/discover.js`, `src/template.js`, `src/runtime.js` | Version semantics and add regression fixtures |
| Installation and upgrades | `docs/installation.md` | Separate tested, candidate and unpublished routes |
| Long-term distribution policy | `docs/maintenance.md` | Update when versioning, support or release changes |
| User-facing summary | `README.md` | Summarize and link rather than duplicating all procedures |

## Automated PR gate (no publication)

GitHub Actions `.github/workflows/ci.yml` runs on PRs and pushes to main with minimal read-only token permissions:

1. Node 20, 22, 24 on Linux, plus Node 22 on macOS and Windows.
2. `npm run check` for existing unit and regression tests.
3. `npm run test:distribution`: check SKILL metadata, build npm tarball using `npm pack`, reject development/secret files, offline-install the tarball, and smoke-test `awe --help`, `validate`, `plan` from the **installed** package.

No registry credentials, `npm publish`, GitHub Release action, model API key, or paid AI command is used by this CI workflow.

**Coverage boundary:** tarball installation is not identical to remote GitHub installation or npm registry publication; static Skill metadata checks do not prove a successful interactive `npx skills add`. Those need manual release checks.

## Every PR changing distribution must include

- [ ] A precise change summary and supported environment/OS assumptions
- [ ] Tests for any CLI, packaging, Skill frontmatter or versioning behavior changes
- [ ] README, `docs/installation.md` and SKILL.md updated together if CLI commands changed
- [ ] Compatibility notes for existing `ENTRY.md`, `awe.json`, `FLOW.json` and numbered prompts
- [ ] No new credentials, tokens, `.env`, `.awe/runs`, local files, or private content in the package
- [ ] Clear handling for deprecated options and previous installed versions
- [ ] `npm run check` and `npm run test:distribution` green (plus GitHub CI)
- [ ] Changes linked to a GitHub Issue; installation behavior verified before claiming support

## Versioning and support

- Use **SemVer** for the npm CLI package and Git tags. Keep CLI `--help`, `ENTRY.md`, numbered file discovery and control-group schema stable for patch/minor releases.
- When an upgrade breaks syntax or artifact formats, announce migration steps and consider major-version bump.
- Keep `awe` Engine version separate from the `awe` Skill's Git ref; document which versions were tested together.
- Use full commit SHAs or signed/versioned release tags when users need reproducibility; avoid silently pulling latest `main`.
- Recheck current Skills CLI options and Node support at each release rather than treating this document as evergreen third-party behavior.
- Avoid automatic scripts that globally install an AI provider, run model calls, or mutate user workflows during `npm install`.

## Before the first public npm release

**Release is manual and not performed by this PR.** The repository currently has `license: UNLICENSED`; maintainer must explicitly decide and document licensing, npm scope ownership and public distribution rights before publishing.

1. Resolve blocking correctness/safety issues from [#2](https://github.com/wahengchang/ai-workflow-engine/issues/2) and [#3](https://github.com/wahengchang/ai-workflow-engine/issues/3), especially false-success and secret-leak concerns.
2. Verify the version in `package.json` and README; choose prerelease / release version and changelog.
3. Pass CI and run `npm pack --dry-run`; inspect the exact tarball manifest and packed content.
4. Validate a real isolated-machine install from GitHub (pinned SHA) on macOS/Linux and one additional platform as applicable.
5. On a suitable Node version, run `npx skills add wahengchang/ai-workflow-engine --list` and project/global installs for Codex and one other agent. Check Skill loads and `awe --help` fails helpfully when CLI is missing.
6. Confirm npm account/scope permissions and choose controlled npm Trusted Publishing/OIDC or another approved credential process. Do not add broad write credentials to routine CI.
7. Publish with explicit maintainer authorization and correct access level, then verify `npm view @wahengchang/ai-workflow-engine version`, clean `npm install -g`, and one-off `npm exec` from the **published** version.
8. Create matching Git tag and release notes only after the version and install channel are verified; add uninstall, upgrade, migration and known limitations.
9. Re-test Skill install against the tagged source and record the verified Agent/OS/Node combinations in release notes.

## Rollback and incidents

- **Failed package before publication:** stop release; revert/fix PR, re-run tests, do not publish.
- **Published version broken:** do not overwrite npm package contents or claim mutable version changes. Ship a fixed patch release; deprecate a bad release where appropriate; document `npm install -g @wahengchang/ai-workflow-engine@<known-good-version>`.
- **Skill install broken:** pin the previously working Git ref; update the Skill docs and installation checks. Skill removal should not remove CLI.
- **Security issue:** audit `npm pack` file list and CI logs; rotate any accidentally exposed credentials and follow disclosure process. Never put tokens in troubleshooting instructions.
- **Compatibility issue:** add the failing case to `test/` and distribution smoke checks before releasing the fix.

## Manual compatibility matrix template

| Date | AWE version/tag | Node / npm | OS | Install route | Skill/agent | Result / issue |
| --- | --- | --- | --- | --- | --- | --- |
| TBD | TBD | TBD | Linux | source + npm link | CLI only | pending |
| TBD | TBD | TBD | macOS | pinned GitHub install | CLI only | pending |
| TBD | TBD | >=22.20 for current Skills CLI | macOS/Linux | Skills CLI | Codex + another agent | pending |
| TBD | Published version only | TBD | Clean machine | npm registry + npm exec | CLI only | pending |

The matrix intentionally contains **pending** entries until a maintainer actually verifies each route. Do not replace them with guessed success.
