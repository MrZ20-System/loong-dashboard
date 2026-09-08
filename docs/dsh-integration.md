# DSH Integration

DeepSeek Harness is an external Agent runtime, not the LoongBoard product
framework. The repository pins release `dsh-v0.1.2-alpha.5` in
`dsh.lock.json`, with the SDK packages at exact version `0.1.2-alpha.5`.

## Adapter boundary

Only `packages/agent-runtime-dsh/**` may import `@deepseek-ai/*`. The adapter
converts the pinned SDK's real notifications into LoongBoard-owned runtime
events. Server, Web, database, GitHub, Knowledge, and Scheduler code never
exposes or stores raw DSH `SessionEvent` types.

## Lifecycle

The DSH lifecycle is implemented: one isolated `DeepSeekHarness` subprocess
per LoongBoard session runs with a per-session `dsh-home`; the recorded
runtime session id is reused by later runs so model context survives idle
process shutdown, and `stop` terminates the child process (also the cancel
mechanism, since the pinned SDK has no separate prompt-cancel API). A
stopped run is recorded as `interrupted` with the runtime session id cleared,
so the next turn mints a fresh DSH session id instead of handing a dead id to
a new process. V1 does not add a DSH Plugin or DSH Web UI; the chat rail is
LoongBoard's own UI over normalized events.

## Event mapping

`packages/agent-runtime-dsh` maps the real `session.event` wire shape
(`params.sessionId` and `params.event = { type, seq, time, data }`) while
`session.run` is still pending, so events stream to callers during the run
rather than replaying after completion:

- `assistant/chunk` with a text-delta chunk becomes `assistant.delta`.
- `assistant/message` emits nothing: the completed assistant message is
  persisted exactly once from `RunResult.finalResponse`.
- `tool/call` becomes `tool.started` with the call id, name, and raw
  arguments summary.
- `tool/result` becomes `tool.completed`; the result carries no tool name, so
  one mapper instance per run recovers names from paired `tool/call` events
  (an unmatched result falls back to `"tool"`).

A FIFO notification channel between the SDK callback and the runtime
generator wakes parked waiters when the run settles; notifications delivered
after close are ignored.

A live DSH session smoke was recorded on 2026-09-07 against the real
subprocess runtime. It recovered a LoongBoard session whose previous turn had
ended in error: the recovered run streamed `STREAM_OK`, and glob/read tool
calls on the persisted session reported `TOOL_OK`. Stop during that turn
returned `interrupted` with a null runtime session id, and the next message
produced `RESUMED_OK` with an idle session and a fresh runtime session id.
Recorded-fixture tests still cover the adapter's event mapping and channel
behavior.
