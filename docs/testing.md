# Testing

The root workspace exposes focused and aggregate checks:

```bash
pnpm install
pnpm --filter @loongboard/contracts test
pnpm check:architecture
pnpm typecheck
pnpm check
pnpm check:full
pnpm test:e2e:stage1
```

Contract tests parse and reject the exact health response. Architecture tests
exercise the DSH import and raw-SQL boundaries and report the violating file,
rule, and repair direction. Future command adapters use recorded or fake
executables; future user flows use Playwright and temporary Git fixtures.

Static checks prove only their executed layer. A passing local check does not
claim GitHub, hardware, remote runner, or live DSH evidence unless that test
actually ran it.

## Stage 1 browser acceptance

`pnpm test:e2e:stage1` creates one disposable root containing two initialized
fixture repositories, a temporary `system.yaml`, runtime directories, an
executable fake GitHub CLI, and an append-only command log. It starts the
non-watch Server and Vite on strict temporary loopback ports, runs the serial
Playwright flow, and then terminates each owned process tree before removing
only that root.

The runner uses the Playwright-managed browser by default. If that browser is
not installed on a development host, set `LOONGBOARD_E2E_BROWSER_PATH` to an
installed Chromium-compatible executable for the run.

The fake command selects responses by repository, operation, requested states,
cursor, and sync generation. It never uses process-global call ordering and it
does not record request bodies or raw responses. The browser flow proves that
repository and metadata reads make zero GitHub calls, bootstrap fills all four
streams, list pagination is SQLite-only, tie ordering and filters are stable,
incremental equality/early-stop behavior is honored, and a failed Issue stream
leaves old rows available while Pull Requests complete independently.

The real smoke is deliberately separate and is never run by the E2E command:

```bash
pnpm smoke:stage1:real
```

It reads only `vllm` and `vllm-ascend` from the parent `system.yaml`, uses a
temporary LoongBoard state/config, and puts an executable recording wrapper in
front of an absolute real `gh`. It performs two Server-API syncs per source
repository, checks non-empty sorted lists and zero command increments for
SQLite reads, records both watermarks, and byte-compares each source checkout's
Git `HEAD` and status before/after. The wrapper records command metadata only;
tokens, request bodies, and raw GitHub responses are not persisted or printed.
The wrapper records only parsed repository/operation/state/cursor metadata and
result byte counts; response bytes travel only through the provider pipe.
