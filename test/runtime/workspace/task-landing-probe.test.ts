import { describe, expect, it } from "vitest";

import type { RuntimeBoardCard } from "../../../src/core/api-contract";
import { describeDoneMoveBlocker } from "../../../src/workspace/task-landing-probe";

const card = {
	id: "task-1",
	baseRef: "main",
} as RuntimeBoardCard;
const landed = { exists: true, headCommit: "a", changedFiles: 0, unlandedCommits: 0 };
const failedCheck = {
	status: "failed",
	command: "make test",
	exitCode: 1,
	timedOut: false,
	output: "",
	fingerprint: "s",
	retries: 1,
	startedAt: 1,
	finishedAt: 2,
} as const;

describe("describeDoneMoveBlocker", () => {
	it("allows a landed card and one with no worktree", () => {
		expect(describeDoneMoveBlocker(card, landed)).toBeNull();
		expect(describeDoneMoveBlocker(card, { exists: false, headCommit: null, changedFiles: 0 })).toBeNull();
	});

	it("blocks unlanded commits", () => {
		expect(describeDoneMoveBlocker(card, { ...landed, unlandedCommits: 2 })).toContain("2 commit(s)");
	});

	it("blocks when landing could not be verified", () => {
		expect(describeDoneMoveBlocker(card, { ...landed, unlandedCommits: undefined })).toContain("could not verify");
	});

	it("blocks uncommitted changes", () => {
		expect(describeDoneMoveBlocker(card, { ...landed, changedFiles: 1 })).toContain("uncommitted");
	});

	it("blocks a failed check", () => {
		expect(describeDoneMoveBlocker({ ...card, checkResult: failedCheck }, landed)).toContain("make test");
	});

	it("blocks a failed done check", () => {
		expect(
			describeDoneMoveBlocker({ ...card, doneCheckResult: { ...failedCheck, command: "sh notes.sh" } }, landed),
		).toContain("done check failed (sh notes.sh)");
	});
});
