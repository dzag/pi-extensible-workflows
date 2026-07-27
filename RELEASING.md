# Releasing

This repository uses npm workspaces. `packages/core` is the publishable
`pi-extensible-workflows` package; the repository root is private and is never
published. The `packages/extensions/*` workspace is reserved for future
extension packages and has no published packages yet.

Publishable workspaces use one fixed shared version. Keep the root version and
each publishable workspace version equal, then create the matching `vX.Y.Z`
tag. The publish workflow verifies the root and core versions, runs the root
checks, and publishes only `packages/core`.

For local release checks:

```sh
npm install
npm run check
npm pack --dry-run --json --ignore-scripts --workspace=packages/core
```
