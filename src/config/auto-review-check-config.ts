// The optional per-project commands Kanban runs around an auto-review card's commit:
// - `autoReviewCheck` runs before the commit; a failure goes back to the task's agent.
// - `autoReviewDoneCheck` runs after the commit has landed; a failure keeps the card in review,
//   so the cards linked after it do not start. Nothing is sent to the agent.
// Read straight from the project config on demand, so edits apply without a runtime restart.

import { readFile } from "node:fs/promises";
import { z } from "zod";

import { getRuntimeProjectConfigPath } from "./runtime-config";

const DEFAULT_CHECK_TIMEOUT_MINUTES = 30;
const DEFAULT_CHECK_MAX_RETRIES = 1;
const DEFAULT_DONE_CHECK_TIMEOUT_MINUTES = 10;

const autoReviewCheckFileSchema = z.object({
	command: z.string().trim().min(1),
	timeoutMinutes: z.number().positive().default(DEFAULT_CHECK_TIMEOUT_MINUTES),
	/** How many times a failure is sent back to the task's agent. `0` disables the retry. */
	maxRetries: z.number().int().nonnegative().default(DEFAULT_CHECK_MAX_RETRIES),
});

const autoReviewDoneCheckFileSchema = z.object({
	command: z.string().trim().min(1),
	timeoutMinutes: z.number().positive().default(DEFAULT_DONE_CHECK_TIMEOUT_MINUTES),
});

export interface AutoReviewCheckConfig {
	command: string;
	timeoutMs: number;
	maxRetries: number;
}

export function parseAutoReviewCheckConfig(raw: unknown): AutoReviewCheckConfig {
	const parsed = autoReviewCheckFileSchema.parse(raw);
	return {
		command: parsed.command,
		timeoutMs: parsed.timeoutMinutes * 60_000,
		maxRetries: parsed.maxRetries,
	};
}

export interface AutoReviewDoneCheckConfig {
	command: string;
	timeoutMs: number;
}

export function parseAutoReviewDoneCheckConfig(raw: unknown): AutoReviewDoneCheckConfig {
	const parsed = autoReviewDoneCheckFileSchema.parse(raw);
	return { command: parsed.command, timeoutMs: parsed.timeoutMinutes * 60_000 };
}

/** The raw value of one project config key, or `undefined` when the file or the key is missing. */
async function readProjectConfigKey(workspacePath: string, key: string): Promise<unknown> {
	let text: string;
	try {
		text = await readFile(getRuntimeProjectConfigPath(workspacePath), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
	const file = JSON.parse(text) as Record<string, unknown> | null;
	return file?.[key];
}

/**
 * Returns `null` when the project has no check. Throws when one is configured but unreadable:
 * the caller must hold cards rather than merge unchecked work because of a typo in the config.
 */
export async function loadAutoReviewCheckConfig(workspacePath: string): Promise<AutoReviewCheckConfig | null> {
	const raw = await readProjectConfigKey(workspacePath, "autoReviewCheck");
	return raw === undefined ? null : parseAutoReviewCheckConfig(raw);
}

/**
 * Returns `null` when the project has no done check. Throws when one is configured but unreadable:
 * the caller must hold landed cards rather than start their dependents unchecked.
 */
export async function loadAutoReviewDoneCheckConfig(workspacePath: string): Promise<AutoReviewDoneCheckConfig | null> {
	const raw = await readProjectConfigKey(workspacePath, "autoReviewDoneCheck");
	return raw === undefined ? null : parseAutoReviewDoneCheckConfig(raw);
}
