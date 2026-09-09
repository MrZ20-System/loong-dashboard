# GitHub Package Agent Instructions

## Purpose

Own the GitHub metadata provider and the only allowed `gh` command boundary.

## Boundaries

- Keep `gh` execution inside this package.
- Return typed provider data; do not place GitHub calls in list routes or the
  Web package.
- Do not add DSH, raw SQL, or local Git execution here.

## Verification

Use injected HTTP/token boundaries for provider unit tests, then run the root architecture check.
