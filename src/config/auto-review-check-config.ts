// The optional per-project command Kanban runs before an auto-review card is committed.
// Read straight from the project config on demand, so edits apply without a runtime restart.

import { readFile } from "node:fs/promises";
import { z } from "zod";

import { getRuntimeProjectConfigPath } from "./runtime-config";

const DEFAULT_CHECK_TIMEOUT_MINUTES = 30;
const DEFAULT_CHECK_MAX_RETRIES = 1;

const autoReviewCheckFileSchema = z.object({
	command: z.string().trim().min(1),
	timeoutMinutes: z.number().positive().default(DEFAULT_CHECK_TIMEOUT_MINUTES),
	/** How many times a failure is sent back to the task's agent. `0` disables the retry. */
	maxRetries: z.number().int().nonnegative().default(DEFAULT_CHECK_MAX_RETRIES),
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

/**
 * Returns `null` when the project has no check. Throws when one is configured but unreadable:
 * the caller must hold cards rather than merge unchecked work because of a typo in the config.
 */
export async function loadAutoReviewCheckConfig(workspacePath: string): Promise<AutoReviewCheckConfig | null> {
	let text: string;
	try {
		text = await readFile(getRuntimeProjectConfigPath(workspacePath), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw error;
	}
	const file = JSON.parse(text) as { autoReviewCheck?: unknown } | null;
	if (file?.autoReviewCheck === undefined) {
		return null;
	}
	return parseAutoReviewCheckConfig(file.autoReviewCheck);
}
