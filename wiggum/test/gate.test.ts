import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	evaluateGate,
	type GateConfig,
	hasStopSignal,
	matchesContinuePattern,
	matchesExitPattern,
	runCommand,
	shouldStop,
} from "../gate.js";
import type { ExecFn } from "../settings.js";

// ── Helpers ──────────────────────────────────────────────────

function mockExec(code: number, stdout = "", stderr = ""): ExecFn {
	return async () => ({ stdout, stderr, code });
}

function gateConfig(overrides: Partial<GateConfig> = {}): GateConfig {
	return {
		stopSignal: "WIGGUM_STOP",
		testCommand: "echo ok",
		exitScript: null,
		...overrides,
	};
}

// ── hasStopSignal ────────────────────────────────────────────

describe("hasStopSignal", () => {
	it("detects exact signal in output", () => {
		assert.ok(hasStopSignal("review complete\nWIGGUM_STOP\n", "WIGGUM_STOP"));
	});

	it("detects signal mid-text", () => {
		assert.ok(hasStopSignal("all good WIGGUM_STOP done", "WIGGUM_STOP"));
	});

	it("rejects when signal absent", () => {
		assert.ok(!hasStopSignal("no issues found", "WIGGUM_STOP"));
	});

	it("is case-sensitive", () => {
		assert.ok(!hasStopSignal("wiggum_stop", "WIGGUM_STOP"));
	});

	it("works with custom signal", () => {
		assert.ok(hasStopSignal("done CUSTOM_DONE_TOKEN", "CUSTOM_DONE_TOKEN"));
	});
});

// ── matchesExitPattern (fallback regex) ──────────────────────

describe("matchesExitPattern", () => {
	it("matches 'no issues found'", () => {
		assert.ok(matchesExitPattern("After review, no issues found."));
	});

	it("matches 'no bugs found'", () => {
		assert.ok(matchesExitPattern("No bugs found in this code."));
	});

	it("matches 'looks good'", () => {
		assert.ok(matchesExitPattern("Code review complete.\nLooks good.\n"));
	});

	it("rejects unrelated text", () => {
		assert.ok(!matchesExitPattern("Fixed 3 bugs in auth module."));
	});
});

// ── matchesContinuePattern ───────────────────────────────────

describe("matchesContinuePattern", () => {
	it("matches 'fixed 3 issues'", () => {
		assert.ok(matchesContinuePattern("Fixed 3 issues in the codebase."));
	});

	it("matches 'ready for another review'", () => {
		assert.ok(matchesContinuePattern("Ready for another review."));
	});

	it("matches 'issues:'", () => {
		assert.ok(matchesContinuePattern("Issues:\n- bug in auth\n- missing test"));
	});

	it("rejects clean output", () => {
		assert.ok(!matchesContinuePattern("WIGGUM_STOP"));
	});
});

// ── shouldStop ───────────────────────────────────────────────

describe("shouldStop", () => {
	it("true on explicit stop signal", () => {
		assert.ok(shouldStop("review done\nWIGGUM_STOP", "WIGGUM_STOP"));
	});

	it("true on stop signal even with continue pattern", () => {
		// explicit signal overrides continue patterns
		assert.ok(shouldStop("Fixed 1 issue.\nWIGGUM_STOP", "WIGGUM_STOP"));
	});

	it("true on fallback exit pattern without continue", () => {
		assert.ok(shouldStop("No issues found.", "WIGGUM_STOP"));
	});

	it("false on fallback exit pattern WITH continue", () => {
		assert.ok(!shouldStop(
			"Fixed 2 issues. No further issues found.",
			"WIGGUM_STOP",
		));
	});

	it("false when no signal and no exit pattern", () => {
		assert.ok(!shouldStop("I made some changes.", "WIGGUM_STOP"));
	});
});

// ── runCommand ───────────────────────────────────────────────

describe("runCommand", () => {
	it("returns ok: true on exit 0", async () => {
		const result = await runCommand("echo ok", "/tmp", mockExec(0, "ok"));
		assert.ok(result.ok);
		assert.equal(result.output, "ok");
	});

	it("returns ok: false on nonzero exit", async () => {
		const result = await runCommand("fail", "/tmp", mockExec(1, "", "err"));
		assert.ok(!result.ok);
		assert.equal(result.output, "err");
	});

	it("handles exec throwing", async () => {
		const throwing: ExecFn = async () => {
			throw new Error("exec failed");
		};
		const result = await runCommand("cmd", "/tmp", throwing);
		assert.ok(!result.ok);
		assert.ok(result.output.includes("exec failed"));
	});
});

// ── evaluateGate ─────────────────────────────────────────────

describe("evaluateGate", () => {
	it("stops when all layers pass", async () => {
		const result = await evaluateGate(
			"WIGGUM_STOP",
			gateConfig({ exitScript: "./ok.sh" }),
			"/tmp",
			mockExec(0, "ok"),
		);
		assert.ok(result.shouldStop);
		assert.equal(result.reason, "all gates passed");
		assert.equal(result.testOutput, "ok");
	});

	it("continues when tests fail", async () => {
		const result = await evaluateGate(
			"WIGGUM_STOP",
			gateConfig(),
			"/tmp",
			mockExec(1, "", "test failed"),
		);
		assert.ok(!result.shouldStop);
		assert.ok(result.reason.includes("tests failed"));
	});

	it("continues when agent did not signal", async () => {
		const result = await evaluateGate(
			"I made changes but more to do",
			gateConfig(),
			"/tmp",
			mockExec(0),
		);
		assert.ok(!result.shouldStop);
		assert.equal(result.reason, "agent did not signal completion");
	});

	it("continues when exit script fails", async () => {
		let callCount = 0;
		const exec: ExecFn = async () => {
			callCount++;
			// first call (test command) passes, second (exit script) fails
			return callCount === 1
				? { stdout: "", stderr: "", code: 0 }
				: { stdout: "", stderr: "script failed", code: 1 };
		};

		const result = await evaluateGate(
			"WIGGUM_STOP",
			gateConfig({ exitScript: "./check.sh" }),
			"/tmp",
			exec,
		);
		assert.ok(!result.shouldStop);
		assert.ok(result.reason.includes("exit script failed"));
	});

	it("skips layer 3 when no exit script", async () => {
		// with no exitScript, layer 3 is skipped — test already passed
		const result = await evaluateGate(
			"WIGGUM_STOP",
			gateConfig({ exitScript: null }),
			"/tmp",
			mockExec(0, "ok"),
		);
		assert.ok(result.shouldStop);
		assert.equal(result.reason, "all gates passed (no exit script)");
	});

	// ── minIterations ────────────────────────────────────────

	it("respects minIterations — blocks early exit", async () => {
		const result = await evaluateGate(
			"WIGGUM_STOP",
			gateConfig({ minIterations: 3 }),
			"/tmp",
			mockExec(0, "ok"),
			1, // currentIteration
		);
		assert.ok(!result.shouldStop);
		assert.ok(result.reason.includes("below minimum"));
	});

	it("allows exit at minIterations", async () => {
		const result = await evaluateGate(
			"WIGGUM_STOP",
			gateConfig({ minIterations: 2 }),
			"/tmp",
			mockExec(0, "ok"),
			2, // currentIteration
		);
		assert.ok(result.shouldStop);
	});

	it("allows exit above minIterations", async () => {
		const result = await evaluateGate(
			"WIGGUM_STOP",
			gateConfig({ minIterations: 2 }),
			"/tmp",
			mockExec(0, "ok"),
			5,
		);
		assert.ok(result.shouldStop);
	});

	// ── output fields / warnings ─────────────────────────────

	it("warns when test command produces no output", async () => {
		const result = await evaluateGate(
			"WIGGUM_STOP",
			gateConfig({ minIterations: 1 }),
			"/tmp",
			mockExec(0, ""), // empty output
			1,
		);
		assert.ok(result.shouldStop); // still passes
		assert.ok(result.reason.includes("warning"));
		assert.ok(result.reason.includes("no output"));
	});
});
