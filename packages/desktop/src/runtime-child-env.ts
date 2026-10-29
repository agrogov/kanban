/**
 * Environment and PATH policy for the Kanban CLI subprocess.
 *
 * Isolated from runtime-child.ts so the process-lifecycle code stays
 * focused on spawn/poll/kill concerns. Two policy decisions live here:
 *
 *   1. Which env vars are forwarded to the child. All parent env vars
 *      are forwarded by default (matching VS Code's model). Agent shells
 *      inherit the full environment.
 *   2. Which platform-specific directories are appended to PATH. GUI-
 *      launched processes on macOS/Linux/Windows inherit a minimal PATH
 *      that typically omits Homebrew, npm-global, nvm, Git for Windows,
 *      etc. Agent shells need those binaries findable by name.
 */

import { execFile } from "node:child_process";
import path, { join } from "node:path";

const SHELL_PATH_MARKER = "__KANBAN_SHELL_PATH__";
const SHELL_PATH_TIMEOUT_MS = 5_000;

let cachedLoginShellPath: Promise<string | null> | null = null;

/**
 * Resolve the PATH the user's login shell would have. Finder/Dock launches
 * never see the PATH exported from ~/.zshrc / ~/.zprofile, so agent CLIs
 * installed in e.g. ~/.local/bin are invisible without this. Runs the shell
 * once per app session (cached), with a timeout, off the hot path.
 */
export function resolveLoginShellPath(): Promise<string | null> {
	if (process.platform === "win32") return Promise.resolve(null);
	if (cachedLoginShellPath) return cachedLoginShellPath;
	const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
	cachedLoginShellPath = new Promise<string | null>((resolve) => {
		execFile(
			shell,
			["-ilc", `printf '%s' "${SHELL_PATH_MARKER}\${PATH}${SHELL_PATH_MARKER}"`],
			{ timeout: SHELL_PATH_TIMEOUT_MS, env: process.env },
			(error, stdout) => {
				const match = new RegExp(`${SHELL_PATH_MARKER}(.*)${SHELL_PATH_MARKER}`, "s").exec(stdout ?? "");
				resolve(error && !match ? null : (match?.[1]?.trim() || null));
			},
		);
	});
	return cachedLoginShellPath;
}

/**
 * Windows-specific PATH dirs that depend on per-user environment variables
 * (APPDATA / LOCALAPPDATA / ProgramFiles). Separated from the macOS/Linux
 * static list into a function purely for readability; the env vars are read
 * once when this module is imported, same as the POSIX constants below.
 */
function getWindowsExtraPathDirs(): string[] {
	const dirs: string[] = [];
	const localAppData = process.env.LOCALAPPDATA;
	const appData = process.env.APPDATA;
	const programFiles = process.env.ProgramFiles;
	const programFilesX86 = process.env["ProgramFiles(x86)"];
	if (appData) dirs.push(join(appData, "npm")); // npm global
	if (localAppData) {
		dirs.push(join(localAppData, "Programs", "nodejs"));
		// WinGet places shim executables in `…\WinGet\Links\` (not
		// `…\WinGet\Packages\`, which holds install directories that
		// aren't directly on PATH).
		dirs.push(join(localAppData, "Microsoft", "WinGet", "Links"));
	}
	if (programFiles) dirs.push(join(programFiles, "Git", "cmd"));
	if (programFilesX86) dirs.push(join(programFilesX86, "Git", "cmd"));
	return dirs;
}

/**
 * Directories appended to PATH for GUI-launched desktop processes.
 * macOS launchd and Linux desktop-file launches typically give minimal
 * PATHs; these ensure Homebrew, Snap, Git, etc. are findable.
 */
const EXTRA_PATH_DIRS: readonly string[] =
	process.platform === "darwin"
		? [
				"/opt/homebrew/bin",
				"/opt/homebrew/sbin",
				"/usr/local/bin",
				"/usr/local/sbin",
				"/usr/bin",
				"/bin",
				"/usr/sbin",
				"/sbin",
			]
		: process.platform === "linux"
			? ["/usr/local/bin", "/snap/bin", "/usr/bin", "/bin"]
			: process.platform === "win32"
				? getWindowsExtraPathDirs()
				: [];

/**
 * Build an enriched copy of process.env with PATH augmented for GUI-launched
 * processes. All parent environment variables are forwarded by default.
 */
export function buildFilteredEnv(loginShellPath: string | null = null): NodeJS.ProcessEnv {
	// Forward all parent env vars (matching VS Code's model)
	const filtered: NodeJS.ProcessEnv = { ...process.env };

	// The user's login-shell PATH goes first so their tool locations win,
	// then whatever the GUI launch inherited, then common platform dirs.
	const pathParts = new Set<string>();
	for (const source of [loginShellPath ?? "", filtered.PATH ?? ""]) {
		for (const dir of source.split(path.delimiter)) {
			if (dir) pathParts.add(dir);
		}
	}
	for (const dir of EXTRA_PATH_DIRS) pathParts.add(dir);
	if (pathParts.size > 0) {
		filtered.PATH = [...pathParts].join(path.delimiter);
	}

	return filtered;
}
