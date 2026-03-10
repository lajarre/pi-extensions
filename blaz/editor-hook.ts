export interface EditorHookUI {
	setEditorComponent: (factory: any) => any;
	__blazEditorHooked?: boolean;
}

export function attachEditorHook(
	ui: EditorHookUI,
	wrapFactory: (factory: any) => any,
	fallbackFactory: any,
): boolean {
	if (ui.__blazEditorHooked) return false;
	const original = ui.setEditorComponent.bind(ui);
	const wrappedFallback = wrapFactory(fallbackFactory);
	ui.setEditorComponent = (factory: any) => {
		if (factory === undefined) return original(wrappedFallback);
		return original(wrapFactory(factory));
	};
	ui.__blazEditorHooked = true;
	original(wrappedFallback);
	return true;
}
