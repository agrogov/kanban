# Native chat view for Claude, Codex and Pi — scope

## Why
Cline renders as a React chat (`cline-agent-chat-panel.tsx`) so text selection, context menu, links and copy
behave like the web. Claude/Codex/Pi run as TUIs in a PTY shown through xterm.js, which owns the mouse and menu.

## What already exists (reuse, don't rebuild)
- Wire contract: `runtimeTaskChatMessageSchema` (`src/core/api-contract.ts` ~1076): roles
  user/assistant/system/tool/reasoning/status, `meta.toolName/toolCallId/...`.
- tRPC: `getTaskChatMessages`, `sendTaskChatMessage`, `cancelTaskChatTurn`, state-stream
  `task_chat_message` events (`src/trpc/runtime-api.ts`, `app-router.ts`).
- UI: `ClineAgentChatPanel`, composer, message item, markdown, thinking indicator, and the hooks
  `use-cline-chat-session` / `-runtime-actions` / `-panel-controller`. Gate is
  `isNativeClineAgentSelected` (`web-ui/src/runtime/native-agent.ts`) used in `card-detail-view.tsx`.
- Backend store: `ClineMessageRepository` (in-memory + hydrate) and `cline-session-state.ts` helpers.
- Pi: `pi-session-log.ts` + `hooks pi-wrapper` already tail the session JSONL and parse entries.

The UI is mostly agent-agnostic already; the Cline-specific parts are the `isNativeClineAgentSelected` gate and the
tRPC handlers, which route to `clineTaskSessionService` only.

## Architecture
Introduce an `AgentChatBackend` interface (start, send, cancel, listMessages, onMessage, onSummary, dispose) that
`ClineTaskSessionService` already effectively satisfies, then add one backend per agent. Handlers in
`runtime-api.ts` pick the backend by task agent id. UI gate becomes `agentSupportsNativeChat(agentId)`.
Session summaries/state machine feed the same board transitions (review/in_progress) so hooks/reconciler keep working.

## Per-agent transport
| Agent | Transport | Notes |
|---|---|---|
| Claude | **Implemented:** `@anthropic-ai/claude-agent-sdk` `query()` in streaming-input mode, one long-lived query per task (`src/claude-chat/`). Agent id `claude-chat` sits beside terminal `claude`. Uses `claude` from PATH (falls back to the SDK-bundled binary). `interrupt()` cancels a turn and keeps the session; the resulting `error_during_execution` result is swallowed. Resume via `resume`/`sessionId`. | Reducer shapes match the CLI stream-json. Approvals not yet wired: `canUseTool` could drive approve/deny cards; non-autonomous mode currently has no prompt UI. |
| Codex | **Decided: `@openai/codex-sdk`** (`codex-chat`): one `codex exec` per turn, resume by thread id, full-item events (no token deltas). Implemented in `src/codex-chat/` on the shared `src/native-chat/` base. | No per-tool approval callback, so approvals would need `codex app-server`. Plan mode = read-only sandbox; autonomous = danger-full-access. |
| Pi | `pi --mode rpc` (stdin/stdout JSON) | AGENTS.md currently forbids `--mode json` for task sessions (keeps the TUI + JSONL watcher). Native chat would be a distinct opt-in mode, not a replacement of the TUI path; can also start read-only by rendering the JSONL the watcher already parses. |

## Phases
1. **Refactor (no behavior change):** extract `AgentChatBackend`, make handlers/UI gate agent-agnostic, wrap Cline.
2. **Claude backend** (best protocol, biggest payoff): spawn/stream-json adapter -> `RuntimeTaskChatMessage`,
   cancel (interrupt), image input, permission cards, summary/state mapping, session resume after restart.
3. **Pi backend:** rpc adapter; reuse `mapPiSessionEntry` for history hydration.
4. **Codex backend:** app-server adapter with generated types; approvals; resume.
5. **Settings/UX:** per-agent toggle "Chat view / Terminal view" (keep terminal as fallback and for TUI-only
   features: slash commands, dialogs); show a "Open terminal" escape hatch.

## Risks / open questions
- Loss of TUI-only features (slash commands, `/resume`, plugin dialogs, login flows) -> need terminal fallback.
- Hooks: Claude/Codex hook-based state (`Stop`, `PostToolUse`) is replaced by protocol events in chat mode; must not
  double-fire with hooks if both configured.
- Permission/approval UX must exist before autonomous-off mode is usable in chat view.
- Codex app-server and Pi rpc stability (experimental / version drift).
- Task worktree trust prompts (claude/codex/agenc trust files) still need pre-trusting.
- Auto-review commit prompt is typed into the terminal today; in chat mode it must go through `send`.
- Tests: Cline panel tests (1100 lines) are the template; each backend needs fake-process fixtures.

## Rough size
Phase 1 ~ small-medium; Claude ~ medium-large; Pi ~ medium; Codex ~ medium-large (protocol work);
Phase 5 ~ small. Recommend shipping Phase 1 + Claude first.
