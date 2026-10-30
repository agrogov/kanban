import { Menu, type BrowserWindow } from "electron";

/**
 * Electron renderers have no built-in right-click menu, so text can't be
 * copied from the UI without keyboard shortcuts. Offer the standard edit
 * actions for selections and editable fields.
 */
export function attachContextMenu(window: BrowserWindow): void {
	window.webContents.on("context-menu", (_event, params) => {
		const { isEditable, selectionText, editFlags } = params;
		const hasSelection = selectionText.trim().length > 0;
		if (!isEditable && !hasSelection) {
			return;
		}
		const template: Electron.MenuItemConstructorOptions[] = isEditable
			? [
					{ role: "undo", enabled: editFlags.canUndo },
					{ role: "redo", enabled: editFlags.canRedo },
					{ type: "separator" },
					{ role: "cut", enabled: editFlags.canCut },
					{ role: "copy", enabled: editFlags.canCopy },
					{ role: "paste", enabled: editFlags.canPaste },
					{ role: "selectAll", enabled: editFlags.canSelectAll },
				]
			: [{ role: "copy" }, { role: "selectAll" }];
		Menu.buildFromTemplate(template).popup({ window });
	});
}
