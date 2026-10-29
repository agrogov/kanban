import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildFilteredEnv, resolveLoginShellPath } from "../src/runtime-child-env.js";

const originalPlatform = process.platform;
const originalPath = process.env.PATH;
const originalShell = process.env.SHELL;
const originalPathext = process.env.PATHEXT;
const originalAppdata = process.env.APPDATA;
const originalLocalAppdata = process.env.LOCALAPPDATA;
const originalHomedrive = process.env.HOMEDRIVE;
const originalHomepath = process.env.HOMEPATH;

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", {
		value,
		configurable: true,
	});
}

describe("buildFilteredEnv", () => {
	afterEach(() => {
		setPlatform(originalPlatform);
		if (originalPath === undefined) {
			delete process.env.PATH;
		} else {
			process.env.PATH = originalPath;
		}
		if (originalShell === undefined) {
			delete process.env.SHELL;
		} else {
			process.env.SHELL = originalShell;
		}
		if (originalPathext === undefined) {
			delete process.env.PATHEXT;
		} else {
			process.env.PATHEXT = originalPathext;
		}
		if (originalAppdata === undefined) {
			delete process.env.APPDATA;
		} else {
			process.env.APPDATA = originalAppdata;
		}
		if (originalLocalAppdata === undefined) {
			delete process.env.LOCALAPPDATA;
		} else {
			process.env.LOCALAPPDATA = originalLocalAppdata;
		}
		if (originalHomedrive === undefined) {
			delete process.env.HOMEDRIVE;
		} else {
			process.env.HOMEDRIVE = originalHomedrive;
		}
		if (originalHomepath === undefined) {
			delete process.env.HOMEPATH;
		} else {
			process.env.HOMEPATH = originalHomepath;
		}
	});

	it("includes SHELL in the filtered env when set", () => {
		process.env.SHELL = "/bin/zsh";
		const env = buildFilteredEnv();
		expect(env.SHELL).toBe("/bin/zsh");
	});

	it("includes /bin and /usr/bin in the PATH on macOS", () => {
		setPlatform("darwin");
		process.env.PATH = "/opt/homebrew/bin";
		const env = buildFilteredEnv();
		const pathDirs = (env.PATH ?? "").split(":");
		expect(pathDirs.length).toBeGreaterThan(0);
		expect(env.PATH).toBeDefined();
	});

	it("puts the login-shell PATH first so user-installed agent CLIs are found", () => {
		setPlatform("darwin");
		process.env.PATH = "/usr/bin:/bin";
		const env = buildFilteredEnv("/Users/test/.local/bin:/usr/local/bin");
		const pathDirs = (env.PATH ?? "").split(path.delimiter);
		expect(pathDirs[0]).toBe("/Users/test/.local/bin");
		expect(pathDirs).toContain("/usr/bin");
		expect(pathDirs).toContain("/opt/homebrew/bin");
		expect(new Set(pathDirs).size).toBe(pathDirs.length);
	});

	it("falls back to the inherited PATH when the login-shell PATH is unavailable", () => {
		setPlatform("darwin");
		process.env.PATH = "/custom/bin";
		const env = buildFilteredEnv(null);
		expect((env.PATH ?? "").split(path.delimiter)).toContain("/custom/bin");
	});

	it("forwards HOME env variable", () => {
		process.env.HOME = "/Users/testuser";
		const env = buildFilteredEnv();
		expect(env.HOME).toBe("/Users/testuser");
	});

	it("forwards all env variables by default", () => {
		process.env.MY_CUSTOM_VAR = "custom-value";
		const env = buildFilteredEnv();
		expect(env.MY_CUSTOM_VAR).toBe("custom-value");
		delete process.env.MY_CUSTOM_VAR;
	});

	it("forwards KANBAN_ prefixed env variables", () => {
		process.env.KANBAN_TEST_KEY = "test-value";
		const env = buildFilteredEnv();
		expect(env.KANBAN_TEST_KEY).toBe("test-value");
		delete process.env.KANBAN_TEST_KEY;
	});

	it("forwards OCA_ and provider prefix env variables", () => {
		process.env.OCA_API_KEY = "oca-value";
		process.env.ANTHROPIC_API_KEY = "ant-value";
		const env = buildFilteredEnv();
		expect(env.OCA_API_KEY).toBe("oca-value");
		expect(env.ANTHROPIC_API_KEY).toBe("ant-value");
		delete process.env.OCA_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
	});

	it("uses path.delimiter not a hardcoded colon", () => {
		const testDirs = ["/usr/local/bin", "/usr/bin", "/bin"];
		process.env.PATH = testDirs.join(path.delimiter);
		const env = buildFilteredEnv();
		const resultParts = (env.PATH ?? "").split(path.delimiter);
		for (const dir of testDirs) {
			expect(resultParts).toContain(dir);
		}
		expect(resultParts.every((p) => p.length > 0)).toBe(true);
	});

	it("includes PATHEXT when set", () => {
		process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
		const env = buildFilteredEnv();
		expect(env.PATHEXT).toBe(".COM;.EXE;.BAT;.CMD");
	});

	it("includes APPDATA when set", () => {
		process.env.APPDATA = "C:\\Users\\test\\AppData\\Roaming";
		const env = buildFilteredEnv();
		expect(env.APPDATA).toBe("C:\\Users\\test\\AppData\\Roaming");
	});

	it("includes LOCALAPPDATA when set", () => {
		process.env.LOCALAPPDATA = "C:\\Users\\test\\AppData\\Local";
		const env = buildFilteredEnv();
		expect(env.LOCALAPPDATA).toBe("C:\\Users\\test\\AppData\\Local");
	});

	it("includes HOMEDRIVE and HOMEPATH when set", () => {
		process.env.HOMEDRIVE = "C:";
		process.env.HOMEPATH = "\\Users\\test";
		const env = buildFilteredEnv();
		expect(env.HOMEDRIVE).toBe("C:");
		expect(env.HOMEPATH).toBe("\\Users\\test");
	});

	it("forwards ELECTRON_RUN_AS_NODE and all other env vars", () => {
		process.env.ELECTRON_RUN_AS_NODE = "1";
		process.env.CUSTOM_VAR = "custom-value";
		const env = buildFilteredEnv();
		expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
		expect(env.CUSTOM_VAR).toBe("custom-value");
		delete process.env.ELECTRON_RUN_AS_NODE;
		delete process.env.CUSTOM_VAR;
	});

	it("omits keys that are not set in process.env", () => {
		delete process.env.XDG_RUNTIME_DIR;
		const env = buildFilteredEnv();
		expect(env.XDG_RUNTIME_DIR).toBeUndefined();
	});
});

describe("resolveLoginShellPath", () => {
	it("returns the PATH exported by the login shell", async () => {
		if (process.platform === "win32") return;
		const resolved = await resolveLoginShellPath();
		expect(resolved).not.toBeNull();
		expect((resolved ?? "").split(path.delimiter)).toContain("/usr/bin");
	});
});
