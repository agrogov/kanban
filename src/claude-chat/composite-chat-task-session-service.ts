// Routes the ClineTaskSessionService surface to either the embedded Cline SDK service or the
// Claude chat service, so tRPC handlers, the state hub and the auto-review reconciler keep one
// per-workspace service. Ownership of a task is decided by which backend knows it.
import type { ClineTaskMessage, ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import type { ClineSdkSlashCommand } from "../cline-sdk/sdk-runtime-boundary";
import type { RuntimeTaskImage, RuntimeTaskSessionMode, RuntimeTaskTurnCheckpoint } from "../core/api-contract";
import { CLAUDE_CHAT_AGENT_ID, type ClaudeChatTaskSessionService } from "./claude-chat-task-session-service";

export function createCompositeChatTaskSessionService(
	cline: ClineTaskSessionService,
	claude: ClaudeChatTaskSessionService,
): ClineTaskSessionService {
	const ownerOf = (taskId: string): ClineTaskSessionService | ClaudeChatTaskSessionService =>
		claude.getSummary(taskId) ? claude : cline;
	const ownerOfPersisted = async (taskId: string): Promise<"claude" | "cline"> =>
		claude.getSummary(taskId) || (await claude.hasTask(taskId)) ? "claude" : "cline";

	return {
		onSummary(listener) {
			const offCline = cline.onSummary(listener);
			const offClaude = claude.onSummary(listener);
			return () => {
				offCline();
				offClaude();
			};
		},
		onMessage(listener: (taskId: string, message: ClineTaskMessage) => void) {
			const offCline = cline.onMessage(listener);
			const offClaude = claude.onMessage(listener);
			return () => {
				offCline();
				offClaude();
			};
		},
		async startTaskSession(request) {
			if (request.agentId === CLAUDE_CHAT_AGENT_ID) {
				return await claude.startTaskSession({
					taskId: request.taskId,
					cwd: request.cwd,
					prompt: request.prompt,
					images: request.images,
					startInPlanMode: request.startInPlanMode,
					autonomousModeEnabled: request.autonomousModeEnabled,
					resumeFromTrash: request.resumeFromTrash,
					resumeFromPersistence: request.resumeFromPersistence,
					modelId: request.modelId,
					reasoningEffort: request.agentReasoningEffort,
					systemPrompt: request.systemPrompt,
					mode: request.mode,
				});
			}
			return await cline.startTaskSession(request);
		},
		stopTaskSession: async (taskId) =>
			(await ownerOfPersisted(taskId)) === "claude" ? claude.stopTaskSession(taskId) : cline.stopTaskSession(taskId),
		abortTaskSession: async (taskId) =>
			(await ownerOfPersisted(taskId)) === "claude"
				? claude.abortTaskSession(taskId)
				: cline.abortTaskSession(taskId),
		cancelTaskTurn: async (taskId) => ownerOf(taskId).cancelTaskTurn(taskId),
		sendTaskSessionInput: async (
			taskId: string,
			text: string,
			mode?: RuntimeTaskSessionMode,
			images?: RuntimeTaskImage[],
		) => ownerOf(taskId).sendTaskSessionInput(taskId, text, mode, images),
		reloadTaskSession: async (taskId) =>
			(await ownerOfPersisted(taskId)) === "claude"
				? claude.reloadTaskSession(taskId)
				: cline.reloadTaskSession(taskId),
		clearTaskSession: async (taskId) => ownerOf(taskId).clearTaskSession(taskId),
		rebindPersistedTaskSession: async (taskId) =>
			(await claude.rebindPersistedTaskSession(taskId)) ?? (await cline.rebindPersistedTaskSession(taskId)),
		getSummary: (taskId) => claude.getSummary(taskId) ?? cline.getSummary(taskId),
		listSummaries: () => [...cline.listSummaries(), ...claude.listSummaries()],
		listMessages: (taskId) => ownerOf(taskId).listMessages(taskId),
		async listSlashCommands(workspacePath: string, taskId?: string): Promise<ClineSdkSlashCommand[]> {
			if (taskId && (await ownerOfPersisted(taskId)) === "claude") {
				return claude.listSlashCommands();
			}
			return await cline.listSlashCommands(workspacePath);
		},
		loadTaskSessionMessages: async (taskId) =>
			(await ownerOfPersisted(taskId)) === "claude"
				? claude.loadTaskSessionMessages(taskId)
				: cline.loadTaskSessionMessages(taskId),
		applyTurnCheckpoint: (taskId: string, checkpoint: RuntimeTaskTurnCheckpoint) =>
			ownerOf(taskId).applyTurnCheckpoint(taskId, checkpoint),
		prewarm: () => cline.prewarm(),
		async dispose() {
			await Promise.all([cline.dispose(), claude.dispose()]);
		},
	};
}
