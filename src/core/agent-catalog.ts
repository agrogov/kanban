import type { RuntimeAgentId } from "./api-contract";

// How an agent accepts launch-time model/effort overrides. Mechanisms only — never value lists.
export type RuntimeAgentOverrideMechanism = "flag" | "config" | "sdk" | "none";

export interface RuntimeAgentCapabilities {
	modelOverride: RuntimeAgentOverrideMechanism;
	effortOverride: RuntimeAgentOverrideMechanism;
	/** Whether the agent consumes `providerId` at launch (Cline SDK, OpenCode `provider/model`). */
	providerOverride: RuntimeAgentOverrideMechanism;
	docsUrl: string;
}

export interface RuntimeAgentCatalogEntry {
	id: RuntimeAgentId;
	label: string;
	/** One-line blurb shown wherever the agent is presented (onboarding, settings). */
	description: string;
	binary: string;
	baseArgs: string[];
	autonomousArgs: string[];
	installUrl: string;
	/** Exact install command(s) for this CLI, when there is one worth spelling out next to installUrl. */
	installHint?: string;
	/** Built-in runtime (e.g. the embedded Cline SDK) that needs no external binary detection. */
	embedded?: boolean;
	capabilities: RuntimeAgentCapabilities;
}

export const RUNTIME_AGENT_CATALOG: RuntimeAgentCatalogEntry[] = [
	{
		id: "claude",
		label: "Claude Code",
		description: "Anthropic's coding agent CLI with access to Claude models.",
		binary: "claude",
		baseArgs: [],
		autonomousArgs: ["--permission-mode", "auto"],
		installUrl: "https://docs.anthropic.com/en/docs/claude-code/quickstart",
		capabilities: {
			modelOverride: "flag",
			effortOverride: "flag",
			providerOverride: "none",
			docsUrl: "https://code.claude.com/docs/en/cli-reference",
		},
	},
	{
		id: "claude-chat",
		label: "Claude Code (chat view)",
		description: "Claude Code in a native chat view: selectable text, normal context menu. No terminal.",
		binary: "claude",
		baseArgs: [],
		autonomousArgs: ["--permission-mode", "auto"],
		installUrl: "https://docs.anthropic.com/en/docs/claude-code/quickstart",
		capabilities: {
			modelOverride: "flag",
			effortOverride: "flag",
			providerOverride: "none",
			docsUrl: "https://code.claude.com/docs/en/cli-reference",
		},
	},
	{
		id: "codex",
		label: "OpenAI Codex",
		description: "OpenAI's coding agent CLI with access to the latest GPT models.",
		binary: "codex",
		baseArgs: [],
		autonomousArgs: ["--dangerously-bypass-approvals-and-sandbox"],
		installUrl: "https://github.com/openai/codex",
		capabilities: {
			modelOverride: "flag",
			effortOverride: "config",
			providerOverride: "none",
			docsUrl: "https://developers.openai.com/codex/cli/reference",
		},
	},
	{
		id: "codex-chat",
		label: "OpenAI Codex (chat view)",
		description: "OpenAI Codex in a native chat view: selectable text, normal context menu. No terminal.",
		binary: "codex",
		baseArgs: [],
		autonomousArgs: ["--dangerously-bypass-approvals-and-sandbox"],
		installUrl: "https://github.com/openai/codex",
		capabilities: {
			modelOverride: "flag",
			effortOverride: "config",
			providerOverride: "none",
			docsUrl: "https://developers.openai.com/codex/cli/reference",
		},
	},
	{
		id: "cline",
		label: "Cline",
		description: "Built-in agent with support for any LLM provider. No CLI install needed.",
		binary: "cline",
		baseArgs: [],
		autonomousArgs: ["--auto-approve-all"],
		installUrl: "https://github.com/cline/cline",
		// Embedded SDK runtime: always available, no external binary to detect.
		embedded: true,
		capabilities: {
			modelOverride: "sdk",
			effortOverride: "sdk",
			providerOverride: "sdk",
			docsUrl: "https://github.com/cline/cline",
		},
	},
	{
		id: "cline-cli",
		label: "Cline CLI",
		description: "Cline's terminal coding agent CLI with plan/act modes, MCP support, and any LLM provider.",
		binary: "cline",
		baseArgs: [],
		autonomousArgs: ["--auto-approve", "true"],
		installUrl: "https://docs.cline.bot/cli/cli-reference",
		capabilities: {
			modelOverride: "flag",
			effortOverride: "flag",
			providerOverride: "flag",
			docsUrl: "https://docs.cline.bot/cli/cli-reference",
		},
	},
	{
		id: "opencode",
		label: "OpenCode",
		description: "Terminal coding agent that runs any provider's models through one CLI.",
		binary: "opencode",
		baseArgs: [],
		autonomousArgs: [],
		installUrl: "https://github.com/sst/opencode",
		capabilities: {
			modelOverride: "flag",
			effortOverride: "none",
			providerOverride: "flag",
			docsUrl: "https://opencode.ai/docs/cli/",
		},
	},
	{
		id: "droid",
		label: "Factory Droid",
		description: "Factory's coding agent with access to the latest frontier models.",
		binary: "droid",
		baseArgs: [],
		autonomousArgs: ["--auto", "high"],
		installUrl: "https://docs.factory.ai/cli/getting-started/quickstart",
		capabilities: {
			modelOverride: "flag",
			effortOverride: "flag",
			providerOverride: "none",
			docsUrl: "https://docs.factory.ai/droid-cli/cli-reference",
		},
	},
	{
		id: "kiro",
		label: "Kiro",
		description: "Amazon's coding agent with access to the latest frontier models.",
		binary: "kiro-cli",
		baseArgs: ["chat"],
		autonomousArgs: ["--trust-all-tools"],
		installUrl: "https://kiro.dev",
		capabilities: {
			modelOverride: "none",
			effortOverride: "none",
			providerOverride: "none",
			docsUrl: "https://kiro.dev/docs/reference/cli-commands/",
		},
	},
	{
		id: "grok",
		label: "Grok Build",
		description: "xAI's Grok Build coding agent CLI.",
		binary: "grok",
		baseArgs: [],
		autonomousArgs: ["--always-approve"],
		installUrl: "https://docs.x.ai/build/overview",
		capabilities: {
			modelOverride: "flag",
			effortOverride: "flag",
			providerOverride: "none",
			docsUrl: "https://docs.x.ai/build/overview",
		},
	},
	{
		id: "pi",
		label: "Pi",
		description: "Pi coding agent CLI, run from a terminal with any provider's models.",
		binary: "pi",
		baseArgs: [],
		autonomousArgs: [],
		installUrl: "https://pi.dev/",
		installHint:
			"Install with npm i -g --ignore-scripts @earendil-works/pi-coding-agent or curl -fsSL https://pi.dev/install.sh | sh.",
		capabilities: {
			modelOverride: "flag",
			effortOverride: "flag",
			providerOverride: "flag",
			docsUrl: "https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md",
		},
	},
	{
		id: "agenc",
		label: "AgenC",
		description: "Open source terminal coding agent from tetsuo-ai that works with any model provider.",
		binary: "agenc",
		baseArgs: [],
		autonomousArgs: ["--bypass-approvals"],
		installUrl: "https://get.agenc.ag",
		installHint: "Install with curl -fsSL https://get.agenc.ag/install.sh | sh, then run agenc onboard.",
		capabilities: {
			modelOverride: "flag",
			effortOverride: "none",
			providerOverride: "flag",
			docsUrl: "https://github.com/tetsuo-ai/agenc-core/blob/main/docs/reference/cli.md",
		},
	},
	{
		id: "gemini",
		label: "Gemini CLI",
		description: "Google's coding agent CLI with access to the latest Gemini models.",
		binary: "gemini",
		baseArgs: [],
		autonomousArgs: ["--yolo"],
		installUrl: "https://github.com/google-gemini/gemini-cli",
		capabilities: {
			modelOverride: "flag",
			effortOverride: "none",
			providerOverride: "none",
			docsUrl: "https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/cli-reference.md",
		},
	},
	{
		id: "devin",
		label: "Devin",
		description: "Cognition's autonomous software engineer CLI.",
		binary: "devin",
		baseArgs: [],
		autonomousArgs: ["--permission-mode", "dangerous"],
		installUrl: "https://docs.devin.ai/cli",
		capabilities: {
			modelOverride: "none",
			effortOverride: "none",
			providerOverride: "none",
			docsUrl: "https://docs.devin.ai/cli",
		},
	},
];

/**
 * The only catalog entries kept out of the launch set: neither has autonomous-mode approval wiring
 * exercised end to end (opencode declares no autonomousArgs at all, and gemini's `--yolo` bypass
 * has not been verified on our launch path). Add an id here once its flag is wired and tested.
 */
export const RUNTIME_LAUNCH_UNSUPPORTED_AGENT_IDS: readonly RuntimeAgentId[] = ["opencode", "gemini"];

// Derived from the catalog plus the exclusion set above, so RUNTIME_AGENT_CATALOG and the launch
// set can never drift apart as entries are added.
export const RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS: readonly RuntimeAgentId[] = RUNTIME_AGENT_CATALOG.filter(
	(entry) => !RUNTIME_LAUNCH_UNSUPPORTED_AGENT_IDS.includes(entry.id),
).map((entry) => entry.id);

const RUNTIME_LAUNCH_SUPPORTED_AGENT_ID_SET = new Set<RuntimeAgentId>(RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS);

// Cline runtimes lead user-facing agent lists: the embedded SDK session first, then the CLI.
const RUNTIME_AGENT_HEAD_DISPLAY_IDS: readonly RuntimeAgentId[] = ["cline", "cline-cli"];

/**
 * Stable display order for launch-supported agents: the head preference above, then every
 * remaining id in RUNTIME_AGENT_CATALOG declaration order. Derived from the catalog so each
 * supported agent owns exactly one declared position (no rank collisions).
 */
export function getRuntimeLaunchAgentDisplayOrder(): readonly RuntimeAgentId[] {
	const supportedIds = getRuntimeLaunchSupportedAgentCatalog().map((entry) => entry.id);
	const headIds = new Set<RuntimeAgentId>(RUNTIME_AGENT_HEAD_DISPLAY_IDS);
	const head = RUNTIME_AGENT_HEAD_DISPLAY_IDS.filter((agentId) => supportedIds.includes(agentId));
	const tail = supportedIds.filter((agentId) => !headIds.has(agentId));
	return [...head, ...tail];
}

export function isRuntimeAgentLaunchSupported(agentId: RuntimeAgentId): boolean {
	return RUNTIME_LAUNCH_SUPPORTED_AGENT_ID_SET.has(agentId);
}

export function getRuntimeLaunchSupportedAgentCatalog(): RuntimeAgentCatalogEntry[] {
	return RUNTIME_AGENT_CATALOG.filter((entry) => isRuntimeAgentLaunchSupported(entry.id));
}

export function getRuntimeAgentCatalogEntry(agentId: RuntimeAgentId): RuntimeAgentCatalogEntry | null {
	return RUNTIME_AGENT_CATALOG.find((entry) => entry.id === agentId) ?? null;
}

/** Agents rendered as a native chat panel and driven through a ClineTaskSessionService instead of a PTY. */
export function isNativeChatAgentId(agentId: RuntimeAgentId | null | undefined): boolean {
	return agentId === "cline" || agentId === "claude-chat" || agentId === "codex-chat";
}

/** Core Pi has no plan mode; other launch-supported CLIs do or emulate it. */
export function runtimeAgentSupportsPlanMode(agentId: RuntimeAgentId | null | undefined): boolean {
	return agentId !== "pi";
}
