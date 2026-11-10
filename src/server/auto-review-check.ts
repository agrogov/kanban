// Runs a project's check command inside a task worktree and reports the exit code.
// The output is kept only as a capped, printable tail: it is persisted on the card and can be
// pasted into an agent's terminal, where escape sequences would be interpreted.

import { type ChildProcess, spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";

const CHECK_OUTPUT_TAIL_CHARS = 4_000;
const CHECK_KILL_GRACE_MS = 5_000;
/** Lets buffered output arrive after exit, without waiting on a daemon that inherited the pipes. */
const CHECK_OUTPUT_DRAIN_MS = 250;

export interface AutoReviewCheckOutcome {
	exitCode: number | null;
	timedOut: boolean;
	output: string;
}

export interface RunAutoReviewCheckInput {
	workspacePath: string;
	taskId: string;
	baseRef: string;
	command: string;
	timeoutMs: number;
	signal: AbortSignal;
	/** Added to the runtime's environment, so a command can tell which card it is judging. */
	env?: Record<string, string>;
}

/** What a check command learns about its card. The title is the one shown on the board. */
export function buildTaskCheckEnv(input: {
	workspacePath: string;
	taskId: string;
	title: string;
	baseRef: string;
}): Record<string, string> {
	return {
		KANBAN_TASK_ID: input.taskId,
		KANBAN_TASK_TITLE: input.title,
		KANBAN_BASE_REF: input.baseRef,
		KANBAN_PROJECT_PATH: input.workspacePath,
	};
}

function toPrintableTail(text: string): string {
	const printable = Array.from(stripVTControlCharacters(text))
		.filter((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code === 9 || code === 10 || (code >= 32 && code !== 127);
		})
		.join("");
	return printable.slice(-CHECK_OUTPUT_TAIL_CHARS);
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
	if (process.platform !== "win32" && child.pid) {
		try {
			// A negative pid addresses the group, so build tools started by the shell die with it.
			process.kill(-child.pid, signal);
			return;
		} catch {
			// The group is already gone; fall through to the direct kill.
		}
	}
	child.kill(signal);
}

export function runCheckCommand(input: {
	cwd: string;
	command: string;
	timeoutMs: number;
	signal: AbortSignal;
	env?: Record<string, string>;
}): Promise<AutoReviewCheckOutcome> {
	return new Promise((resolve) => {
		const child = spawn(input.command, {
			cwd: input.cwd,
			env: input.env ? { ...process.env, ...input.env } : process.env,
			shell: true,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let timedOut = false;
		let settled = false;
		let killTimer: NodeJS.Timeout | null = null;
		let drainTimer: NodeJS.Timeout | null = null;

		const appendOutput = (chunk: string): void => {
			// Twice the tail, so sanitizing cannot leave less than a full tail.
			output = `${output}${chunk}`.slice(-CHECK_OUTPUT_TAIL_CHARS * 2);
		};
		const terminate = (): void => {
			signalProcessTree(child, "SIGTERM");
			killTimer = setTimeout(() => signalProcessTree(child, "SIGKILL"), CHECK_KILL_GRACE_MS);
			killTimer.unref();
		};
		const timeoutTimer = setTimeout(() => {
			timedOut = true;
			terminate();
		}, input.timeoutMs);
		timeoutTimer.unref();
		input.signal.addEventListener("abort", terminate, { once: true });

		const settle = (exitCode: number | null, extraOutput = ""): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeoutTimer);
			if (killTimer) {
				clearTimeout(killTimer);
			}
			if (drainTimer) {
				clearTimeout(drainTimer);
			}
			input.signal.removeEventListener("abort", terminate);
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve({ exitCode, timedOut, output: toPrintableTail(`${output}${extraOutput}`) });
		};

		child.stdout?.setEncoding("utf8").on("data", appendOutput);
		child.stderr?.setEncoding("utf8").on("data", appendOutput);
		child.on("error", (error) => settle(null, `\n${error.message}`));
		child.on("close", (exitCode) => settle(exitCode));
		child.on("exit", (exitCode) => {
			drainTimer = setTimeout(() => settle(exitCode), CHECK_OUTPUT_DRAIN_MS);
			drainTimer.unref();
		});
	});
}

export async function runAutoReviewCheck(input: RunAutoReviewCheckInput): Promise<AutoReviewCheckOutcome> {
	const pathInfo = await getTaskWorkspacePathInfo({
		cwd: input.workspacePath,
		taskId: input.taskId,
		baseRef: input.baseRef,
	});
	if (!pathInfo.exists) {
		return { exitCode: null, timedOut: false, output: "The task worktree no longer exists." };
	}
	return await runCheckCommand({
		cwd: pathInfo.path,
		command: input.command,
		timeoutMs: input.timeoutMs,
		signal: input.signal,
		env: input.env,
	});
}

export function buildCheckFailurePrompt(command: string, outcome: AutoReviewCheckOutcome): string {
	const result = outcome.timedOut ? "It timed out." : `Exit code: ${outcome.exitCode ?? "none"}.`;
	return [
		"The project check failed, so Kanban did not commit this work.",
		"",
		`Command: ${command}`,
		result,
		"",
		"Last output:",
		outcome.output || "(no output)",
		"",
		"Fix the cause. Do not weaken, skip or remove the check or its tests, and do not commit. When you stop, Kanban re-runs the check and handles the commit itself.",
	].join("\n");
}
