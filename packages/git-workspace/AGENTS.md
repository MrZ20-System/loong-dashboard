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

Future changes require temporary Git fixture integration tests and the root
architecture check.
