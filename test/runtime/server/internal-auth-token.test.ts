/**
 * Unit tests for the internal CLI auth token mechanism in passcode-manager.ts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	disablePasscode,
	extractBearerToken,
	extractSessionTokenFromCookie,
	generateInternalToken,
	generatePasscode,
	getInternalToken,
	INTERNAL_TOKEN_ENV,
	isPasscodeEnabled,
	issueScopedHookToken,
	issueSession,
	resolveScopedHookToken,
	revokeAndRegeneratePasscode,
	validateInternalToken,
	validatePasscode,
	validateSession,
} from "../../../src/security/passcode-manager";

function runHttpGate(input: {
	isRemoteMode: boolean;
	cookieHeader: string | undefined;
	authorizationHeader: string | undefined;
	pathname: string;
}): "allowed" | "rejected" {
	const passcodeActive = input.isRemoteMode && isPasscodeEnabled();
	if (passcodeActive) {
		const sessionToken = extractSessionTokenFromCookie(input.cookieHeader);
		const sessionAuth = sessionToken !== null && validateSession(sessionToken);
		const bearerToken = extractBearerToken(input.authorizationHeader);
		const internalAuth = bearerToken !== null && validateInternalToken(bearerToken);
		// Mirrors the `runtime-server.ts` gate: a scoped hook token authenticates only
		// the hooks tRPC route (workspace binding is enforced later, in hooks-api).
		const scopedHookAuth =
			bearerToken !== null &&
			!internalAuth &&
			resolveScopedHookToken(bearerToken) !== null &&
			input.pathname.startsWith("/api/trpc/hooks");
		if (!(sessionAuth || internalAuth || scopedHookAuth) && input.pathname.startsWith("/api/")) {
			return "rejected";
		}
	}
	return "allowed";
}

function runWsUpgradeGate(input: {
	isRemoteMode: boolean;
	cookieHeader: string | undefined;
	authorizationHeader: string | undefined;
}): "allowed" | "rejected" {
	const passcodeActive = input.isRemoteMode && isPasscodeEnabled();
	if (passcodeActive) {
		const sessionToken = extractSessionTokenFromCookie(input.cookieHeader);
		const sessionAuth = sessionToken !== null && validateSession(sessionToken);
		const bearerToken = extractBearerToken(input.authorizationHeader);
		const internalAuth = bearerToken !== null && validateInternalToken(bearerToken);
		if (!sessionAuth && !internalAuth) return "rejected";
	}
	return "allowed";
}

afterEach(() => {
	vi.restoreAllMocks();
	generatePasscode();
	delete process.env[INTERNAL_TOKEN_ENV];
});

describe("Internal CLI auth token", () => {
	it("generates a 64-char hex token", () => {
		expect(generateInternalToken()).toMatch(/^[0-9a-f]{64}$/);
	});

	it("getInternalToken() returns the generated token", () => {
		const token = generateInternalToken();
		expect(getInternalToken()).toBe(token);
	});

	it("sets the env var for child process inheritance", () => {
		const token = generateInternalToken();
		expect(process.env[INTERNAL_TOKEN_ENV]).toBe(token);
	});

	it("regenerating produces a different value", () => {
		const t1 = generateInternalToken();
		const t2 = generateInternalToken();
		expect(t1).not.toBe(t2);
		expect(getInternalToken()).toBe(t2);
	});

	it("validates a correct token", () => {
		const token = generateInternalToken();
		expect(validateInternalToken(token)).toBe(true);
	});

	it("rejects an incorrect token", () => {
		generateInternalToken();
		expect(validateInternalToken("wrong")).toBe(false);
	});

	it("rejects empty string", () => {
		generateInternalToken();
		expect(validateInternalToken("")).toBe(false);
	});

	it("rejects a token with wrong length", () => {
		generateInternalToken();
		expect(validateInternalToken("abc")).toBe(false);
		expect(validateInternalToken("a".repeat(128))).toBe(false);
	});

	it("returns false when no token was generated", () => {
		expect(validateInternalToken("anything")).toBe(false);
	});

	it("validates only the latest token after regeneration", () => {
		generatePasscode();
		const old = generateInternalToken();
		const cur = generateInternalToken();
		expect(validateInternalToken(old)).toBe(false);
		expect(validateInternalToken(cur)).toBe(true);
	});
});

describe("extractBearerToken", () => {
	it("extracts token from well-formed header", () => {
		expect(extractBearerToken("Bearer abc123")).toBe("abc123");
	});

	it("is case-insensitive on scheme", () => {
		expect(extractBearerToken("bearer abc")).toBe("abc");
		expect(extractBearerToken("BEARER abc")).toBe("abc");
	});

	it("returns null for undefined", () => {
		expect(extractBearerToken(undefined)).toBeNull();
	});

	it("returns null for non-Bearer scheme", () => {
		expect(extractBearerToken("Basic abc")).toBeNull();
	});

	it("returns null when token part is missing", () => {
		expect(extractBearerToken("Bearer ")).toBeNull();
		expect(extractBearerToken("Bearer")).toBeNull();
	});
});

describe("Passcode lifetime", () => {
	it("keeps passcodes valid beyond the old 24h window", () => {
		const nowSpy = vi.spyOn(Date, "now");
		nowSpy.mockReturnValue(1_000_000);
		const passcode = generatePasscode();
		nowSpy.mockReturnValue(1_000_000 + 25 * 60 * 60 * 1000);
		expect(validatePasscode(passcode)).toBe(true);
	});
});

describe("HTTP passcode gate with internal token", () => {
	it("allows API request with valid internal bearer token", () => {
		generatePasscode();
		const token = generateInternalToken();
		expect(
			runHttpGate({
				isRemoteMode: true,
				cookieHeader: undefined,
				authorizationHeader: `Bearer ${token}`,
				pathname: "/api/trpc",
			}),
		).toBe("allowed");
	});

	it("rejects API request with invalid bearer token", () => {
		generatePasscode();
		generateInternalToken();
		expect(
			runHttpGate({
				isRemoteMode: true,
				cookieHeader: undefined,
				authorizationHeader: "Bearer wrong",
				pathname: "/api/trpc",
			}),
		).toBe("rejected");
	});

	it("allows API request with valid session cookie", () => {
		generatePasscode();
		generateInternalToken();
		const session = issueSession();
		expect(
			runHttpGate({
				isRemoteMode: true,
				cookieHeader: `kanban_session=${session}`,
				authorizationHeader: undefined,
				pathname: "/api/trpc",
			}),
		).toBe("allowed");
	});

	it("rejects API request with no auth in remote mode", () => {
		generatePasscode();
		generateInternalToken();
		expect(
			runHttpGate({
				isRemoteMode: true,
				cookieHeader: undefined,
				authorizationHeader: undefined,
				pathname: "/api/trpc",
			}),
		).toBe("rejected");
	});

	it("allows API request without auth when NOT in remote mode", () => {
		generatePasscode();
		generateInternalToken();
		expect(
			runHttpGate({
				isRemoteMode: false,
				cookieHeader: undefined,
				authorizationHeader: undefined,
				pathname: "/api/trpc",
			}),
		).toBe("allowed");
	});

	it("allows non-API path even without auth in remote mode", () => {
		generatePasscode();
		generateInternalToken();
		expect(
			runHttpGate({
				isRemoteMode: true,
				cookieHeader: undefined,
				authorizationHeader: undefined,
				pathname: "/assets/app.js",
			}),
		).toBe("allowed");
	});

	it("allows when passcode is disabled", () => {
		disablePasscode();
		expect(
			runHttpGate({
				isRemoteMode: true,
				cookieHeader: undefined,
				authorizationHeader: undefined,
				pathname: "/api/trpc",
			}),
		).toBe("allowed");
	});
});

describe("WS upgrade gate with internal token", () => {
	it("allows upgrade with valid bearer token", () => {
		generatePasscode();
		const token = generateInternalToken();
		expect(
			runWsUpgradeGate({
				isRemoteMode: true,
				cookieHeader: undefined,
				authorizationHeader: `Bearer ${token}`,
			}),
		).toBe("allowed");
	});

	it("rejects upgrade with invalid bearer token", () => {
		generatePasscode();
		generateInternalToken();
		expect(
			runWsUpgradeGate({
				isRemoteMode: true,
				cookieHeader: undefined,
				authorizationHeader: "Bearer wrong",
			}),
		).toBe("rejected");
	});

	it("allows upgrade with valid session cookie", () => {
		generatePasscode();
		generateInternalToken();
		const session = issueSession();
		expect(
			runWsUpgradeGate({
				isRemoteMode: true,
				cookieHeader: `kanban_session=${session}`,
				authorizationHeader: undefined,
			}),
		).toBe("allowed");
	});

	it("rejects upgrade with no auth in remote mode", () => {
		generatePasscode();
		generateInternalToken();
		expect(
			runWsUpgradeGate({
				isRemoteMode: true,
				cookieHeader: undefined,
				authorizationHeader: undefined,
			}),
		).toBe("rejected");
	});
});

describe("Scoped hook tokens", () => {
	it("returns null when no internal token exists (local mode)", () => {
		disablePasscode();
		expect(issueScopedHookToken("ws-1")).toBeNull();
	});

	it("issues and resolves a workspace-bound token", () => {
		generatePasscode();
		generateInternalToken();
		const token = issueScopedHookToken("ws-1");
		expect(token).toMatch(/^[0-9a-f]{64}$/);
		expect(resolveScopedHookToken(token ?? "")).toEqual({ workspaceId: "ws-1" });
	});

	it("supports hooks-only tokens without a workspace binding", () => {
		generatePasscode();
		generateInternalToken();
		const token = issueScopedHookToken(null);
		expect(resolveScopedHookToken(token ?? "")).toEqual({ workspaceId: null });
	});

	it("resolves unknown tokens to null", () => {
		generatePasscode();
		generateInternalToken();
		expect(resolveScopedHookToken("nope")).toBeNull();
	});

	it("expires after the idle TTL and slides while in use", () => {
		generatePasscode();
		generateInternalToken();
		const nowSpy = vi.spyOn(Date, "now");
		const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
		try {
			nowSpy.mockReturnValue(10_000_000);
			const idle = issueScopedHookToken("ws-1");
			nowSpy.mockReturnValue(10_000_000 + sevenDaysMs + 1);
			expect(resolveScopedHookToken(idle ?? "")).toBeNull();

			const live = issueScopedHookToken("ws-2");
			const sixDaysMs = 6 * 24 * 60 * 60 * 1000;
			nowSpy.mockReturnValue(10_000_000 + sixDaysMs);
			expect(resolveScopedHookToken(live ?? "")).toEqual({ workspaceId: "ws-2" });
			nowSpy.mockReturnValue(10_000_000 + sixDaysMs * 2);
			expect(resolveScopedHookToken(live ?? "")).toEqual({ workspaceId: "ws-2" });
			nowSpy.mockReturnValue(10_000_000 + sixDaysMs * 2 + sevenDaysMs + 1);
			expect(resolveScopedHookToken(live ?? "")).toBeNull();
		} finally {
			nowSpy.mockRestore();
		}
	});

	it("are cleared when the passcode is revoked or disabled", () => {
		generatePasscode();
		generateInternalToken();
		const token = issueScopedHookToken("ws-1");
		revokeAndRegeneratePasscode();
		expect(resolveScopedHookToken(token ?? "")).toBeNull();
		generateInternalToken();
		const token2 = issueScopedHookToken("ws-1");
		disablePasscode();
		expect(resolveScopedHookToken(token2 ?? "")).toBeNull();
	});

	it("does not resolve the master internal token as scoped", () => {
		generatePasscode();
		const master = generateInternalToken();
		expect(resolveScopedHookToken(master)).toBeNull();
	});
});

describe("HTTP passcode gate with scoped hook tokens", () => {
	it("allows the hooks ingest route with a scoped token", () => {
		generatePasscode();
		generateInternalToken();
		const token = issueScopedHookToken("ws-1");
		expect(
			runHttpGate({
				isRemoteMode: true,
				cookieHeader: undefined,
				authorizationHeader: `Bearer ${token}`,
				pathname: "/api/trpc/hooks.ingest",
			}),
		).toBe("allowed");
	});

	it("rejects every other API route with a scoped token", () => {
		generatePasscode();
		generateInternalToken();
		const token = issueScopedHookToken("ws-1");
		// `/api/health` is answered before the passcode gate in `runtime-server.ts`,
		// so only gated API routes are exercised here.
		for (const pathname of ["/api/trpc/runtime.runCommand", "/api/trpc/workspace.saveState", "/api/trpc/"]) {
			expect(
				runHttpGate({
					isRemoteMode: true,
					cookieHeader: undefined,
					authorizationHeader: `Bearer ${token}`,
					pathname,
				}),
			).toBe("rejected");
		}
	});
});
