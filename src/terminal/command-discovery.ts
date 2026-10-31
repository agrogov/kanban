import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

function canAccessPath(path: string): boolean {
	try {
		accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function getWindowsExecutableCandidates(binary: string): string[] {
	const pathext = process.env.PATHEXT?.split(";").filter(Boolean) ?? [".COM", ".EXE", ".BAT", ".CMD"];
	const lowerBinary = binary.toLowerCase();
	if (pathext.some((extension) => lowerBinary.endsWith(extension.toLowerCase()))) {
		return [binary];
	}
	return [binary, ...pathext.map((extension) => `${binary}${extension}`)];
}

// Intentionally perform PATH inspection in-process instead of spawning `which`, `where`,
// `command -v`, or an interactive shell.
//
// Why this exists:
// Kanban is launched from the user's shell and inherits that shell's environment, including
// PATH and exported variables. For agent detection and other startup-time capability checks,
// the question we care about is "can the current Kanban process directly execute this binary
// from its inherited environment?" A direct PATH scan answers exactly that question.
//
// Why we do not delegate to shell commands:
// 1. Spawning helper commands like `which` or `where` adds unnecessary subprocess overhead
//    to hot paths such as loading runtime config.
// 2. Falling back to `zsh -ic 'command -v ...'` or similar is much worse because it can
//    trigger full interactive shell startup. On machines with heavy shell init like `conda`
//    or `nvm`, doing that repeatedly per task or per config read can freeze the runtime and
//    even make new terminal windows feel hung while the machine is saturated.
// 3. Depending on external lookup commands is also less robust than inspecting PATH directly.
//    For example, detection should not depend on `which` itself being available on PATH.
//
// Why this is acceptable:
// If a binary is only available after re-running shell init files, Kanban should treat it as
// unavailable for task-agent startup. That keeps behavior predictable and aligned with the
// environment the Kanban process already has, instead of silently relying on hidden shell
// side effects.
export function resolveBinaryOnPath(binary: string, options: { skipNodeModulesBin?: boolean } = {}): string | null {
	const trimmed = binary.trim();
	if (!trimmed) {
		return null;
	}
	if (trimmed.includes("/") || trimmed.includes("\\")) {
		return canAccessPath(trimmed) ? trimmed : null;
	}

	const pathEntries = (process.env.PATH ?? "")
		.split(delimiter)
		.filter(Boolean)
		// `npm run` prepends node_modules/.bin, whose shims can shadow the user's own install.
		.filter((entry) => !options.skipNodeModulesBin || !/[\\/]node_modules[\\/]\.bin$/.test(entry));
	const candidates = process.platform === "win32" ? getWindowsExecutableCandidates(trimmed) : [trimmed];
	for (const entry of pathEntries) {
		for (const candidate of candidates) {
			const fullPath = join(entry, candidate);
			if (canAccessPath(fullPath)) {
				return fullPath;
			}
		}
	}
	return null;
}

export function isBinaryAvailableOnPath(binary: string): boolean {
	return resolveBinaryOnPath(binary) !== null;
}
