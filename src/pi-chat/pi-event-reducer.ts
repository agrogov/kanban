// Pure reducer from Pi SDK session events to Kanban chat messages. Pi streams text and thinking
// as deltas inside `message_update` and reports tools through `tool_execution_*` events.
// Session and state-machine concerns live in pi-chat-task-session-service.ts.
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
	appendAssistantChunk,
	appendReasoningChunk,
	type ClineTaskMessage,
	type ClineTaskSessionEntry,
	finishToolCallMessage,
	setOrCreateAssistantMessage,
	setOrCreateReasoningMessage,
	startToolCallMessage,
} from "../cline-sdk/cline-session-state";

export interface PiReducerState {
	lastAssistantText: string | null;
	/** Error reported by the last assistant message (Pi surfaces provider failures this way). */
	lastError: string | null;
}

export function createPiReducerState(): PiReducerState {
	return { lastAssistantText: null, lastError: null };
}

export interface PiReduction {
	changedMessages: ClineTaskMessage[];
}

interface ContentBlock {
	type: string;
	text?: string;
}

function textOfToolResult(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}
	if (result && typeof result === "object" && "content" in result && Array.isArray(result.content)) {
		return (result.content as ContentBlock[])
			.map((block) => (block.type === "text" ? (block.text ?? "") : ""))
			.filter(Boolean)
			.join("\n");
	}
	return result === undefined || result === null ? "" : JSON.stringify(result);
}

function textOfAssistantMessage(message: { content?: unknown }): string {
	if (!Array.isArray(message.content)) {
		return "";
	}
	return (message.content as ContentBlock[])
		.map((block) => (block.type === "text" ? (block.text ?? "") : ""))
		.join("")
		.trim();
}

export function reducePiEvent(
	taskId: string,
	entry: ClineTaskSessionEntry,
	state: PiReducerState,
	event: AgentSessionEvent,
): PiReduction {
	const changed: ClineTaskMessage[] = [];
	const push = (message: ClineTaskMessage | null) => {
		if (message) {
			changed.push(message);
		}
	};

	switch (event.type) {
		case "message_update": {
			const update = event.assistantMessageEvent;
			switch (update.type) {
				case "text_start":
					entry.activeAssistantMessageId = null;
					break;
				case "text_delta":
					push(appendAssistantChunk(entry, taskId, update.delta));
					break;
				case "text_end":
					push(setOrCreateAssistantMessage(entry, taskId, update.content));
					entry.activeAssistantMessageId = null;
					break;
				case "thinking_start":
					entry.activeReasoningMessageId = null;
					break;
				case "thinking_delta":
					push(appendReasoningChunk(entry, taskId, update.delta));
					break;
				case "thinking_end":
					push(setOrCreateReasoningMessage(entry, taskId, update.content));
					entry.activeReasoningMessageId = null;
					break;
				default:
					break;
			}
			break;
		}
		case "message_end": {
			const message = event.message;
			if (message.role === "assistant") {
				const text = textOfAssistantMessage(message);
				if (text) {
					state.lastAssistantText = text;
				}
				state.lastError = message.stopReason === "error" ? (message.errorMessage ?? "Pi request failed.") : null;
			}
			break;
		}
		case "tool_execution_start":
			push(
				startToolCallMessage(entry, taskId, {
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					input: event.args,
				}),
			);
			break;
		case "tool_execution_end": {
			const output = textOfToolResult(event.result);
			push(
				finishToolCallMessage(entry, taskId, {
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					output,
					error: event.isError ? output || "Tool failed" : null,
					durationMs: event.durationMs ?? null,
				}),
			);
			break;
		}
		default:
			break;
	}
	return { changedMessages: changed };
}
