import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_MAX_ITERATIONS,
	DEFAULT_MIN_ITERATIONS,
	DEFAULT_STOP_SIGNAL,
	DEFAULT_TEST_COMMAND,
	DEFAULT_WIGGUM_REVIEW_PROMPT,
	REVIEW_GUIDELINES_TEMPLATE,
	resolveExitScript,
	type WiggumSettings,
} from "../settings.js";

function defaultSettings(overrides: Partial<WiggumSettings> = {}): WiggumSettings {
	return {
		maxIterations: DEFAULT_MAX_ITERATIONS,
		minIterations: DEFAULT_MIN_ITERATIONS,
		stopSignal: DEFAULT_STOP_SIGNAL,
		testCommand: DEFAULT_TEST_COMMAND,
		exitScript: null,
		reviewPrompt: DEFAULT_WIGGUM_REVIEW_PROMPT,
		...overrides,
	};
}

describe("resolveExitScript", () => {
	it("returns env var when set", () => {
		const result = resolveExitScript(
			defaultSettings(),
			"/tmp",
			{ WIGGUM_EXIT_SCRIPT: "/path/to/script.sh" },
		);
		assert.equal(result, "/path/to/script.sh");
	});

	it("env var takes precedence over settings", () => {
		const result = resolveExitScript(
			defaultSettings({ exitScript: "/settings/script.sh" }),
			"/tmp",
			{ WIGGUM_EXIT_SCRIPT: "/env/script.sh" },
		);
		assert.equal(result, "/env/script.sh");
	});

	it("returns settings exitScript when env var absent", () => {
		const result = resolveExitScript(
			defaultSettings({ exitScript: "/settings/script.sh" }),
			"/tmp",
			{},
		);
		assert.equal(result, "/settings/script.sh");
	});

	it("returns null when nothing configured and convention path missing", () => {
		const result = resolveExitScript(
			defaultSettings(),
			"/nonexistent/path",
			{},
		);
		assert.equal(result, null);
	});

	it("ignores empty/whitespace env var", () => {
		const result = resolveExitScript(
			defaultSettings({ exitScript: "/settings/script.sh" }),
			"/tmp",
			{ WIGGUM_EXIT_SCRIPT: "  " },
		);
		assert.equal(result, "/settings/script.sh");
	});
});

describe("default constants", () => {
	it("DEFAULT_MAX_ITERATIONS is 10", () => {
		assert.equal(DEFAULT_MAX_ITERATIONS, 10);
	});

	it("DEFAULT_STOP_SIGNAL is WIGGUM_STOP", () => {
		assert.equal(DEFAULT_STOP_SIGNAL, "WIGGUM_STOP");
	});

	it("DEFAULT_TEST_COMMAND is lefthook", () => {
		assert.equal(DEFAULT_TEST_COMMAND, "lefthook run pre-push");
	});

	it("review prompt is non-empty", () => {
		assert.ok(DEFAULT_WIGGUM_REVIEW_PROMPT.length > 50);
	});

	it("DEFAULT_MIN_ITERATIONS is 2", () => {
		assert.equal(DEFAULT_MIN_ITERATIONS, 2);
	});
});

describe("REVIEW_GUIDELINES_TEMPLATE", () => {
	it("is non-empty", () => {
		assert.ok(REVIEW_GUIDELINES_TEMPLATE.length > 0);
	});

	it("contains key headings", () => {
		assert.ok(REVIEW_GUIDELINES_TEMPLATE.includes("## review criteria"));
		assert.ok(REVIEW_GUIDELINES_TEMPLATE.includes("### Priority levels"));
		assert.ok(REVIEW_GUIDELINES_TEMPLATE.includes("### Review priorities"));
		assert.ok(REVIEW_GUIDELINES_TEMPLATE.includes("## Project-specific"));
	});
});
