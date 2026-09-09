# Scheduler Package Agent Instructions

## Purpose

Own cron parsing and next-occurrence calculation. Run orchestration lives in apps/server and persistence in packages/database.

## Boundaries

- Keep cron calculation independent of Agent runtimes; execution belongs to the Server.
- Do not own raw SQL, GitHub calls, or local Git commands.
- Preserve timezone and cron semantics. Server orchestration uses the shared workspace guard for one active turn per path.

## Verification

Changes require focused cron unit tests and the root checks.
