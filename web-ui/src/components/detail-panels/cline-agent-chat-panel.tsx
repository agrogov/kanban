// Layout component for the native Cline chat panel.
// Rendering lives here, while session state and action wiring come from the
// controller hook so multiple surfaces can share the same behavior.

import { parseRuntimeClineReasoningEffort } from "@runtime-task-agent-settings";
import { AlertTriangle } from "lucide-react";
import React, {
	type ReactElement,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { Virtuoso } from "react-virtuoso";
import { ClineChatComposer } from "@/components/detail-panels/cline-chat-composer";
import { ClineChatMessageItem } from "@/components/detail-panels/cline-chat-message-item";
import {
	buildClineAgentModelPickerOptions,
	buildClineSelectedModelButtonText,
	getClineReasoningEnabledModelIds,
} from "@/components/detail-panels/cline-model-picker-options";
import { ClineThinkingIndicator } from "@/components/detail-panels/cline-thinking-indicator";
import type { SearchSelectOption } from "@/components/search-select-dropdown";
import { Button } from "@/components/ui/button";
import { Link } from "@/components/ui/link";
import { NativeSelect } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { useClineChatPanelController } from "@/hooks/use-cline-chat-panel-controller";
import type { ClineChatActionResult } from "@/hooks/use-cline-chat-runtime-actions";
import type { ClineChatMessage } from "@/hooks/use-cline-chat-session";
import { useRuntimeSettingsClineController } from "@/hooks/use-runtime-settings-cline-controller";
import { fetchChatAgentModels } from "@/runtime/runtime-config-query";
import type {
	RuntimeAgentId,
	RuntimeClineReasoningEffort,
	RuntimeConfigResponse,
	RuntimeTaskAgentSettings,
	RuntimeTaskSessionMode,
	RuntimeTaskSessionSummary,
} from "@/runtime/types";
import type { TaskImage } from "@/types";

const BOTTOM_LOCK_THRESHOLD_PX = 24;
const CLINE_BUY_CREDITS_URL = "https://app.cline.bot/";

const ClineCreditLimitNotice = React.memo(function ClineCreditLimitNotice() {
	return (
		<div className="mx-1 flex items-start gap-2 rounded-md border border-status-orange/40 bg-status-orange/10 px-3 py-2 text-xs text-status-orange">
			<AlertTriangle size={14} className="mt-0.5 shrink-0" />
			<p className="m-0 min-w-0">
				Out of Cline credits.{" "}
				<Link href={CLINE_BUY_CREDITS_URL} external>
					Buy more credits
				</Link>{" "}
				to continue.
			</p>
		</div>
	);
});

type ChatFooterContext = {
	showAgentProgressIndicator: boolean;
	isCreditLimitNoticeVisible: boolean;
};

const ChatFooter = React.memo(function ChatFooter({ context }: { context?: ChatFooterContext }) {
	if (!context) {
		return null;
	}
	return (
		<div className="flex flex-col gap-2 px-2 pb-2">
			{context.showAgentProgressIndicator ? <ClineThinkingIndicator /> : null}
			{context.isCreditLimitNoticeVisible ? <ClineCreditLimitNotice /> : null}
		</div>
	);
});

export interface ClineAgentChatPanelHandle {
	appendToDraft: (text: string) => void;
	sendText: (text: string) => Promise<void>;
}

export interface ClineAgentChatPanelProps {
	taskId: string;
	summary: RuntimeTaskSessionSummary | null;
	taskColumnId?: string;
	defaultMode?: RuntimeTaskSessionMode;
	composerPlaceholder?: string;
	showComposerModeToggle?: boolean;
	workspaceId?: string | null;
	runtimeConfig?: RuntimeConfigResponse | null;
	taskAgentSettings?: RuntimeTaskAgentSettings;
	taskHasExplicitAgentSettings?: boolean;
	showModelPicker?: boolean;
	/** Non-Cline chat agent whose models come from its provider catalog. */
	chatAgentId?: RuntimeAgentId | null;
	chatAgentModelId?: string | null;
	onChatAgentModelChange?: (modelId: string | null) => void;
	chatAgentReasoningEffort?: string | null;
	onChatAgentReasoningEffortChange?: (effort: string | null) => void;
	onAgentSettingsSaved?: () => void;
	onTaskAgentSettingsChanged?: (settings: { providerId: string; modelId: string; reasoningEffort: string }) => void;
	onSendMessage?: (
		taskId: string,
		text: string,
		options?: { mode?: RuntimeTaskSessionMode; images?: TaskImage[] },
	) => Promise<ClineChatActionResult>;
	onCancelTurn?: (taskId: string) => Promise<{ ok: boolean; message?: string }>;
	onLoadMessages?: (taskId: string) => Promise<ClineChatMessage[] | null>;
	incomingMessages?: ClineChatMessage[] | null;
	incomingMessage?: ClineChatMessage | null;
	onCommit?: () => void;
	onOpenPr?: () => void;
	isCommitLoading?: boolean;
	isOpenPrLoading?: boolean;
	onMoveToTrash?: () => void;
	isMoveToTrashLoading?: boolean;
	onCancelAutomaticAction?: () => void;
	cancelAutomaticActionLabel?: string | null;
	showMoveToTrash?: boolean;
}

export const ClineAgentChatPanel = React.forwardRef<ClineAgentChatPanelHandle, ClineAgentChatPanelProps>(
	function ClineAgentChatPanel(
		{
			taskId,
			summary,
			taskColumnId = "in_progress",
			defaultMode = "act",
			composerPlaceholder = "Ask Cline to add, edit, start, or link tasks",
			showComposerModeToggle = true,
			workspaceId = null,
			runtimeConfig = null,
			taskAgentSettings,
			taskHasExplicitAgentSettings = false,
			showModelPicker = true,
			chatAgentId,
			chatAgentModelId = null,
			onChatAgentModelChange,
			chatAgentReasoningEffort = null,
			onChatAgentReasoningEffortChange,
			onAgentSettingsSaved,
			onTaskAgentSettingsChanged,
			onSendMessage,
			onCancelTurn,
			onLoadMessages,
			incomingMessages,
			incomingMessage,
			onCommit,
			onOpenPr,
			isCommitLoading = false,
			isOpenPrLoading = false,
			onMoveToTrash,
			isMoveToTrashLoading = false,
			onCancelAutomaticAction,
			cancelAutomaticActionLabel,
			showMoveToTrash = false,
		},
		ref,
	): ReactElement {
		const {
			draft,
			setDraft,
			messages,
			error,
			isSending,
			canSend,
			canCancel,
			showReviewActions,
			showAgentProgressIndicator,
			showActionFooter,
			handleSendText,
			handleSendDraft,
			handleCancelTurn,
		} = useClineChatPanelController({
			taskId,
			summary,
			taskColumnId,
			onSendMessage,
			onCancelTurn,
			onLoadMessages,
			incomingMessages,
			incomingMessage,
			onCommit,
			onOpenPr,
			onMoveToTrash,
			onCancelAutomaticAction,
			cancelAutomaticActionLabel,
			showMoveToTrash,
		});
		// TODO: Persist per-task mode immediately when toggled so page refresh restores unsent mode changes.
		const modeByTaskIdRef = useRef<Map<string, RuntimeTaskSessionMode>>(new Map());
		const [composerError, setComposerError] = useState<string | null>(null);
		const [isSavingModel, setIsSavingModel] = useState(false);
		const [chatAgentModelOptions, setChatAgentModelOptions] = useState<SearchSelectOption[] | null>(null);
		const [chatAgentDefaultModelId, setChatAgentDefaultModelId] = useState<string | null>(null);
		// The displayed choice is owned here so it updates on click: the persisted
		// prop round-trips through the board/config and lags by a render.
		const [chatSelection, setChatSelection] = useState<{ modelId: string | null; effort: string | null }>({
			modelId: chatAgentModelId ?? null,
			effort: chatAgentReasoningEffort ?? null,
		});
		// Reset only when the agent changes. A null prop must not wipe a choice the
		// user just made: the write path (board/runtime config) can lag or drop it,
		// and that made the button lose the effort it had just been given.
		const chatAgentIdRef = useRef(chatAgentId);
		useEffect(() => {
			if (chatAgentIdRef.current === chatAgentId) {
				return;
			}
			chatAgentIdRef.current = chatAgentId;
			setChatSelection({ modelId: chatAgentModelId ?? null, effort: chatAgentReasoningEffort ?? null });
		}, [chatAgentId, chatAgentModelId, chatAgentReasoningEffort]);
		// A non-null prop is authoritative (external change, session reload).
		useEffect(() => {
			setChatSelection((current) => ({
				modelId: chatAgentModelId ?? current.modelId,
				effort: chatAgentReasoningEffort ?? current.effort,
			}));
		}, [chatAgentModelId, chatAgentReasoningEffort]);
		// The composer enables the reasoning column only when the *selected* model is
		// reasoning-capable. A chat agent starts with no explicit selection, so seed it
		// with the agent's effective model — otherwise the effort column stays disabled
		// and no effort can ever be chosen or displayed.
		useEffect(() => {
			// The agent's configured default, not the first (alphabetical) catalog entry.
			const fallbackModelId = chatAgentDefaultModelId ?? chatAgentModelOptions?.[0]?.value;
			if (!fallbackModelId) {
				return;
			}
			setChatSelection((current) => (current.modelId ? current : { ...current, modelId: fallbackModelId }));
		}, [chatAgentModelOptions, chatAgentDefaultModelId]);
		const chatModelLabel = useMemo(() => {
			const label =
				chatAgentModelOptions?.find((option) => option.value === (chatSelection.modelId ?? chatAgentDefaultModelId))
					?.label ??
				chatAgentModelOptions?.[0]?.label ??
				"Default model";
			const effort = chatSelection.effort;
			if (!effort) {
				return label;
			}
			const effortLabel = effort === "xhigh" ? "Extra high" : effort.charAt(0).toUpperCase() + effort.slice(1);
			return `${label} (${effortLabel})`;
		}, [chatAgentModelOptions, chatAgentDefaultModelId, chatSelection]);
		useEffect(() => {
			if (!chatAgentId || chatAgentId === "cline") {
				setChatAgentModelOptions(null);
				setChatAgentDefaultModelId(null);
				return;
			}
			let cancelled = false;
			void fetchChatAgentModels(workspaceId ?? null, chatAgentId)
				.then((response) => {
					if (!cancelled) {
						// Same composer control as the Cline agent: the picker belongs in the
						// toolbar row, not in a separate strip above the composer.
						// Only the current agent's catalog is shown. A leftover model from a
						// previously selected agent must not be injected here, or the label
						// keeps advertising another agent's model.
						setChatAgentModelOptions(response.models.map((model) => ({ value: model.id, label: model.label })));
						setChatAgentDefaultModelId(response.defaultModelId ?? null);
					}
				})
				.catch(() => {
					if (!cancelled) {
						setChatAgentModelOptions([]);
					}
				});
			return () => {
				cancelled = true;
			};
		}, [chatAgentId, chatAgentModelId, workspaceId]);
		const isCreditLimitNoticeVisible = summary?.latestHookActivity?.notificationType === "credit_limit";
		const [mode, setMode] = useState<RuntimeTaskSessionMode>(() => {
			const persistedMode = modeByTaskIdRef.current.get(taskId);
			return persistedMode ?? summary?.mode ?? defaultMode;
		});
		const [draftImages, setDraftImages] = useState<TaskImage[]>([]);
		const clineSettings = useRuntimeSettingsClineController({
			open: true,
			workspaceId,
			selectedAgentId: "cline",
			config: runtimeConfig,
			taskAgentSettings,
		});

		const modelPickerOptions = useMemo(
			() => buildClineAgentModelPickerOptions(clineSettings.providerId, clineSettings.providerModels),
			[clineSettings.providerId, clineSettings.providerModels],
		);
		const modelOptions = modelPickerOptions.options;

		const selectedModel = useMemo(
			() => clineSettings.providerModels.find((model) => model.id === clineSettings.modelId) ?? null,
			[clineSettings.modelId, clineSettings.providerModels],
		);
		const reasoningEnabledModelIds = useMemo(
			() => getClineReasoningEnabledModelIds(clineSettings.providerModels),
			[clineSettings.providerModels],
		);

		const selectedModelButtonText = useMemo(
			() =>
				buildClineSelectedModelButtonText({
					modelOptions,
					selectedModelId: clineSettings.modelId,
					reasoningEffort: clineSettings.reasoningEffort,
					showReasoningEffort: clineSettings.selectedModelSupportsReasoningEffort,
					isModelLoading: clineSettings.isLoadingProviderModels,
					isModelSaving: isSavingModel,
				}),
			[
				clineSettings.isLoadingProviderModels,
				clineSettings.modelId,
				clineSettings.reasoningEffort,
				clineSettings.selectedModelSupportsReasoningEffort,
				isSavingModel,
				modelOptions,
			],
		);

		const panelError = composerError ?? error;
		const attachmentWarningMessage =
			draftImages.length > 0 && selectedModel?.supportsVision === false
				? "The selected Cline model may not accept image input. Choose a vision-capable model to use these images."
				: null;

		useEffect(() => {
			setComposerError(null);
		}, [taskId]);

		useEffect(() => {
			const persistedMode = modeByTaskIdRef.current.get(taskId);
			const nextMode = persistedMode ?? summary?.mode ?? defaultMode;
			modeByTaskIdRef.current.set(taskId, nextMode);
			setMode(nextMode);
			setDraftImages([]);
		}, [defaultMode, summary?.mode, taskId]);

		const handleModeChange = useCallback(
			(nextMode: RuntimeTaskSessionMode) => {
				modeByTaskIdRef.current.set(taskId, nextMode);
				setMode(nextMode);
			},
			[taskId],
		);

		type PersistClineModelSettingsOverrides = {
			modelId?: string;
			reasoningEffort?: RuntimeClineReasoningEffort | "";
		};

		const persistClineModelSettings = useCallback(
			async (overrides?: PersistClineModelSettingsOverrides): Promise<boolean> => {
				if (!workspaceId) {
					setComposerError("Select a workspace before choosing a Cline model.");
					return false;
				}
				if (clineSettings.providerId.trim().length === 0) {
					setComposerError("Choose a Cline provider in Settings before selecting a model.");
					return false;
				}
				setComposerError(null);
				setIsSavingModel(true);
				try {
					const nextModelId = overrides?.modelId ?? clineSettings.modelId;
					const nextReasoningEffort =
						overrides && "reasoningEffort" in overrides
							? overrides.reasoningEffort || ""
							: clineSettings.reasoningEffort;
					if (taskHasExplicitAgentSettings) {
						onTaskAgentSettingsChanged?.({
							providerId: clineSettings.providerId,
							modelId: nextModelId,
							reasoningEffort: nextReasoningEffort,
						});
						return true;
					}
					const result = await clineSettings.saveProviderSettings({
						modelId: nextModelId,
						reasoningEffort: nextReasoningEffort || null,
					});
					if (!result.ok) {
						setComposerError(result.message ?? "Could not save Cline model settings.");
						return false;
					}
					onAgentSettingsSaved?.();
					return true;
				} finally {
					setIsSavingModel(false);
				}
			},
			[clineSettings, onAgentSettingsSaved, onTaskAgentSettingsChanged, taskHasExplicitAgentSettings, workspaceId],
		);

		const handleSelectModel = useCallback(
			(nextModelId: string) => {
				if (nextModelId.trim() === clineSettings.modelId.trim()) {
					return;
				}
				clineSettings.setModelId(nextModelId);
				void persistClineModelSettings({ modelId: nextModelId });
			},
			[clineSettings.modelId, clineSettings.setModelId, persistClineModelSettings],
		);

		const handleSelectReasoningEffort = useCallback(
			(nextReasoningEffort: RuntimeClineReasoningEffort | "") => {
				if (nextReasoningEffort === clineSettings.reasoningEffort) {
					return;
				}
				clineSettings.setReasoningEffort(nextReasoningEffort);
				void persistClineModelSettings({ reasoningEffort: nextReasoningEffort });
			},
			[clineSettings.reasoningEffort, clineSettings.setReasoningEffort, persistClineModelSettings],
		);

		const handleAppendToDraft = useCallback(
			(text: string) => {
				const trimmed = text.trim();
				if (trimmed.length === 0) {
					return;
				}
				if (draft.trim().length === 0) {
					setDraft(trimmed);
					return;
				}
				setDraft(`${draft.trimEnd()}\n\n${trimmed}`);
			},
			[draft, setDraft],
		);

		const handleSendComposerText = useCallback(
			async (text: string): Promise<void> => {
				if (isSavingModel) {
					return;
				}
				if (clineSettings.hasUnsavedChanges) {
					const saved = await persistClineModelSettings();
					if (!saved) {
						return;
					}
				}
				await handleSendText(text, mode);
			},
			[clineSettings.hasUnsavedChanges, handleSendText, isSavingModel, mode, persistClineModelSettings],
		);

		useImperativeHandle(
			ref,
			() => ({
				appendToDraft: handleAppendToDraft,
				sendText: handleSendComposerText,
			}),
			[handleAppendToDraft, handleSendComposerText],
		);

		const handleComposerSend = useCallback(async () => {
			if (isSavingModel) {
				return;
			}
			if (clineSettings.hasUnsavedChanges) {
				const saved = await persistClineModelSettings();
				if (!saved) {
					return;
				}
			}
			const sent = await handleSendDraft(mode, draftImages);
			if (sent) {
				setDraftImages([]);
			}
		}, [
			clineSettings.hasUnsavedChanges,
			draftImages,
			handleSendDraft,
			isSavingModel,
			mode,
			persistClineModelSettings,
		]);

		return (
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				<Virtuoso
					key={taskId}
					className="min-h-0 min-w-0 flex-1"
					style={{ height: "100%" }}
					data={messages}
					initialTopMostItemIndex={messages.length > 0 ? messages.length - 1 : 0}
					computeItemKey={(_, message) => message.id}
					itemContent={(_, message) => (
						<div className="px-2 py-1">
							<ClineChatMessageItem message={message} />
						</div>
					)}
					followOutput
					atBottomThreshold={BOTTOM_LOCK_THRESHOLD_PX}
					context={{ showAgentProgressIndicator, isCreditLimitNoticeVisible }}
					components={{ Footer: ChatFooter }}
				/>
				{panelError ? (
					<div className="border-t border-status-red/30 bg-status-red/10 px-2 py-2 text-xs text-status-red">
						{panelError}
					</div>
				) : null}
				<div className="px-2 py-3">
					<ClineChatComposer
						taskId={taskId}
						draft={draft}
						onDraftChange={setDraft}
						images={draftImages}
						onImagesChange={setDraftImages}
						placeholder={composerPlaceholder}
						mode={mode}
						onModeChange={handleModeChange}
						showModeToggle={showComposerModeToggle}
						canSend={canSend}
						canCancel={canCancel}
						onSend={handleComposerSend}
						onCancel={handleCancelTurn}
						showModelPicker={showModelPicker || Boolean(chatAgentModelOptions)}
						modelOptions={chatAgentModelOptions ?? modelOptions}
						recommendedModelIds={modelPickerOptions.recommendedModelIds}
						pinSelectedModelToTop={modelPickerOptions.shouldPinSelectedModelToTop}
						selectedModelId={chatAgentId ? (chatSelection.modelId ?? "") : clineSettings.modelId}
						selectedModelButtonText={chatAgentId ? chatModelLabel : selectedModelButtonText}
						onSelectModel={
							chatAgentId
								? (value) => {
										const modelId = value || null;
										setChatSelection((current) => ({ ...current, modelId }));
										onChatAgentModelChange?.(modelId);
									}
								: handleSelectModel
						}
						// Chat agents choose effort from the dedicated control in the toolbar row; Cline's
						// in-popover effort column would be a second menu for the same setting.
						reasoningEnabledModelIds={chatAgentId ? [] : reasoningEnabledModelIds}
						extraToolbarControls={
							chatAgentId ? (
								<NativeSelect
									value={chatSelection.effort ?? ""}
									onChange={(event) => {
										const effort = event.target.value || null;
										setChatSelection((current) => ({ ...current, effort }));
										onChatAgentReasoningEffortChange?.(effort);
									}}
									aria-label="Reasoning effort"
									className="!h-7 max-w-[150px] text-micro"
								>
									<option value="">Default effort</option>
									<option value="low">Low</option>
									<option value="medium">Medium</option>
									<option value="high">High</option>
									<option value="xhigh">Extra high</option>
								</NativeSelect>
							) : null
						}
						selectedReasoningEffort={
							chatAgentId
								? (parseRuntimeClineReasoningEffort(chatSelection.effort) ?? "")
								: (parseRuntimeClineReasoningEffort(clineSettings.reasoningEffort) ?? "")
						}
						onSelectReasoningEffort={
							chatAgentId
								? (value) => {
										const effort = value || null;
										setChatSelection((current) => ({ ...current, effort }));
										onChatAgentReasoningEffortChange?.(effort);
									}
								: handleSelectReasoningEffort
						}
						isModelLoading={clineSettings.isLoadingProviderModels}
						isModelSaving={isSavingModel}
						modelPickerDisabled={
							isSavingModel || (chatAgentId ? false : clineSettings.providerId.trim().length === 0)
						}
						isSending={isSavingModel || isSending}
						warningMessage={summary?.warningMessage ?? null}
						attachmentWarningMessage={attachmentWarningMessage}
						workspaceId={workspaceId}
					/>
				</div>
				{showActionFooter ? (
					<div className="flex flex-col gap-2 px-3 pb-3">
						{showReviewActions ? (
							<div className="flex gap-2">
								<Button
									variant="primary"
									size="sm"
									fill
									disabled={isCommitLoading || isOpenPrLoading}
									onClick={onCommit}
								>
									{isCommitLoading ? "..." : "Commit"}
								</Button>
								<Button
									variant="primary"
									size="sm"
									fill
									disabled={isCommitLoading || isOpenPrLoading}
									onClick={onOpenPr}
								>
									{isOpenPrLoading ? "..." : "Open PR"}
								</Button>
							</div>
						) : null}
						{cancelAutomaticActionLabel && onCancelAutomaticAction ? (
							<Button variant="default" fill onClick={onCancelAutomaticAction}>
								{cancelAutomaticActionLabel}
							</Button>
						) : null}
						<Button variant="danger" fill disabled={isMoveToTrashLoading} onClick={onMoveToTrash}>
							{isMoveToTrashLoading ? <Spinner size={14} /> : "Move Card To Done"}
						</Button>
					</div>
				) : null}
			</div>
		);
	},
);

ClineAgentChatPanel.displayName = "ClineAgentChatPanel";
