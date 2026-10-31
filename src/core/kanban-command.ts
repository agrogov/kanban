export interface RuntimeInvocationContext {
	execPath: string;
	argv: string[];
	execArgv?: string[];
	/** True when the current runtime is an Electron binary acting as plain Node (desktop app CLI child). */
	electronRunAsNode?: boolean;
}

function readElectronRunAsNode(): boolean {
	return process.platform !== "win32" && process.env.ELECTRON_RUN_AS_NODE === "1";
}

function resolveNodeCommandPrefix(context: RuntimeInvocationContext): string[] {
	const execArgv = context.execArgv ?? [];
	// Agents may scrub the environment of their hook subprocesses. Without this variable the Electron
	// binary would boot the full GUI app (and abort outside a window-server session) instead of the CLI.
	const envPrefix = context.electronRunAsNode ? ["env", "ELECTRON_RUN_AS_NODE=1"] : [];
	return [...envPrefix, context.execPath, ...execArgv];
}

function isLikelyTsxCliEntrypoint(value: string): boolean {
	const normalized = value.replaceAll("\\", "/").toLowerCase();
	if (normalized.endsWith("/tsx") || normalized.endsWith("/tsx.js")) {
		return true;
	}
	return normalized.includes("/tsx/") && normalized.endsWith("/cli.mjs");
}

function looksLikeEntrypointPath(value: string): boolean {
	if (!value) {
		return false;
	}
	if (value.includes("/") || value.includes("\\")) {
		return true;
	}
	if (/\.(?:mjs|cjs|js|ts|mts|cts)$/iu.test(value)) {
		return true;
	}
	return /kanban(?:\.(?:cmd|ps1|exe))?$/iu.test(value);
}

export function resolveKanbanCommandParts(
	context: RuntimeInvocationContext = {
		execPath: process.execPath,
		argv: process.argv,
		execArgv: process.execArgv,
		electronRunAsNode: readElectronRunAsNode(),
	},
): string[] {
	const commandPrefix = resolveNodeCommandPrefix(context);
	const entrypoint = context.argv[1];
	if (!entrypoint || !looksLikeEntrypointPath(entrypoint)) {
		return commandPrefix;
	}

	const tsxTarget = context.argv[2];
	if (tsxTarget && isLikelyTsxCliEntrypoint(entrypoint) && looksLikeEntrypointPath(tsxTarget)) {
		return [...commandPrefix, entrypoint, tsxTarget];
	}

	return [...commandPrefix, entrypoint];
}

export function buildKanbanCommandParts(
	args: string[],
	context: RuntimeInvocationContext = {
		execPath: process.execPath,
		argv: process.argv,
		execArgv: process.execArgv,
		electronRunAsNode: readElectronRunAsNode(),
	},
): string[] {
	return [...resolveKanbanCommandParts(context), ...args];
}
