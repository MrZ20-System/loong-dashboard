# DSH Integration

DeepSeek Harness is an external Agent runtime, not the LoongBoard product
framework. The repository pins release `dsh-v0.1.2-alpha.5` in
`dsh.lock.json`, with the SDK packages at exact version `0.1.2-alpha.5`.

## Adapter boundary

Only `packages/agent-runtime-dsh/**` may import `@deepseek-ai/*`. The adapter
converts external notifications to LoongBoard-owned runtime events. Server,
Web, database, GitHub, Knowledge, and Scheduler code never exposes or stores
raw DSH `SessionEvent` types.

## Deferred lifecycle

Stage 0 only reserves the package and pin. Stage 4 will add the isolated
per-session process, DSH_HOME, runtime-session recovery, normalized events,
idle shutdown, and process-termination cancellation. V1 does not add a DSH
Plugin or DSH Web UI integration.
