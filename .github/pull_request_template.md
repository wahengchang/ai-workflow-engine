## Summary

What changed and why? Link related Issue(s), e.g. Fixes #6.

## Scope and compatibility

- CLI / Workflow grammar / npm packaging / Agent Skill / Docs (select applicable)
- User-visible behavior and backward-compatibility notes:
- AWE Version / affected Node/OS / external executor assumptions:

## Verification

- [ ] `npm run check`
- [ ] `npm run test:distribution` if CLI, npm metadata, installation or Skill changed
- [ ] Updated README, Skill, installation/maintenance docs when related behavior changed
- [ ] No private inputs, tokens, `.awe` artifacts or other credentials packaged
- [ ] Tests for new behavior and regression cases
- [ ] Actual remote/npm/agent tests clearly distinguished from static/local checks

## Release impact

- [ ] No release required
- [ ] Requires version bump and release note (coordinate with maintainer)
- [ ] Requires manual installation/Agent Skills compatibility verification

Do **not** publish to npm or create releases automatically as part of a normal code PR.
