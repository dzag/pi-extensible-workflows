# Releasing

This repository uses npm workspaces. `packages/core` is the publishable
`pi-extensible-workflows` package and `packages/cli` is the publishable
`@piew/cli` package; the repository root is private and is never published.
Satellite packages use the `@piew` scope, while the core package keeps its
established unscoped name. `packages/extensions/*` holds repo-local extension
packages such as `@piew/herdr`, which is private and unpublished.

Publishable workspaces use one fixed shared version. Keep the root version and
each publishable workspace version equal, then create the matching `vX.Y.Z`
tag. The publish workflow verifies the root, core, and CLI versions, runs the root
checks, and publishes both `packages/core` and `packages/cli`.

For local release checks:

```sh
npm install
npm run check
npm pack --dry-run --json --ignore-scripts --workspace=packages/core
npm pack --dry-run --json --ignore-scripts --workspace=packages/cli
```
