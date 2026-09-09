# Knowledge Package Agent Instructions

## Purpose

Own the Markdown knowledge repository, its file-system source of truth, and
file identity operations.

## Boundaries

- Markdown files are the source data; SQLite is only an index and state store.
- Git checkpoint orchestration belongs to the Server and commands to packages/git-workspace.
- Do not import DSH, invoke `gh`, or own general local worktree commands here.

## Verification

Use focused filesystem unit tests and the root architecture check.
