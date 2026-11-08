// Answers one question about a task worktree: has everything in it reached the base ref?
// Shared by the auto-review reconciler and the CLI's guard on moving a card to done.

import type { RuntimeBoardCard } from "../core/api-contract";
import { probeGitWorkspaceState } from "./git-sync";
import { runGit } from "./git-utils";
import { getTaskWorkspacePathInfo } from "./task-worktree";

/** Git metadata for one task worktree, probed on demand. */
export interface TaskLandingProbe {
	exists: boolean;
	headCommit: string | null;
	changedFiles: number;
	/**
	 * Commits in the task worktree that have not landed on the base ref yet (patch-equivalent
	 * commits already cherry-picked there do not count). Covers agents that commit their own work,
	 * which leaves a clean tree that would otherwise look like "nothing to do".
	 *
	 * `undefined` means unknown (the git probe failed), which is deliberately distinct from `0`.
	 */
	unlandedCommits?: number;
	/** Fingerprint of HEAD plus the working tree; changes whenever the task's content changes. */
	stateToken?: string;
}

export async function probeTaskLanding(input: {
	workspacePath: string;
	taskId: string;
	baseRef: string;
}): Promise<TaskLandingProbe> {
	const pathInfo = await getTaskWorkspacePathInfo({
		cwd: input.workspacePath,
		taskId: input.taskId,
		baseRef: input.baseRef,
	});
	if (!pathInfo.exists) {
		return { exists: false, headCommit: null, changedFiles: 0 };
	}
	const [probe, unlandedCommits] = await Promise.all([
		probeGitWorkspaceState(pathInfo.path),
		countUnlandedCommits(pathInfo.path, input.baseRef),
	]);
	return {
		exists: true,
		headCommit: probe.headCommit,
		changedFiles: probe.changedFiles,
		unlandedCommits,
		stateToken: probe.stateToken,
	};
}

/** Why a card may not be moved to done, or `null` when nothing would be lost by moving it. */
export function describeDoneMoveBlocker(card: RuntimeBoardCard, probe: TaskLandingProbe): string | null {
	if (!probe.exists) {
		return null;
	}
	if (probe.unlandedCommits === undefined) {
		return `could not verify that its commits reached ${card.baseRef}`;
	}
	if (probe.unlandedCommits > 0) {
		return `${probe.unlandedCommits} commit(s) have not landed on ${card.baseRef}`;
	}
	if (probe.changedFiles > 0) {
		return `${probe.changedFiles} file(s) have uncommitted changes`;
	}
	if (card.checkResult?.status === "failed") {
		return `its check failed (${card.checkResult.command})`;
	}
	return null;
}

export async function countUnlandedCommits(worktreePath: string, baseRef: string): Promise<number | undefined> {
	// `git cherry` prefixes commits missing from the base with "+" and patch-equivalent ones with "-".
	const result = await runGit(worktreePath, ["cherry", baseRef, "HEAD"]);
	if (!result.ok) {
		// Unknown must not collapse into zero: `0` means "nothing left to land", which completes the
		// card and deletes the worktree. On a transient git failure that would destroy unlanded work.
		return undefined;
	}
	const missing = result.stdout
		.split("\n")
		.filter((line) => line.startsWith("+"))
		.map((line) => line.slice(1).trim());
	if (missing.length === 0) {
		return 0;
	}
	// A cherry-pick whose conflicts were resolved by hand has a different patch id, so `git cherry`
	// reports it as missing forever. Cherry-pick keeps author, author date and subject: match on those.
	// Trade-off: two genuinely distinct commits that share author, author date and subject (rebase or
	// squash-and-recommit flows) become indistinguishable, so one can vouch for the other.
	const identities = await Promise.all(missing.map((sha) => readCommitIdentity(worktreePath, sha)));
	const baseIdentities = await readBaseIdentities(worktreePath, baseRef, identities);
	// A failed identity read yields `null` and a failed base log yields an empty set, so both errors
	// keep the commit counted as unlanded.
	return identities.filter((identity) => identity === null || !baseIdentities.has(identity)).length;
}

const COMMIT_IDENTITY_FORMAT = "%an%x00%at%x00%s";

async function readCommitIdentity(worktreePath: string, sha: string): Promise<string | null> {
	const result = await runGit(worktreePath, ["log", "-1", `--format=${COMMIT_IDENTITY_FORMAT}`, sha]);
	return result.ok ? result.stdout.trim() : null;
}

async function readBaseIdentities(
	worktreePath: string,
	baseRef: string,
	identities: (string | null)[],
): Promise<Set<string>> {
	const earliest = Math.min(
		...identities.map((identity) => Number(identity?.split("\0")[1] ?? Number.POSITIVE_INFINITY)),
	);
	if (!Number.isFinite(earliest)) {
		return new Set();
	}
	const result = await runGit(worktreePath, [
		"log",
		baseRef,
		`--since=${earliest - 1}`,
		`--format=${COMMIT_IDENTITY_FORMAT}`,
	]);
	// --since filters on committer date, which is always >= the author date of a cherry-pick.
	return new Set(result.ok ? result.stdout.split("\n").filter(Boolean) : []);
}
