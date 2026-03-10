import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attachEditorHook } from "../editor-hook.js";

describe("attachEditorHook", () => {
	it("installs fallback only once and preserves later custom editors", () => {
		const installed: any[] = [];
		const ui: any = {
			setEditorComponent(factory: any) {
				installed.push(factory);
			},
		};

		const wrapFactory = (factory: any) => {
			return (...args: any[]) => ({ wrapped: true, inner: factory(...args) });
		};
		const fallbackFactory = () => ({ kind: "fallback" });
		const customFactory = () => ({ kind: "custom" });

		assert.equal(attachEditorHook(ui, wrapFactory, fallbackFactory), true);
		assert.equal(installed.length, 1);
		assert.deepEqual(installed[0](), { wrapped: true, inner: { kind: "fallback" } });

		ui.setEditorComponent(customFactory);
		assert.equal(installed.length, 2);
		assert.deepEqual(installed[1](), { wrapped: true, inner: { kind: "custom" } });

		ui.setEditorComponent(undefined);
		assert.equal(installed.length, 3);
		assert.deepEqual(installed[2](), { wrapped: true, inner: { kind: "fallback" } });

		assert.equal(attachEditorHook(ui, wrapFactory, fallbackFactory), false);
		assert.equal(installed.length, 3, "should not reinstall fallback on later attaches");
	});
});
