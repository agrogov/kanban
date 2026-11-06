/**
 * Guard for values that end up as bare `git` argv entries (revisions, branch
 * names). A value starting with `-` is parsed by git as an option — `--output=`,
 * `--orphan=`, `-f` and friends all have side effects — so such values must never
 * reach the command line. NUL is rejected because it truncates argv on exec.
 */
export function isSafeGitArgument(value: string): boolean {
	if (value.length === 0) {
		return false;
	}
	if (value.startsWith("-")) {
		return false;
	}
	return !value.includes("\0");
}

export function requireSafeGitArgument(value: string, label: string): string {
	if (!isSafeGitArgument(value)) {
		throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
	}
	return value;
}
