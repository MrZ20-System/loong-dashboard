# GitHub Package Agent Instructions

## Purpose

Own the GitHub metadata provider and the only allowed `gh` command boundary.

## Boundaries

- Keep `gh` execution inside this package.
- Return typed provider data; do not place GitHub calls in list routes or the
  Web package.
- Do not add DSH, raw SQL, or local Git execution here.

## Verification

Use recorded `gh` fixtures and command-count integration tests for future
changes, then run the root architecture check.
