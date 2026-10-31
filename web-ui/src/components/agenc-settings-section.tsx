import type React from "react";

import { Button } from "@/components/ui/button";
import type { RuntimeAgencSettingsResponse } from "@/runtime/types";

export interface AgencSettingsDraft {
	baseUrl: string;
	model: string;
	/** Newly typed key; empty keeps the stored one. */
	apiKey: string;
	clearApiKey: boolean;
}

export const EMPTY_AGENC_SETTINGS_DRAFT: AgencSettingsDraft = {
	baseUrl: "",
	model: "",
	apiKey: "",
	clearApiKey: false,
};

export function createAgencSettingsDraft(settings: RuntimeAgencSettingsResponse | undefined): AgencSettingsDraft {
	return {
		...EMPTY_AGENC_SETTINGS_DRAFT,
		baseUrl: settings?.baseUrl ?? "",
		model: settings?.model ?? "",
	};
}

export function hasAgencSettingsChanges(
	draft: AgencSettingsDraft,
	settings: RuntimeAgencSettingsResponse | undefined,
): boolean {
	return (
		draft.baseUrl.trim() !== (settings?.baseUrl ?? "") ||
		draft.model.trim() !== (settings?.model ?? "") ||
		draft.apiKey.trim().length > 0 ||
		draft.clearApiKey
	);
}

const INPUT_CLASS_NAME =
	"h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none disabled:opacity-40";

export function AgencSettingsSection({
	draft,
	apiKeyConfigured,
	disabled,
	onChange,
}: {
	draft: AgencSettingsDraft;
	apiKeyConfigured: boolean;
	disabled: boolean;
	onChange: (next: AgencSettingsDraft) => void;
}): React.ReactElement {
	const hasStoredKey = apiKeyConfigured && !draft.clearApiKey;
	return (
		<div className="rounded-lg border border-border bg-surface-0 px-4 py-3 mb-4">
			<h6 className="text-[12px] font-semibold uppercase tracking-wider text-text-secondary m-0 mb-1">AgenC</h6>
			<p className="text-text-secondary text-[12px] mt-0 mb-3">
				Connects AgenC to any OpenAI-compatible endpoint. Leave everything empty to use the provider configured by{" "}
				<code>agenc onboard</code>.
			</p>
			<div className="grid gap-2">
				<div className="min-w-0">
					<p className="text-text-secondary text-[12px] mt-0 mb-1">API base URL</p>
					<input
						value={draft.baseUrl}
						onChange={(event) => onChange({ ...draft, baseUrl: event.target.value })}
						placeholder="https://api.example.com/v1"
						disabled={disabled}
						className={INPUT_CLASS_NAME}
					/>
				</div>
				<div className="min-w-0">
					<p className="text-text-secondary text-[12px] mt-0 mb-1">Model</p>
					<input
						value={draft.model}
						onChange={(event) => onChange({ ...draft, model: event.target.value })}
						placeholder="model-name"
						disabled={disabled}
						className={INPUT_CLASS_NAME}
					/>
				</div>
				<div className="min-w-0">
					<p className="text-text-secondary text-[12px] mt-0 mb-1">API key</p>
					<div className="flex items-center gap-2">
						<input
							type="password"
							value={draft.apiKey}
							onChange={(event) => onChange({ ...draft, apiKey: event.target.value, clearApiKey: false })}
							placeholder={hasStoredKey ? "Saved - type to replace" : "sk-..."}
							disabled={disabled}
							autoComplete="off"
							className={INPUT_CLASS_NAME}
						/>
						{hasStoredKey ? (
							<Button
								size="sm"
								variant="ghost"
								disabled={disabled}
								onClick={() => onChange({ ...draft, apiKey: "", clearApiKey: true })}
							>
								Clear
							</Button>
						) : null}
					</div>
					<p className="text-text-tertiary text-[11px] mt-1 mb-0">
						Stored unencrypted in Kanban's global config file and passed to AgenC as OPENAI_COMPATIBLE_API_KEY.
					</p>
				</div>
			</div>
		</div>
	);
}
