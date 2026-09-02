# Testing

The root workspace exposes focused and aggregate checks:

```bash
pnpm install
pnpm --filter @loongboard/contracts test
pnpm check:architecture
pnpm typecheck
pnpm check
pnpm check:full
```

Contract tests parse and reject the exact health response. Architecture tests
exercise the DSH import and raw-SQL boundaries and report the violating file,
rule, and repair direction. Future command adapters use recorded or fake
executables; future user flows use Playwright and temporary Git fixtures.

Static checks prove only their executed layer. A passing local check does not
claim GitHub, hardware, remote runner, or live DSH evidence unless that test
actually ran it.
