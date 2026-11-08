import { describe, expect, it } from "vitest";

import { buildCheckFailurePrompt, runCheckCommand } from "../../../src/server/auto-review-check";

function run(command: string, timeoutMs = 10_000, signal = new AbortController().signal) {
	return runCheckCommand({ cwd: process.cwd(), command, timeoutMs, signal });
}

describe("runCheckCommand", () => {
	it("reports a passing command", async () => {
		await expect(run("echo fine")).resolves.toEqual({ exitCode: 0, timedOut: false, output: "fine\n" });
	});

	it("reports the exit code and includes stderr", async () => {
		const outcome = await run("echo broken 1>&2; exit 3");

		expect(outcome.exitCode).toBe(3);
		expect(outcome.timedOut).toBe(false);
		expect(outcome.output).toContain("broken");
	});

	it("kills the whole process tree on timeout", async () => {
		const startedAt = Date.now();

		const outcome = await run("sleep 30 & wait", 200);

		expect(outcome.timedOut).toBe(true);
		expect(outcome.exitCode).not.toBe(0);
		expect(Date.now() - startedAt).toBeLessThan(5_000);
	});

	it("stops when aborted", async () => {
		const controller = new AbortController();
		const pending = run("sleep 30", 60_000, controller.signal);

		setTimeout(() => controller.abort(), 100);
		const outcome = await pending;

		expect(outcome.exitCode).not.toBe(0);
		expect(outcome.timedOut).toBe(false);
	});

	it("does not wait for a daemon that inherited the output pipes", async () => {
		const startedAt = Date.now();

		const outcome = await run("sleep 30 & exit 0");

		expect(outcome.exitCode).toBe(0);
		expect(Date.now() - startedAt).toBeLessThan(5_000);
	});

	it("strips terminal control sequences and keeps only the tail", async () => {
		const outcome = await run(
			`printf '\\033[31mred\\033[0m\\007\\n'; head -c 20000 /dev/zero | tr '\\0' x; printf END`,
		);

		expect(outcome.output.length).toBeLessThanOrEqual(4_000);
		expect(outcome.output.endsWith("END")).toBe(true);
		const short = await run(`printf '\\033[31mred\\033[0m\\007'`);
		expect(short.output).toBe("red");
	});
});

describe("buildCheckFailurePrompt", () => {
	it("names the command, the result and the output", () => {
		const prompt = buildCheckFailurePrompt("make test", { exitCode: 2, timedOut: false, output: "failed here" });

		expect(prompt).toContain("Command: make test");
		expect(prompt).toContain("Exit code: 2.");
		expect(prompt).toContain("failed here");
		expect(prompt).toContain("do not commit");
	});

	it("says so when the check timed out", () => {
		const prompt = buildCheckFailurePrompt("make test", { exitCode: null, timedOut: true, output: "" });

		expect(prompt).toContain("It timed out.");
		expect(prompt).toContain("(no output)");
	});
});
