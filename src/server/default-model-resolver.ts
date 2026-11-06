// Resolves the model an agent CLI runs when the task has no explicit model override, by
// reading the same user config the CLI itself reads. The usage recorder uses this so
// "default model" sessions are attributed to a real model name instead of "unknown".
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { RuntimeAgentId } from "../core/api-contract";
import { readPiDefaultModel } from "../pi-chat/pi-chat-task-session-service";

// Top-level `model = "..."` of ~/.codex/config.toml (keys under a [table] are not the default).
export function parseCodexConfigModel(toml: string): string | null {
	for (const line of toml.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("[")) {
			return null;
		}
		const match = /^model\s*=\s*["']([^"']+)["']/.exec(trimmed);
		if (match) {
			return match[1]?.trim() || null;
		}
	}
	return null;
}

async function readJsonStringField(path: string, field: string): Promise<string | null> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		const value = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>)[field] : null;
		return typeof value === "string" && value.trim() ? value.trim() : null;
	} catch {
		return null;
	}
}

async function readCodexDefaultModel(): Promise<string | null> {
	try {
		return parseCodexConfigModel(await readFile(join(homedir(), ".codex", "config.toml"), "utf8"));
	} catch {
		return null;
	}
}

async function readClaudeDefaultModel(): Promise<string | null> {
	return (
		(await readJsonStringField(join(homedir(), ".claude", "settings.json"), "model")) ??
		process.env.ANTHROPIC_MODEL?.trim() ??
		null
	);
}

async function readGeminiDefaultModel(): Promise<string | null> {
	return (await readJsonStringField(join(homedir(), ".gemini", "settings.json"), "model")) ?? null;
}

export async function resolveAgentDefaultModelId(agentId: RuntimeAgentId | null): Promise<string | null> {
	switch (agentId) {
		case "codex":
		case "codex-chat":
			return await readCodexDefaultModel();
		case "claude":
		case "claude-chat":
			return await readClaudeDefaultModel();
		case "pi":
		case "pi-chat":
			return await readPiDefaultModel();
		case "gemini":
			return await readGeminiDefaultModel();
		default:
			return null;
	}
}
