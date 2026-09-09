# Git Workspace Package Agent Instructions

## Purpose

Own local Git commands, disposable worktrees, and repository workspace
operations.

## Boundaries

- Keep Git process execution inside this package.
- Do not execute `gh`, raw SQL, or DSH operations here.
- Keep worktrees disposable and never expose raw command output as an HTTP
  contract.

## Verification

Use focused command-adapter unit tests, temporary Git repositories when needed, and the root architecture check. Critical regressions follow docs/testing.md.
