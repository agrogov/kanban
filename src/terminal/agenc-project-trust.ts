// Pre-trusts Kanban task worktrees in AgenC's own trust store so `agenc` starts without its
// per-project trust card (and headless runs are not refused). Mirrors the on-disk contract of
// agenc-core runtime/src/permissions/trust/project-trust.ts: `$AGENC_HOME/trusted-projects.json`,
// version 1, guarded by an exclusive `<file>.lock`, written atomically with mode 0600.
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { runGit } from "../workspace/git-utils";

const TRUSTED_PROJECTS_FILENAME = "trusted-projects.json";
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_POLL_MS = 25;
const STALE_LOCK_MS = 30_000;
// AgenC's default project_root_markers; a task worktree has a `.git` file at its root.
const PROJECT_ROOT_MARKER = ".git";

interface TrustedProjectsFile {
	version: 1;
	trustedProjects: Array<{ path: string; trustedAt: string }>;
	[key: string]: unknown;
}

export function resolveAgencHomePath(env: Record<string, string | undefined> = process.env): string {
	const configured = env.AGENC_HOME?.trim();
	return configured ? resolve(configured) : join(homedir(), ".agenc");
}

function canonicalizePath(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync.native(absolute);
	} catch {
		return absolute;
	}
}

export function resolveAgencProjectRoot(cwd: string): string {
	let current = resolve(cwd);
	const { root } = parse(current);
	for (;;) {
		if (existsSync(join(current, PROJECT_ROOT_MARKER))) {
			return canonicalizePath(current);
		}
		if (current === root) {
			return canonicalizePath(cwd);
		}
		current = dirname(current);
	}
}

function isFileExistsError(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EEXIST";
}

async function removeLockIfStale(lockPath: string): Promise<boolean> {
	try {
		const parsed = JSON.parse(await readFile(lockPath, "utf8")) as { acquiredAt?: string };
		const acquiredAt = parsed.acquiredAt ? Date.parse(parsed.acquiredAt) : Number.NaN;
		if (Number.isNaN(acquiredAt) || Date.now() - acquiredAt < STALE_LOCK_MS) {
			return false;
		}
		await unlink(lockPath);
		return true;
	} catch {
		return false;
	}
}

async function withExclusiveLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
	await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
	const startedAt = Date.now();
	for (;;) {
		try {
			const handle = await open(lockPath, "wx", 0o600);
			try {
				await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`);
			} finally {
				await handle.close();
			}
			break;
		} catch (error) {
			if (!isFileExistsError(error)) {
				throw error;
			}
			if (await removeLockIfStale(lockPath)) {
				continue;
			}
			if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
				throw new Error(`Timed out waiting for AgenC project trust lock at ${lockPath}.`);
			}
			await new Promise((resolveWait) => setTimeout(resolveWait, LOCK_POLL_MS));
		}
	}
	try {
		return await operation();
	} finally {
		await unlink(lockPath).catch(() => undefined);
	}
}

async function readTrustedProjectsFile(path: string): Promise<TrustedProjectsFile> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (typeof parsed === "object" && parsed !== null && (parsed as { version?: unknown }).version === 1) {
			const file = parsed as TrustedProjectsFile;
			return { ...file, trustedProjects: Array.isArray(file.trustedProjects) ? file.trustedProjects : [] };
		}
	} catch {
		// Missing or unreadable: start from an empty store.
	}
	return { version: 1, trustedProjects: [] };
}

/** Records `cwd`'s project root as trusted in AgenC's store. Returns the root that was trusted. */
export async function ensureAgencProjectTrusted(
	cwd: string,
	env: Record<string, string | undefined> = process.env,
): Promise<string> {
	const projectRoot = resolveAgencProjectRoot(cwd);
	const storePath = join(resolveAgencHomePath(env), TRUSTED_PROJECTS_FILENAME);
	await withExclusiveLock(`${storePath}.lock`, async () => {
		const current = await readTrustedProjectsFile(storePath);
		if (current.trustedProjects.some((entry) => canonicalizePath(entry.path) === projectRoot)) {
			return;
		}
		const next: TrustedProjectsFile = {
			...current,
			trustedProjects: [...current.trustedProjects, { path: projectRoot, trustedAt: new Date().toISOString() }],
		};
		const tmpPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
		await rename(tmpPath, storePath);
		await chmod(storePath, 0o600).catch(() => undefined);
	});
	return projectRoot;
}

// AgenC keeps its Go/lint build caches in this folder inside the workspace. Left untracked it is
// counted as millions of added lines and would be swept into auto-commits.
const AGENC_CACHE_EXCLUDE_ENTRY = "/.agenc-cache/";

/** Adds AgenC's in-workspace cache folder to the repo's local git excludes (shared by all worktrees). */
export async function ensureAgencCacheGitExcluded(cwd: string): Promise<void> {
	const result = await runGit(cwd, ["rev-parse", "--git-path", "info/exclude"]);
	if (!result.ok || !result.stdout) {
		return;
	}
	const excludePath = isAbsolute(result.stdout) ? result.stdout : join(cwd, result.stdout);
	const existing = await readFile(excludePath, "utf8").catch(() => "");
	if (existing.split("\n").some((line) => line.trim() === AGENC_CACHE_EXCLUDE_ENTRY)) {
		return;
	}
	await mkdir(dirname(excludePath), { recursive: true });
	const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
	await writeFile(excludePath, `${existing}${separator}${AGENC_CACHE_EXCLUDE_ENTRY}\n`);
}
