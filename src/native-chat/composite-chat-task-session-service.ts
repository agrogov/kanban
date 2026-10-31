// Routes the ClineTaskSessionService surface to either the embedded Cline SDK service or one of
// the native chat backends (Claude, Codex), so tRPC handlers, the state hub and the auto-review
// reconciler keep one per-workspace service. Ownership of a task is decided by which backend knows it.
import type { ClineTaskMessage, ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import type { ClineSdkSlashCommand } from "../cline-sdk/sdk-runtime-boundary";
import type { RuntimeTaskImage, RuntimeTaskSessionMode, RuntimeTaskTurnCheckpoint } from "../core/api-contract";
import type { NativeChatBackend, NativeChatBackendRegistration } from "./chat-backend";

export function createCompositeChatTaskSessionService(
	cline: ClineTaskSessionService,
	registrations: NativeChatBackendRegistration[],
): ClineTaskSessionService {
	const backends = registrations.map((registration) => registration.service);
	const ownerOf = (taskId: string): ClineTaskSessionService | NativeChatBackend =>
		backends.find((backend) => backend.getSummary(taskId)) ?? cline;
	const ownerOfPersisted = async (taskId: string): Promise<ClineTaskSessionService | NativeChatBackend> => {
		for (const backend of backends) {
			if (backend.getSummary(taskId) || (await backend.hasTask(taskId))) {
				return backend;
			}
		}
		return cline;
	};
	const subscribeAll = <L>(
		subscribe: (service: ClineTaskSessionService | NativeChatBackend) => (l: L) => () => void,
	) => {
		return (listener: L) => {
			const unsubscribers = [cline, ...backends].map((service) => subscribe(service)(listener));
			return () => {
				for (const unsubscribe of unsubscribers) {
					unsubscribe();
				}
			};
		};
	};

	return {
		onSummary: subscribeAll((service) => (listener) => service.onSummary(listener)),
		onMessage: subscribeAll<(taskId: string, message: ClineTaskMessage) => void>(
			(service) => (listener) => service.onMessage(listener),
		),
		async startTaskSession(request) {
			const registration = registrations.find((candidate) => candidate.agentId === request.agentId);
			if (registration) {
				return await registration.service.startTaskSession({
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
		stopTaskSession: async (taskId) => (await ownerOfPersisted(taskId)).stopTaskSession(taskId),
		abortTaskSession: async (taskId) => (await ownerOfPersisted(taskId)).abortTaskSession(taskId),
		cancelTaskTurn: async (taskId) => ownerOf(taskId).cancelTaskTurn(taskId),
		sendTaskSessionInput: async (
			taskId: string,
			text: string,
			mode?: RuntimeTaskSessionMode,
			images?: RuntimeTaskImage[],
		) => ownerOf(taskId).sendTaskSessionInput(taskId, text, mode, images),
		reloadTaskSession: async (taskId) => (await ownerOfPersisted(taskId)).reloadTaskSession(taskId),
		clearTaskSession: async (taskId) => ownerOf(taskId).clearTaskSession(taskId),
		async rebindPersistedTaskSession(taskId) {
			for (const backend of backends) {
				const summary = await backend.rebindPersistedTaskSession(taskId);
				if (summary) {
					return summary;
				}
			}
			return await cline.rebindPersistedTaskSession(taskId);
		},
		getSummary: (taskId) => ownerOf(taskId).getSummary(taskId),
		listSummaries: () => [cline, ...backends].flatMap((service) => service.listSummaries()),
		listMessages: (taskId) => ownerOf(taskId).listMessages(taskId),
		async listSlashCommands(workspacePath: string, taskId?: string): Promise<ClineSdkSlashCommand[]> {
			if (taskId) {
				const owner = await ownerOfPersisted(taskId);
				if (owner !== cline) {
					return (owner as NativeChatBackend).listSlashCommands();
				}
			}
			return await cline.listSlashCommands(workspacePath);
		},
		loadTaskSessionMessages: async (taskId) => (await ownerOfPersisted(taskId)).loadTaskSessionMessages(taskId),
		applyTurnCheckpoint: (taskId: string, checkpoint: RuntimeTaskTurnCheckpoint) =>
			ownerOf(taskId).applyTurnCheckpoint(taskId, checkpoint),
		prewarm: () => cline.prewarm(),
		async dispose() {
			await Promise.all([cline.dispose(), ...backends.map((backend) => backend.dispose())]);
		},
	};
}
