import type { ReactElement } from "react";

import { NativeSelect } from "@/components/ui/native-select";
import type { RuntimeTaskAgentSettings } from "@/runtime/types";

export interface OpaqueSelectOption {
	value: string;
	label: string;
}

/** Dropdown with a leading "Default" entry; keeps a stored value visible even if the catalog lacks it. */
function OpaqueSelect({
	value,
	options,
	ariaLabel,
	onChange,
}: {
	value: string;
	options: OpaqueSelectOption[];
	ariaLabel: string;
	onChange: (value: string) => void;
}): ReactElement {
	const hasValue = !value || options.some((option) => option.value === value);
	return (
		<NativeSelect
			size="sm"
			fill
			value={value}
			aria-label={ariaLabel}
			onChange={(e) => onChange(e.currentTarget.value)}
		>
			<option value="">Default</option>
			{hasValue ? null : <option value={value}>{value}</option>}
			{options.map((option) => (
				<option key={option.value} value={option.value}>
					{option.label}
				</option>
			))}
		</NativeSelect>
	);
}

export function OpaqueTaskAgentSettingsFields({
	agentSettings,
	agentLabel,
	docsUrl,
	showModelInput,
	showEffortInput,
	modelOptions,
	effortOptions,
	onModelChange,
	onEffortChange,
}: {
	agentSettings: RuntimeTaskAgentSettings | undefined;
	agentLabel: string;
	docsUrl: string | undefined;
	showModelInput: boolean;
	showEffortInput: boolean;
	/** When set, the model field is a dropdown instead of free text. */
	modelOptions?: OpaqueSelectOption[] | undefined;
	/** When set, the effort field is a dropdown instead of free text. */
	effortOptions?: OpaqueSelectOption[] | undefined;
	onModelChange: (value: string) => void;
	onEffortChange: (value: string) => void;
}): ReactElement | null {
	if (!showModelInput && !showEffortInput) {
		return null;
	}

	return (
		<div className="flex flex-col gap-2">
			<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
				{showModelInput ? (
					<div className="min-w-0">
						<span className="text-micro text-text-secondary block mb-1">Model</span>
						{modelOptions ? (
							<OpaqueSelect
								value={agentSettings?.modelId ?? ""}
								options={modelOptions}
								ariaLabel="Model override"
								onChange={onModelChange}
							/>
						) : (
							<input
								type="text"
								value={agentSettings?.modelId ?? ""}
								onChange={(e) => onModelChange(e.currentTarget.value)}
								placeholder="Model ID"
								aria-label="Model override"
								className="w-full rounded-md border border-border bg-surface-2 px-2 py-1.5 text-label text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
							/>
						)}
					</div>
				) : null}
				{showEffortInput ? (
					<div className="min-w-0">
						<span className="text-micro text-text-secondary block mb-1">Reasoning effort</span>
						{effortOptions ? (
							<OpaqueSelect
								value={agentSettings?.reasoningEffort ?? ""}
								options={effortOptions}
								ariaLabel="Reasoning effort override"
								onChange={onEffortChange}
							/>
						) : (
							<input
								type="text"
								value={agentSettings?.reasoningEffort ?? ""}
								onChange={(e) => onEffortChange(e.currentTarget.value)}
								placeholder="Effort level"
								aria-label="Reasoning effort override"
								className="w-full rounded-md border border-border bg-surface-2 px-2 py-1.5 text-label text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
							/>
						)}
					</div>
				) : null}
			</div>
			{docsUrl ? (
				<a
					href={docsUrl}
					target="_blank"
					rel="noreferrer"
					className="w-fit text-micro text-accent hover:text-accent-hover"
				>
					{agentLabel} CLI reference
				</a>
			) : null}
		</div>
	);
}
