// Pure reducer from Codex SDK thread events to Kanban chat messages. Codex emits whole-item
// snapshots (no token deltas), so text items are created once and then updated in place.
// Process and state-machine concerns live in codex-chat-task-session-service.ts.
import type { ThreadEvent, ThreadItem } from "@openai/codex-sdk";
import {
	type ClineTaskMessage,
	type ClineTaskSessionEntry,
	clearActiveTurnState,
	createAssistantMessage,
	createMessage,
	createReasoningMessage,
	finishToolCallMessage,
	startToolCallMessage,
	updateMessageInEntry,
} from "../cline-sdk/cline-session-state";

export interface CodexReducerState {
	/** Chat message id per Codex item id, for items rendered as one updatable message. */
	messageIdByItemId: Map<string, string>;
	/** Tool-card item ids whose card is already open. */
	openToolItemIds: Set<string>;
	lastAgentText: string | null;
}

export function createCodexReducerState(): CodexReducerState {
	return { messageIdByItemId: new Map(), openToolItemIds: new Set(), lastAgentText: null };
}

export interface CodexTurnResult {
	isError: boolean;
	text: string | null;
}

export interface CodexReduction {
	changedMessages: ClineTaskMessage[];
	threadId?: string;
	turnResult?: CodexTurnResult;
}

interface ToolDescription {
	toolName: string;
	input: unknown;
	/** Present once the item has finished. */
	result?: { output: unknown; error: string | null };
}

function describeTool(item: ThreadItem): ToolDescription | null {
	switch (item.type) {
		case "command_execution": {
			const finished = item.status !== "in_progress";
			const failed = item.status === "failed" || (item.exit_code !== undefined && item.exit_code !== 0);
			return {
				toolName: "Bash",
				input: { command: item.command },
				result: finished
					? {
							output: item.aggregated_output,
							error: failed ? `Command exited with code ${item.exit_code ?? "unknown"}` : null,
						}
					: undefined,
			};
		}
		case "file_change":
			return {
				toolName: "apply_patch",
				input: { changes: item.changes.map((change) => `${change.kind} ${change.path}`) },
				result: { output: "", error: item.status === "failed" ? "Patch failed" : null },
			};
		case "mcp_tool_call":
			return {
				toolName: `${item.server}__${item.tool}`,
				input: item.arguments,
				result:
					item.status === "in_progress"
						? undefined
						: { output: item.result ?? "", error: item.error?.message ?? null },
			};
		case "web_search":
			return { toolName: "WebSearch", input: { query: item.query } };
		case "todo_list":
			return {
				toolName: "update_plan",
				input: { items: item.items.map((todo) => `${todo.completed ? "[x]" : "[ ]"} ${todo.text}`) },
			};
		default:
			return null;
	}
}

function reduceTextItem(
	taskId: string,
	entry: ClineTaskSessionEntry,
	state: CodexReducerState,
	item: Extract<ThreadItem, { type: "agent_message" | "reasoning" }>,
	changedMessages: ClineTaskMessage[],
): void {
	if (item.type === "agent_message") {
		state.lastAgentText = item.text;
	}
	const existingId = state.messageIdByItemId.get(item.id);
	if (existingId) {
		const updated = updateMessageInEntry(entry, existingId, (current) =>
			current.content === item.text ? current : { ...current, content: item.text },
		);
		if (updated) {
			changedMessages.push(updated);
		}
		return;
	}
	if (item.text.length === 0) {
		return;
	}
	const message =
		item.type === "agent_message"
			? createAssistantMessage(entry, taskId, item.text)
			: createReasoningMessage(entry, taskId, item.text, "reasoning");
	entry.activeAssistantMessageId = null;
	entry.activeReasoningMessageId = null;
	state.messageIdByItemId.set(item.id, message.id);
	changedMessages.push(message);
}

function reduceToolItem(
	taskId: string,
	entry: ClineTaskSessionEntry,
	state: CodexReducerState,
	item: ThreadItem,
	completed: boolean,
	changedMessages: ClineTaskMessage[],
): void {
	const tool = describeTool(item);
	if (!tool) {
		return;
	}
	if (!state.openToolItemIds.has(item.id)) {
		state.openToolItemIds.add(item.id);
		changedMessages.push(
			startToolCallMessage(entry, taskId, { toolName: tool.toolName, toolCallId: item.id, input: tool.input }),
		);
	}
	// Items without a status (web search, todo list) finish when the item completes.
	const result = tool.result ?? (completed ? { output: "", error: null } : undefined);
	if (result) {
		changedMessages.push(
			finishToolCallMessage(entry, taskId, {
				toolName: tool.toolName,
				toolCallId: item.id,
				output: result.output,
				error: result.error,
				durationMs: null,
			}),
		);
	}
}

export function reduceCodexEvent(
	taskId: string,
	entry: ClineTaskSessionEntry,
	state: CodexReducerState,
	event: ThreadEvent,
): CodexReduction {
	const changedMessages: ClineTaskMessage[] = [];
	const reduction: CodexReduction = { changedMessages };
	switch (event.type) {
		case "thread.started":
			reduction.threadId = event.thread_id;
			return reduction;
		case "item.started":
		case "item.updated":
		case "item.completed": {
			const item = event.item;
			if (item.type === "agent_message" || item.type === "reasoning") {
				reduceTextItem(taskId, entry, state, item, changedMessages);
			} else if (item.type === "error") {
				const message = createMessage(taskId, "system", item.message);
				entry.messages.push(message);
				changedMessages.push(message);
			} else {
				reduceToolItem(taskId, entry, state, item, event.type === "item.completed", changedMessages);
			}
			return reduction;
		}
		case "turn.completed":
			clearActiveTurnState(entry);
			reduction.turnResult = { isError: false, text: state.lastAgentText };
			return reduction;
		case "turn.failed":
			clearActiveTurnState(entry);
			reduction.turnResult = { isError: true, text: event.error.message };
			return reduction;
		case "error":
			clearActiveTurnState(entry);
			reduction.turnResult = { isError: true, text: event.message };
			return reduction;
		default:
			return reduction;
	}
}
