// Contract shared by the agents rendered in the native chat panel through the Cline-shaped
// session service (Claude, Codex). The composite service routes tasks to these by agent id.
import type { ClineTaskMessage } from "../cline-sdk/cline-session-state";
import type { ClineSdkSlashCommand } from "../cline-sdk/sdk-runtime-boundary";
import type {
	RuntimeAgentId,
	RuntimeTaskImage,
	RuntimeTaskSessionMode,
	RuntimeTaskSessionSummary,
	RuntimeTaskTurnCheckpoint,
} from "../core/api-contract";

export interface StartNativeChatSessionRequest {
	taskId: string;
	cwd: string;
	prompt: string;
	images?: RuntimeTaskImage[];
	startInPlanMode?: boolean;
	autonomousModeEnabled?: boolean;
	resumeFromTrash?: boolean;
	resumeFromPersistence?: boolean;
	modelId?: string | null;
	reasoningEffort?: string | null;
	systemPrompt?: string | null;
	mode?: RuntimeTaskSessionMode;
}

export interface NativeChatBackend {
	onSummary(listener: (summary: RuntimeTaskSessionSummary) => void): () => void;
	onMessage(listener: (taskId: string, message: ClineTaskMessage) => void): () => void;
	startTaskSession(request: StartNativeChatSessionRequest): Promise<RuntimeTaskSessionSummary>;
	stopTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	abortTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	cancelTaskTurn(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	sendTaskSessionInput(
		taskId: string,
		text: string,
		mode?: RuntimeTaskSessionMode,
		images?: RuntimeTaskImage[],
	): Promise<RuntimeTaskSessionSummary | null>;
	reloadTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	clearTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	rebindPersistedTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	getSummary(taskId: string): RuntimeTaskSessionSummary | null;
	listSummaries(): RuntimeTaskSessionSummary[];
	listMessages(taskId: string): ClineTaskMessage[];
	listSlashCommands(): ClineSdkSlashCommand[];
	loadTaskSessionMessages(taskId: string): Promise<ClineTaskMessage[]>;
	applyTurnCheckpoint(taskId: string, checkpoint: RuntimeTaskTurnCheckpoint): RuntimeTaskSessionSummary | null;
	hasTask(taskId: string): Promise<boolean>;
	dispose(): Promise<void>;
}

export interface NativeChatBackendRegistration {
	agentId: RuntimeAgentId;
	service: NativeChatBackend;
}
