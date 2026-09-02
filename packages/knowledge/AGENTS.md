# Knowledge Package Agent Instructions

## Purpose

Own the Markdown knowledge repository, its file-system source of truth, and
the narrowly scoped Git checkpoint service.

## Boundaries

- Markdown files are the source data; SQLite is only an index and state store.
- Keep Knowledge Git checkpoint commands in a file explicitly scoped to that
  service.
- Do not import DSH, invoke `gh`, or own general local worktree commands here.

## Verification

Future changes require file-system and Git fixture tests plus the root
architecture check.
