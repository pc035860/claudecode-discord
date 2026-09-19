# Plan: Migrate `claudecode-discord` from Cursor SDK to Pi Agent SDK

Branch: `migrate-pi-agent-sdk` (cut from `migrate-cursor-agent-sdk`)

## Context

The bot currently drives cloud agents via `@cursor/sdk` (1.0.28): `Agent.create/resume()` → `agent.send()` → `run.stream()` → `run.wait()`. The dominant cost of this architecture is not features but **reliability scaffolding** — long-lived gRPC client state rots (~2–5 days → code 16 `unauthenticated` / backend stale-auth text), which forced in-process retry, `maybeSelfRestart`, PM2 `--cron-restart`, transient-run heuristics, and `local.force` zombie-run handling.

Target is `@earendil-works/pi-coding-agent` (0.85.1, SDK docs: `packages/coding-agent/docs/sdk.md` in pi-mono): a **local, in-process** agent. No backend, no gRPC client, no auth rot. Spike `spike/pi-session.ts` passed 2026-09-19 against the real API (fresh → prompt → `SessionManager.open` resume → `setModel` → follow-up with history intact).

Strategy: swap the engine inside `session-manager.ts`, keep the entire Discord layer (commands UX, queue, thread-reporter, output-formatter, DB shape + one column). Then restore the features cut in the Cursor MVP, which Pi supports natively.

## Locked decisions

1. **Package**: `@earendil-works/pi-coding-agent` `^0.85.1`. NOT the legacy `@mariozechner/*` namespace. (Spike installed with `--no-save`; implementation runs `npm install --save`.)
2. **Auth**: `ModelRuntime.create()` defaults → reads `~/.pi/agent/auth.json` + `models.json`. No new env key. `CURSOR_API_KEY` removed (breaking `.env` change — deploy must update it, otherwise zod `required` fails at boot).
3. **Model**: new `PI_MODEL`, pi-CLI format `provider/id[:thinkingLevel]`, default `openrouter/meta/muse-spark-1.3-contributor:medium`. Parsed with the SDK's `resolveCliModel()` (handles custom models from `models.json`; bare `pi-ai getModel()` does NOT). Bot default is fully independent of `~/.pi/agent/settings.json` `defaultModel` (currently fireworks glm-5p3-flash). NOTE: spec without `:level` resolves `thinkingLevel=undefined` and falls back to the user's settings — so the default value MUST carry `:medium` explicitly.
4. **Resume pins bot model**: after `SessionManager.open()`, always `session.setModel(botModel)` before prompting (spike-verified). Predictable billing over session fidelity.
5. **Tool approval**: full-allow stays, no change. Revisit only if SDK exposes hooks.
6. **Restore all three cut features** (SDK-verified feasible against installed 0.85.1 `.d.ts`):
   - Cost display: session stats interface carries `tokens {input,output,cacheRead,cacheWrite,total}` + `cost: number` (`core/agent-session.d.ts:176-190`).
   - `/rename-session`: `session.setSessionName(name)` (`core/agent-session.d.ts:606`).
   - `/sessions` preview + delete: `SessionInfo {path,id,cwd,name?,created,modified,messageCount,firstMessage,allMessagesText}` (`core/session-manager.d.ts:125-139`) — preview needs no file open; delete = unlink `path` (guard: refuse while channel has an active session).
7. **Delete the self-heal apparatus**: `shouldRetryAuth`, `isStaleAuthRunError`, `isTransientRunFailure`, `TransientRunError`, `maybeSelfRestart` + `isRestartScheduled` (`src/utils/self-heal.ts` DELETED), `@connectrpc/connect` dep, `local.force` handling, and PM2 `--cron-restart` (nothing to rot anymore; keep plain PM2 `autorestart`).
8. **DB**: `ALTER TABLE sessions ADD COLUMN pi_session_file TEXT` (same try-catch pattern). Legacy `agent_id` / `session_id` columns kept, never dropped. Existing Cursor `agent_id` rows are NOT resumable under Pi → those channels start fresh sessions (deploy note, no data migration).
9. **Rules injection**: `rules/BOT.md` moves from fresh-prompt prepend into `DefaultResourceLoader({ systemPromptOverride })`. Resume path no longer depends on history to retain the convention. `rules/BOT.md` file kept.
10. **Queue**: keep the bot's own per-channel queue (`MAX_QUEUE_SIZE=5`) unchanged for MVP. Pi's native `steer()`/`followUp()` is a later optimization, not this migration.

## File-by-file change list

### Dependencies & config

- **`package.json`**: remove `@cursor/sdk`, `@connectrpc/connect`; add `@earendil-works/pi-coding-agent: ^0.85.1`. `engines.node >= 22` unchanged.
- **`.env.example`**: remove `CURSOR_API_KEY`, `CURSOR_MODEL`, `CURSOR_MODEL_PARAMS`, `AUTO_RESTART_ON_AUTH_ERROR`; add `PI_MODEL` with commented default `openrouter/meta/muse-spark-1.3-contributor:medium` + format doc (`provider/id[:thinkingLevel]`, e.g. `:high`).
- **`src/utils/config.ts`**: schema swap to `PI_MODEL: z.string().default("openrouter/meta/muse-spark-1.3-contributor:medium")`. Parsing (`resolveCliModel`) happens in session-manager, not config (needs a `ModelRuntime` instance).
- **`src/utils/config.test.ts`**: update cases for `PI_MODEL`, drop Cursor fields (keep `vi.resetModules()` + dynamic import pattern).

### Deletions

- **`src/utils/self-heal.ts`**: DELETE entire file.
- **`src/index.ts`**: drop `ConnectError`/`Code` import and the ConnectError branch in `unhandledRejection` (keep generic log); drop `maybeSelfRestart` import.
- **`src/claude/session-manager.ts`**: delete `isConnectError`, `shouldRetryAuth`, `runErrorText`, `isStaleAuthRunError`, `isTransientRunFailure`, `TransientRunError`, `parseApiError`'s ConnectError branch, both retry blocks in `catch`, `isRestartScheduled` queue-drain branch.

### Database

- **`src/db/database.ts`**: `ALTER TABLE sessions ADD COLUMN pi_session_file TEXT` in `initDatabase()` (try-catch on duplicate). `upsertSession()` / `getSession()` carry `pi_session_file`.
- **`src/db/types.ts`**: add `pi_session_file: string | null`; annotate `agent_id` as `// legacy Cursor agent ID (unused)`.

### Core rewrite — `src/claude/session-manager.ts`

- `ActiveSession` becomes `{ session: AgentSession | null; channelId; sessionFile: string | null; dbId; cancelRequested }`. Keep the **placeholder pattern + identity-check `finally`** (same stop-race protection, engine-agnostic).
- Module-scope shared `ModelRuntime` (created once via `ModelRuntime.create()`), bot `model` + `thinkingLevel` resolved once via `resolveCliModel({ cliModel: config.PI_MODEL })` at first use (fail fast with clear message if unresolvable).
- `DefaultResourceLoader` with `systemPromptOverride: () => BOT_RULES`, cached per `cwd` (loader takes `cwd`; one per project).
- `runAttempt(resumeFile | null)`:
  1. `sessionManager = resumeFile ? SessionManager.open(resumeFile) : SessionManager.create(project.project_path)`
  2. `createAgentSession({ cwd, model, thinkingLevel, modelRuntime, sessionManager, resourceLoader })`
  3. If resumed → `await session.setModel(botModel)` (decision 4)
  4. `placeholder.sessionFile = session.sessionFile`; `upsertSession(dbId, channelId, sessionFile, "online")`
  5. cancel-check → `session.subscribe(...)`: `message_update/text_delta` → `threadReporter.pushText`; `tool_execution_start` → `pushTool` + status render (tool names now pi's: `read, bash, edit, write, grep, find, ls…` — update `TOOL_LABELS` + `formatToolDetail` input shapes)
  6. `await session.prompt(augmentedPrompt)` — prompt is now the RAW user prompt (BOT.md comes via system prompt; keep `[Attached images/files]` inbound prefix as-is for MVP)
  7. cancel path: `await session.abort()` (replaces `run.cancel()`); `cancelled` handling = skip result embed, keep offline (same as now)
  8. Final text: walk `session.messages` for assistant `text` blocks (content is a block array, not a string — spike confirmed); feed through existing `extractAttachments()` → `sendAttachments()` → `createResultEmbed()` unchanged
  9. Cost: read session stats (`cost`, `tokens`) → pass REAL cost into `createResultEmbed` (currently hardcoded `0`)
  10. Error path: `prompt()` throws → `parseApiError` (generic truncation branch only) → `❌` + offline. No retries: local engine failures are either fatal (bad key/model) or transient provider hiccups the SDK already auto-retries (`auto_retry_*` events).
- `stopSession()`: `cancelRequested = true` + `session.abort()`; rest unchanged.

### Commands

- **`src/bot/commands/cursor-models.ts` → `src/bot/commands/models.ts`**: command `/models`, lists `modelRuntime.getAvailable()` (provider/id + current `PI_MODEL` default marker). Delete old file.
- **`src/bot/commands/sessions.ts`**: `SessionManager.list(project.project_path)` — **project-scoped**, killing the old `Agent.list` workspaceRef gotcha. Select labels show `name ?? firstMessage` + `messageCount` + relative time (preview restored). Resume stores `sessionFile`. Add **Delete button**: `fs.unlink(info.path)` unless that file is the channel's active session.
- **New `src/bot/commands/rename-session.ts`**: `/rename-session <name>` → open channel's session file → `setSessionName(name)` → confirm. Operates on the DB-linked session; error if channel has no session.
- **`src/bot/commands/stop.ts`**: no interface change (`stopSession` signature kept).
- **`src/bot/handlers/message.ts` / `interaction.ts`**: replace `agent_id` references with `pi_session_file`; inbound attachment flow unchanged.

### Unchanged

- `thread-reporter.ts` (`pushText`/`pushTool` interface), `output-formatter.ts` (except real cost arg), queue logic, `/register`, `/status` (drop nothing — check for Cursor-specific rows), `/queue`, `/usage`, `/new-session` (fresh = `SessionManager.create`, delete sentinel if Cursor-specific).

### Tests

- `session-manager.test.ts`: drop `@cursor/sdk` mock; mock the pi surface actually used (`createAgentSession`, `ModelRuntime`, `SessionManager`, `resolveCliModel`) — keep pure-function tests (`formatToolDetail` with NEW pi tool input shapes, `parseApiError` minus ConnectError branch).
- `sessions.test.ts`: mock `SessionManager.list` instead of `Agent.list`.
- `config.test.ts`: new env fields.
- New tests: `models.test.ts` (if non-trivial), `rename-session` handler test.
- Live smoke: re-run `spike/pi-session.ts` (real API) after the rewrite.

### Docs

- **`CLAUDE.md`**: rewrite Cursor SDK sections → Pi ("Pi SDK 整合" + mapping table); DELETE gotchas: code-16 self-heal ×2, stale-auth, transient retry, `local.force`, connectrpc import, cron-restart; ADD: `PI_MODEL` must carry `:level`, resume pins model via `setModel`, session files live under `~/.pi/agent/sessions/--<cwd>--`, `SessionManager.list(cwd)` IS project-scoped.
- **`README.md` / `SETUP.md` / `.env.example`**: `CURSOR_API_KEY` → `PI_MODEL` + "bot reuses `~/.pi/agent/auth.json`" note.
- **Deploy**: `npm run build && pm2 delete claudecode-discord && pm2 start dist/index.js --name claudecode-discord && pm2 save` — WITHOUT `--cron-restart`; `.env` MUST drop `CURSOR_*` (harmless if left, but `CURSOR_API_KEY` required-field removal means old `.env` still boots — note: removal is optional, addition of nothing required; `PI_MODEL` has a default).

## Open verification items (during implementation, NOT blocking)

1. ~~Stats accessor name for cost~~ — RESOLVED 2026-09-19: `session.getSessionStats(): SessionStats` (`core/agent-session.d.ts:641`; interface at :174-190).
2. ~~`setSessionName` persistence on a quiet session~~ — RESOLVED 2026-09-19: live harness verified rename sticks via open → setSessionName → dispose, no prompt needed.
3. ~~`SessionManager.list(cwd)` matching semantics~~ — RESOLVED 2026-09-19: scoping comes from the DIRECTORY, not filtering. `list(cwd)` reads `~/.pi/agent/sessions/--<encoded-cwd>--/` only (`session-manager.js:1311-1318`; `filterCwd` applies solely when a custom `sessionDir` is passed). IMPL NOTE: pass a `realpath`-normalized cwd — symlinked paths (e.g. macOS `/tmp` vs `/private/tmp`) encode to different dir names and would list the wrong bucket.
4. Inbound attachments could later switch to `prompt(text, { images })`; MVP keeps the `read`-tool prefix (zero change).
5. ~~Per-tool approval hooks~~ — RESOLVED 2026-09-19: the extension API has a `tool_call` event whose handler may return `{ block: true, reason }` (`core/extensions/types.d.ts:818-827`), wireable via `DefaultResourceLoader({ extensionFactories })`. MVP stays full-allow per decision 5; gating is a follow-up, not this migration.

## Test plan

1. `npm test` — all suites green (mocks updated).
2. `npx tsx spike/pi-session.ts` — live smoke against real API.
3. Manual Discord pass: fresh prompt → resume → `/stop` mid-run → queued message → `/sessions` list/preview/resume/delete → `/rename-session` → `/models` → cost footer shows non-zero.
4. Long-run: no code-16 class failures possible by construction; watch provider rate limits instead.
