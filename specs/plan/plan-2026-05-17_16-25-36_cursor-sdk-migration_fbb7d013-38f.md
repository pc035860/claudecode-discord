# Plan: Migrate `claudecode-discord` from Claude Agent SDK to Cursor Agent SDK

Branch: `migrate-cursor-agent-sdk`

## Context

The bot currently uses `@anthropic-ai/claude-agent-sdk` (v0.2.81) as its core engine — `query()` async iterable with `canUseTool` runtime gating, JSONL-on-disk session storage, and `systemPrompt.append` for injecting `rules/BOT.md` + per-channel output-styles. Goal is to swap the engine to `@cursor/sdk` (v1.0.13+) while keeping the Discord-side UX functional.

Cursor SDK has several missing primitives versus Claude SDK:
- No `canUseTool` callback — only file-based hooks or static `permissions.json`
- No `renameSession` API
- No `systemPrompt`; rules flow through `AGENTS.md` / `.cursor/rules/`
- Sessions stored in SQLite (not user-visible JSONL), so no preview/delete via filesystem
- Two-step API: `Agent.create()` → `agent.send()` → `run.stream()` (vs Claude's single `query()`)

MVP strategy: trim features that depend on missing primitives rather than rebuild equivalents. Get a working swap first, decide on hooks/persona reintroduction later.

## Locked decisions

1. **Tool approval**: full-allow mode (no `canUseTool`). `/auto-approve` removed.
2. **Persona / rules**: NOT injected into Cursor SDK. `/output-styles` removed. `rules/BOT.md` and `rules/output-styles/` orphaned (left on disk).
3. **Session rename**: `/rename-session` removed.
4. **/sessions UX**: resume-only. No preview, no delete button.
5. **Attachments `[ATTACH:]` (outbound)**: disabled — Cursor doesn't know the convention. `extractAttachments` / `sendAttachments` helpers and their tests are DELETED. Inbound flow (Discord upload → `.claude-uploads/` → `[Attached images/files]` prompt prefix) is KEPT (Cursor's `read` tool can ingest local files).
6. **`/last` and `/clear-sessions`**: DELETED (both depend on JSONL `findSessionDir` and have no Cursor-SDK equivalent).
7. **`/status` embed**: remove `Auto-approve` row (`/auto-approve` no longer exists).
8. **`output-formatter.ts` dead helpers**: `createToolApprovalEmbed`, `createAskUserQuestionEmbed`, `extractAttachments`, `sendAttachments` and their tests DELETED. Keep `createStopButton`, `createCompletedButton`, `splitMessage`, `createResultEmbed`.
9. **DB schema**: add new `sessions.agent_id TEXT` column (Cursor agent id). Old `session_id` column kept; old rows untouched (no cleanup migration). `projects.output_style` / `projects.auto_approve` columns left dormant.
10. **Model config**: default `CURSOR_MODEL=composer-2-fast`. Optional `CURSOR_MODEL_PARAMS` (JSON array string, e.g. `'["thinking-high"]'`).
11. **Settings sources**: `local.settingSources: ["all"]`.
12. **Auth**: new required env `CURSOR_API_KEY`. Drop `CLAUDE_MODEL`, `CLAUDE_EFFORT`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDECODE` guard.
13. **New command**: `/cursor-models` lists available models via `Cursor.models.list()`.
14. **Node engine**: bump `>=20.0.0` → `>=22.0.0` (Cursor SDK requires Node 22).
15. **SDK pin**: tilde `~1.0.13` (Cursor flagged tool-call schema as unstable).
16. **PM2 deploy**: use `pm2 delete claudecode-discord && pm2 start dist/index.js --name claudecode-discord && pm2 save` to ensure fresh `.env` load (`pm2 restart --update-env` keeps stale PM2-baked env).

## File-by-file change list

### Dependencies & config

- **`package.json`**: remove `@anthropic-ai/claude-agent-sdk`; add `"@cursor/sdk": "~1.0.13"`; bump `engines.node` to `>=22.0.0`.
- **`.env.example`**: remove `CLAUDE_MODEL`, `CLAUDE_EFFORT`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; add `CURSOR_API_KEY`, `CURSOR_MODEL` (commented default), `CURSOR_MODEL_PARAMS` (commented optional).
- **`src/utils/config.ts`**:
  - Remove `CLAUDE_MODEL`, `CLAUDE_EFFORT`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW` from `envSchema`.
  - Add `CURSOR_API_KEY: z.string().min(1)`, `CURSOR_MODEL: z.string().default("composer-2-fast")`, `CURSOR_MODEL_PARAMS: z.string().optional().transform(s => s ? z.array(z.string()).parse(JSON.parse(s)) : undefined)`.
- **`src/utils/config.test.ts`**: update test cases for new fields, drop old ones.

### Database

- **`src/db/database.ts`**:
  - Inside `initDatabase()`, add try-catch ALTER (same pattern as existing `output_style` migration): `ALTER TABLE sessions ADD COLUMN agent_id TEXT`.
  - Rename `upsertSession(id, channelId, sessionId, status)` parameter `sessionId` → `agentId`. New SQL:
    ```sql
    INSERT OR REPLACE INTO sessions (id, channel_id, session_id, agent_id, status, last_activity)
    VALUES (?, ?, NULL, ?, ?, datetime('now'))
    ```
    Legacy `session_id` column receives `NULL` for all new Cursor rows.
  - `getSession()` SELECT includes `agent_id`.
- **`src/db/types.ts`**: add `agent_id: string | null` to `Session`; comment on `session_id` as `// legacy Claude session ID (unused)`.

### Core SDK rewrite

- **`src/claude/session-manager.ts`** (largest change):
  - Line 1: replace import with `import { Agent, type Run } from "@cursor/sdk"`.
  - Drop imports of `loadBotRules`, `setAutoApprove`.
  - `ActiveSession` interface (lines 27–32): replace `queryInstance: Query` with `agent: Agent; run: Run`; replace `sessionId` with `agentId`.
  - Delete all `pendingApprovals` / `pendingQuestions` / `pendingCustomInputs` maps and helper methods (`resolveApproval`, `resolveQuestion`, `enableCustomInput`, `resolveCustomInput`, `hasPendingCustomInput`).
  - `formatToolDetail()` (lines 57–81): rewrite tool-name dispatch for Cursor's set (`shell`, `read`, `edit`, `write`, `glob`, `grep`, `ls`, `semSearch`, `task`, `mcp`). Argument keys: best-effort (`command`, `file_path`/`path`, `pattern`, `query`, `description`); refine via smoke test.
  - `parseApiError()` (lines 83–101): keep, may need minor regex tweak after smoke test.
  - `sendMessage()` body (lines 109–552):
    - Drop `botRules = loadBotRules(...)`, attachment extraction, all rules/style injection.
    - Replace `query({...})` block (lines 218–398) with:
      ```ts
      const agent = resumeAgentId
        ? await Agent.resume(resumeAgentId, { apiKey: config.CURSOR_API_KEY, runtime: "local" })
        : await Agent.create({
            apiKey: config.CURSOR_API_KEY,
            model: { id: config.CURSOR_MODEL, ...(config.CURSOR_MODEL_PARAMS ? { params: config.CURSOR_MODEL_PARAMS } : {}) },
            local: { cwd: project.project_path, settingSources: ["all"] },
          });
      upsertSession(dbId, channelId, agent.id, "online");
      const run = await agent.send(prompt);
      ```
    - Replace `for await (const message of queryInstance)` (line 408) with `for await (const event of run.stream())` and new router (see Design 2 below).
  - `stopSession()` (line 554): `session.run.cancel()` replaces `session.queryInstance.interrupt()`.
- **`src/claude/session-manager.test.ts`**: change `vi.mock` target to `@cursor/sdk` exporting `Agent`. Stub `Agent.create`, `Agent.resume`, returning an object with `id`, `send()` returning `{ id, stream: async function*() {...}, cancel: vi.fn() }`. Rewrite `formatToolDetail` cases for Cursor tool names.

### Commands

- **`src/bot/commands/sessions.ts`**:
  - Replace `listSessions` import with `import { Agent } from "@cursor/sdk"`.
  - `listSessions(projectPath)` calls `Agent.list({ runtime: "local", cwd: projectPath })`; map to `{ sessionId: agentId, firstMessage, customTitle: undefined, lastModified, fileSize: 0 }`. First page only (already capped at 24 downstream). Note: confirm in smoke test that `Agent.list` actually filters by `cwd`; add client-side filter if not.
  - Update `activeSessionId = dbSession?.agent_id ?? null` (was `session_id`).
  - On `session-resume`, `upsertSession(uuid, channelId, agentId, "idle")` — call site uses new param semantics.
  - Remove `findSessionDir`, `getLastAssistantMessage`, `getLastAssistantMessageFull` helpers and the preview/delete code paths.
- **`src/bot/commands/sessions.test.ts`**: update mock target.
- **`src/bot/commands/rename-session.ts` + `rename-session.test.ts`**: DELETE both files.
- **`src/bot/commands/output-styles.ts`**: DELETE.
- **`src/bot/commands/auto-approve.ts`**: DELETE.
- **`src/bot/commands/last.ts`** (+ test if present): DELETE (depends on JSONL `findSessionDir` / `getLastAssistantMessageFull`).
- **`src/bot/commands/clear-sessions.ts`** (+ test if present): DELETE (depends on JSONL `findSessionDir`).
- **`src/bot/commands/status.ts`**: remove the `Auto-approve: On/Off` row from the embed (since `/auto-approve` is gone).
- **`src/bot/commands/cursor-models.ts`** (NEW): pattern matches `/status` (export `data: SlashCommandBuilder` + `execute(interaction)`). Body: `Cursor.models.list({ apiKey })` → `EmbedBuilder` with fields per model. No autocomplete.
- **`src/bot/client.ts`** (lines 17–31):
  - Remove imports for `renameSessionCmd`, `outputStylesCmd`, `autoApproveCmd`, `lastCmd`, `clearSessionsCmd`.
  - Add import for `cursorModelsCmd`.
  - Net commands array (**9 entries**): `[register, unregister, status, stop, sessions, queue, new, usage, cursorModels]`.

### Interaction handler

- **`src/bot/handlers/interaction.ts`**:
  - Remove imports of `findSessionDir`, `getLastAssistantMessage` from `../commands/sessions.js` (line 13).
  - Remove `ask-opt` / `ask-other` button branches (around lines 122–152) — AskUserQuestion is gone.
  - Remove select-menu `ask-select:` branch (around lines 348–369).
  - Replace `session-select` handler: skip the JSONL preview, skip Delete button. Direct flow: select → `upsertSession(uuid, channelId, selectedAgentId, "idle")` → reply "Resumed".
  - Remove `session-delete` button handler entirely (lines 252–302).
  - Remove `approve` / `deny` / `approve-all` button branches (around lines 304–333).
  - Add explicit early-return for unknown button `action` to handle orphan customIds (R8).
  - Keep `session-resume` button (now the only `/sessions` action).

### Message handler

- **`src/bot/handlers/message.ts`**:
  - Remove `hasPendingCustomInput` / `resolveCustomInput` block (lines 84–91) — AskUserQuestion custom-input flow is gone.
  - KEEP the Discord upload → `.claude-uploads/` → `[Attached images/files]` prompt prefix flow (inbound files; works with Cursor's `read` tool).

### Utils & orphans

- **`src/utils/rules-loader.ts` + `rules-loader.test.ts`**: DELETE.
- **`rules/BOT.md`, `rules/output-styles/`**: leave on disk (not referenced).
- **`src/claude/output-formatter.ts`**: DELETE dead helpers — `createToolApprovalEmbed`, `createAskUserQuestionEmbed`, `AskQuestionData` type, `extractAttachments`, `sendAttachments`. KEEP `createStopButton`, `createCompletedButton`, `splitMessage`, `createResultEmbed` (still in use).
- **`src/claude/output-formatter.test.ts`**: remove `describe` blocks for the deleted helpers (`extractAttachments`, `sendAttachments`, `createToolApprovalEmbed`, `createAskUserQuestionEmbed`).

### Documentation

- **`README.md`**: update feature list (commands changed), environment variables.
- **`SETUP.md` + `docs/SETUP-WINDOWS.md`**: replace Claude API key setup with `CURSOR_API_KEY`; update Node version note.
- **`CLAUDE.md`**: rewrite SDK integration section; remove "SDK 與 CLI 工具集差異" / "settingSources 修改" / "附件上傳功能" / "Output Style" / `/rename-session` paragraphs.
- **Start scripts** (`mac-start.sh`, `linux-start.sh`, `win-start.bat`, `install.sh`, `install.bat`): audit for Node 20 references.

## Design notes

### 1. Cursor `CURSOR_MODEL_PARAMS` encoding
Cursor's `model.params` is `string[]` (flag-like). Encode env as JSON array literal: `CURSOR_MODEL_PARAMS='["thinking-high","fast"]'`. Parse + validate via Zod transform; fail fast at startup on malformed JSON.

### 2. Stream event router
Use `run.stream()` (not `onDelta`/`onStep`) to match existing `for await` topology. Event types per Cursor docs: `system`, `user`, `assistant`, `thinking`, `tool_call`, `status`, `task`, `request`.

Routing:
- `system` (init) — capture `agent.id` if not yet known.
- `assistant` (text content blocks) — append to `responseBuffer`, set `hasTextOutput=true`, schedule flush. For `THREAD_PROGRESS`, also `threadReporter?.pushText(text)`.
- `tool_call` running phase (has `args`, no `result`) — `threadReporter?.pushTool(name, formatToolDetail(name, args))`, update `lastActivity`, `toolUseCount++`.
- `tool_call` completed/error phase (has `result`) — currently ignored to avoid duplicate Thread lines. Future: surface errors.
- `thinking`, `status`, `task`, `request`, `user` — ignored for MVP.

After the loop: `const final = await run.result?.()` (or similar — see Risk R2). Map to `{ result.text, totalCostUsd, durationMs }`; fall back to accumulated `responseBuffer` / `Date.now() - startTime` if fields missing.

### 3. Resume detection
DB-driven (same as current Claude logic):
```ts
const existing = this.sessions.get(channelId);
const dbSession = !existing ? getSession(channelId) : undefined;
const resumeAgentId = existing?.agentId ?? dbSession?.agent_id ?? null;
```
Persist `agent.id` to DB immediately after `Agent.create()` (before `send()`) so crash mid-stream leaves a resumable record.

### 4. `formatToolDetail` arg-key best-effort map
| Cursor tool | Probable arg keys |
|---|---|
| `shell` | `command` |
| `read` / `edit` / `write` | `file_path` or `path` |
| `grep` | `pattern`, `path` |
| `glob` | `pattern` |
| `ls` | `path` |
| `semSearch` | `query` |
| `task` | `description`, `subagent_type` |
| `mcp` | generic fallback |

Verify exact shape in Smoke 1 below; adjust if needed (one helper to update).

## Risks / open questions

- **R1** — `RunResult` shape (cost / duration / final text) unverified without SDK installed. Wrap in `extractResult(run)` adapter so one function changes when reality lands.
- **R2** — `tool_call` discriminator (`phase` vs `status` vs presence-of-`result`): initially branch on `"result" in event`; revise in smoke test.
- **R3** — `Cursor.models.list()` exact import path: confirm via SDK types after install.
- **R4** — `Agent.delete()` / session deletion API: out of MVP scope (no Delete button).
- **R5** — Cosmetic regression: no `customTitle` for any session in `/sessions` list.
- **R6** — `parseApiError` regex may not match Cursor error format; falls through to raw message — acceptable for MVP.
- **R7** — `SHOW_COST` may always display `$0.0000` if Cursor doesn't surface cost in `RunResult`. Update `.env.example` comment accordingly.
- **R8** — Button customId orphans: in-flight buttons from before migration (approve/deny/etc.) may still post; handler should silently no-op unknown actions, not throw. Add explicit early-return for unknown `action` at top of button dispatcher.
- **R9** — PM2 environment reload: use `pm2 delete && pm2 start && pm2 save` (not `pm2 restart`) to ensure stale `CLAUDE_*` env doesn't persist in PM2-managed process.
- **R10** — `data.db` lives at repo root with existing rows. Migration ALTER is idempotent (try-catch on duplicate column). Old rows have `agent_id = NULL`, which means resume falls through to `Agent.create()` — verified safe.
- **R11** — Node 22 in start scripts: `mac-start.sh`, `linux-start.sh`, `win-start.bat`, `install.sh`, `install.bat` — change "audit" to hard step. Update any Node 20 version checks and PM2 runtime expectations.
- **R12** — `tsup` ESM build with `@cursor/sdk`: SDK is compiled bundle. If it ships CJS-only or has missing types, build may fail. Mitigation: include `npx tsc --noEmit` in step 1a verification, not just final step.
- **R13** — `tsconfig.json` `moduleResolution`: confirm `"module": "ESNext"` + `"moduleResolution": "bundler"` or `"NodeNext"` compatible with `@cursor/sdk` `exports` map. Spot-check before step 2.
- **R14** — `Agent.list` runtime+cwd filter behavior unverified. If list returns all local agents regardless of cwd, need client-side filter. Add to Smoke 5.

## Implementation order

1. **Foundation (parallel-safe)**:
   - 1a. `package.json` deps + Node engine.
   - 1b. `.env.example` + `src/utils/config.ts` + `config.test.ts`.
   - 1c. `src/db/database.ts` + `src/db/types.ts` (add `agent_id`).
   - 1d. **SDK API verification** (cheap pre-flight): after `npm install`, run `node --input-type=module -e "import { Agent, Cursor } from '@cursor/sdk'; console.log(Object.keys(Agent), Object.keys(Cursor ?? {}))"` to confirm `create` / `resume` / `list` exist and `Cursor.models.list` shape. Also `npx tsc --noEmit` to ensure SDK types load. Lock the type names in `session-manager.ts` based on actual `.d.ts`.
2. **Core rewrite** (critical path): `src/claude/session-manager.ts` + `session-manager.test.ts`. Depends on 1.
3. **Sessions command** (parallel with 2): `src/bot/commands/sessions.ts` + test. Depends on 1c.
4. **Deletions** (parallel with 2, 3):
   - 4a. Delete `rename-session.ts` + test.
   - 4b. Delete `output-styles.ts`.
   - 4c. Delete `auto-approve.ts`.
   - 4d. Delete `rules-loader.ts` + test.
   - 4e. Delete `last.ts` (+ test if exists) and `clear-sessions.ts` (+ test if exists).
   - 4f. Delete dead helpers in `output-formatter.ts` + corresponding test blocks.
5. **New `/cursor-models`** (parallel with 2): `src/bot/commands/cursor-models.ts`. Depends on 1b for API key.
6. **`client.ts` registration update**: remove deleted commands, add `cursor-models`. Depends on 4 & 5.
7. **Interaction handler cleanup** (depends on 2): drop approve/deny/question branches; remove JSONL imports; simplify `session-select` to direct resume.
   - 7a. **Message handler cleanup**: `handlers/message.ts` remove `hasPendingCustomInput` / `resolveCustomInput`.
8. **`/status` embed**: remove Auto-approve row.
9. **Docs**: README, CLAUDE.md, SETUP, start scripts (Node 22).
10. **Verification**: see below.

Critical path: 1 → 2 → 7 → 10. Steps 3, 4, 5, 8, 9 can run in parallel after step 1.

## Verification

1. **Static**: `npm install`, `npx tsc --noEmit`, `npm run build`, `npm test`.
2. **Boot**: deploy via `pm2 delete claudecode-discord && pm2 start dist/index.js --name claudecode-discord && pm2 save` (fresh env reload). Check `pm2 logs` for clean startup, slash commands registered (9 entries), no SDK errors.
3. **Smoke 1 — fresh session**: `/register` a project, send "list files in src". Verify:
   - `tool_call` event fires with Cursor tool name (likely `ls` or `shell`).
   - ThreadReporter (if `THREAD_PROGRESS=true`) shows `🔧` tool line + `💬` text deltas.
   - Final embed shows duration > 0. Cost displays (or `$0.0000` if unavailable — log warning).
   - DB row has non-null `agent_id`.
4. **Smoke 2 — resume in same channel**: follow-up message. Verify DB `agent_id` reused; `Agent.resume` code path hit (add `console.debug` temporarily).
5. **Smoke 3 — restart resume**: `pm2 restart`, send another message. Resume still works.
6. **Smoke 4 — stop**: long task + click Stop. `run.cancel()` resolves, status flips to `offline`.
7. **Smoke 5 — `/sessions`**: lists agents, resume populates DB, next message uses that agent id.
8. **Smoke 6 — `/cursor-models`**: returns embed with at least `composer-2-fast`.
9. **Smoke 7 — bad auth**: set `CURSOR_API_KEY=bad`, send message. Graceful `❌` reply.
10. **Smoke 8 — inbound attachment**: send a Discord message with an image attachment. Confirm `.claude-uploads/` download still works and Cursor's `read` tool can ingest the file via the `[Attached images]` prompt prefix.
11. **Smoke 9 — legacy DB row**: seed a row with `session_id` set + `agent_id = NULL`, send a message. Confirm code falls through to `Agent.create()` (no crash on null agent_id).
12. **Memory closure**: after verification, update `graph-memory` with new SDK integration entity + key limitations (full-allow mode, no persona, agent_id schema).

## Completion Status

Implementation landed on branch `migrate-cursor-agent-sdk` over four commits:

| Commit    | Subject                                            |
| --------- | -------------------------------------------------- |
| `d5438b5` | feat(sdk)!: migrate from Claude Agent SDK to Cursor Agent SDK |
| `d23fb69` | fix(sdk): address Codex review findings on Cursor migration |
| `2cb6657` | refactor(sdk): simplify post-migration code        |
| `fe938f9` | chore: address post-simplify Codex suggestions     |

Verification: `npx tsc --noEmit` clean, `npm test` 125 passed, `npm run build` clean. Manual smoke tests (Smoke 1–9 in the Verification section) are still pending — run after `pm2 delete claudecode-discord && pm2 start dist/index.js --name claudecode-discord && pm2 save`.

Deviations from the original plan:
- `Agent.list({ cwd: projectPath })` cannot project-scope (Cursor SDK uses `cwd` as the platform workspaceRef, not per-run `local.cwd`). `/sessions` now lists ALL local agents in the bot workspace and warns the user. Documented as a known limitation.
- Cursor SDK `RunResult` has no `totalCostUsd`. `SHOW_COST=true` always shows `$0.0000`. Acceptable per plan note R7.
- Dead-code cleanup in commit `2cb6657` removed `setOutputStyle`, `setAutoApprove`, `formatStreamChunk`, `output_style` / `auto_approve` `Project` type fields, and narrowed `SessionStatus` to `"online" | "offline" | "idle"`. DB columns left in place (no migration cleanup, per locked decision 9).
- README architecture and security sections rewritten in `d23fb69` to remove stale "Claude Agent SDK" / per-tool approval language. Brand name "Claude Code Discord Controller" intentionally kept (out of MVP scope).
- Stop-before-run race + finally identity-check + run.wait() status branching are documented in `d23fb69` commit body and `src/claude/session-manager.ts` comments.

Pending follow-up (not blocking ship):
- Integration smoke against a live Cursor SDK environment (Smoke 1–9 in Verification).
- State-machine test for `/stop` + immediate new message (mocks for Cursor SDK `run.stream()` are non-trivial).
- Rebrand pass if/when "Claude Code Discord Controller" name is retired.

## Critical files

- `/Users/pc035860/code/claudecode-discord/src/claude/session-manager.ts`
- `/Users/pc035860/code/claudecode-discord/src/claude/output-formatter.ts`
- `/Users/pc035860/code/claudecode-discord/src/bot/commands/sessions.ts`
- `/Users/pc035860/code/claudecode-discord/src/bot/commands/status.ts`
- `/Users/pc035860/code/claudecode-discord/src/utils/config.ts`
- `/Users/pc035860/code/claudecode-discord/src/db/database.ts`
- `/Users/pc035860/code/claudecode-discord/src/db/types.ts`
- `/Users/pc035860/code/claudecode-discord/src/bot/client.ts`
- `/Users/pc035860/code/claudecode-discord/src/bot/handlers/interaction.ts`
- `/Users/pc035860/code/claudecode-discord/src/bot/handlers/message.ts`
- `/Users/pc035860/code/claudecode-discord/package.json`
- `/Users/pc035860/code/claudecode-discord/.env.example`
