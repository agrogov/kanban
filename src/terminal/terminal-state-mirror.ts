import type { SerializeAddon as SerializeAddonInstance } from "@xterm/addon-serialize";
import serializeAddonModule from "@xterm/addon-serialize";
import type { Terminal as HeadlessTerminalInstance, ITerminalInitOnlyOptions, ITerminalOptions } from "@xterm/headless";
import headlessTerminalModule from "@xterm/headless";

// The default imports above are the CommonJS module objects; only the constructor
// types come from the package type definitions, per AGENTS.md no-inline-imports.
const { SerializeAddon } = serializeAddonModule as {
	SerializeAddon: new () => SerializeAddonInstance;
};
const { Terminal } = headlessTerminalModule as {
	Terminal: new (options?: ITerminalOptions & ITerminalInitOnlyOptions) => HeadlessTerminalInstance;
};

/**
 * Server-side headless terminal buffer cap (1,000 lines).
 *
 * Restore serves a cached full `serialize()` of this buffer, not a viewport-only
 * slice. Output and resize mark the cache dirty; connect does not serialize on
 * every keystroke. A 10,000-line buffer caused ~60s main-thread freezes (#581)
 * and RSS spikes toward OOM (#273) during long agent runs.
 */
const TERMINAL_SCROLLBACK = 1_000;

export interface TerminalRestoreSnapshot {
	snapshot: string;
	cols: number;
	rows: number;
	restoreGeneration?: number;
}

interface TerminalStateMirrorOptions {
	onInputResponse?: (data: string) => void;
}

export class TerminalStateMirror {
	private readonly terminal: InstanceType<typeof Terminal>;
	private readonly serializeAddon = new SerializeAddon();
	private operationQueue: Promise<void> = Promise.resolve();
	private snapshotDirty = true;
	private cachedSnapshot: TerminalRestoreSnapshot | null = null;

	constructor(cols: number, rows: number, options: TerminalStateMirrorOptions = {}) {
		this.terminal = new Terminal({
			allowProposedApi: true,
			cols,
			rows,
			scrollback: TERMINAL_SCROLLBACK,
		});
		this.terminal.loadAddon(this.serializeAddon);
		this.terminal.onData((data) => {
			options.onInputResponse?.(data);
		});
	}

	applyOutput(chunk: Buffer): void {
		const chunkCopy = new Uint8Array(chunk);
		this.enqueueOperation(
			() =>
				new Promise<void>((resolve) => {
					this.terminal.write(chunkCopy, () => {
						this.snapshotDirty = true;
						resolve();
					});
				}),
		);
	}

	resize(cols: number, rows: number): void {
		if (cols === this.terminal.cols && rows === this.terminal.rows) {
			return;
		}
		this.enqueueOperation(() => {
			this.terminal.resize(cols, rows);
			this.snapshotDirty = true;
		});
	}

	async getSnapshot(): Promise<TerminalRestoreSnapshot> {
		await this.operationQueue;
		if (!this.snapshotDirty && this.cachedSnapshot) {
			return this.cachedSnapshot;
		}
		// Full serialize of the 1k buffer. Callers must not pass { scrollback: 0 }.
		this.cachedSnapshot = {
			snapshot: this.serializeAddon.serialize(),
			cols: this.terminal.cols,
			rows: this.terminal.rows,
		};
		this.snapshotDirty = false;
		return this.cachedSnapshot;
	}

	dispose(): void {
		this.terminal.dispose();
	}

	private enqueueOperation(operation: () => void | Promise<void>): void {
		this.operationQueue = this.operationQueue
			.catch(() => undefined)
			.then(async () => {
				await operation();
			});
	}
}
