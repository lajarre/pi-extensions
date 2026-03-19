import {
	FALLBACK_CONTINUE_PATTERNS,
	FALLBACK_EXIT_PATTERNS,
	type ExecFn,
} from "./settings.js";

// ── Types ────────────────────────────────────────────────────

export interface GateConfig {
	stopSignal: string;
	testCommand: string;
	exitScript: string | null;
	minIterations?: number;
}

export interface CommandResult {
	ok: boolean;
	output: string;
}

export interface GateResult {
	shouldStop: boolean;
	reason: string;
	testOutput?: string;
	exitScriptOutput?: string;
}

// ── Signal detection ─────────────────────────────────────────

export function hasStopSignal(output: string, signal: string): boolean {
	return output.includes(signal);
}

export function matchesExitPattern(
	output: string,
	patterns: RegExp[] = FALLBACK_EXIT_PATTERNS,
): boolean {
	return patterns.some((p) => p.test(output));
}

export function matchesContinuePattern(
	output: string,
	patterns: RegExp[] = FALLBACK_CONTINUE_PATTERNS,
): boolean {
	return patterns.some((p) => p.test(output));
}

/**
 * Determine if agent output signals "done."
 *
 * Primary: explicit stop signal token.
 * Fallback: pi-review-loop-style regex (for when agent ignores
 * the instruction).
 */
export function shouldStop(output: string, signal: string): boolean {
	if (hasStopSignal(output, signal)) return true;

	// fallback regex path
	return matchesExitPattern(output)
		&& !matchesContinuePattern(output);
}

// ── Command execution ────────────────────────────────────────

export async function runCommand(
	cmd: string,
	cwd: string,
	exec: ExecFn,
): Promise<CommandResult> {
	try {
		const result = await exec("bash", ["-c", cmd], { cwd });
		return {
			ok: result.code === 0,
			output: (result.stdout + result.stderr).trim(),
		};
	} catch (err) {
		return {
			ok: false,
			output: err instanceof Error ? err.message : String(err),
		};
	}
}

// ── Three-layer gate ─────────────────────────────────────────

/**
 * Evaluate the full three-layer exit gate.
 *
 * Layer 1: test command (always runs)
 * Layer 2: agent stop signal
 * Layer 3: exit script (or fallback to test command)
 *
 * Tests run first. If tests fail, we loop regardless.
 * Signal is checked only if tests pass.
 * Exit script runs only if both tests pass and signal present.
 */
export async function evaluateGate(
	agentOutput: string,
	config: GateConfig,
	cwd: string,
	exec: ExecFn,
	currentIteration?: number,
): Promise<GateResult> {
	// layer 1: test command
	const testResult = await runCommand(config.testCommand, cwd, exec);
	if (!testResult.ok) {
		return {
			shouldStop: false,
			reason: `tests failed: ${testResult.output.slice(0, 200)}`,
			testOutput: testResult.output,
		};
	}

	const testWarning = testResult.output.trim() === ""
		? "warning: test command produced no output (may not have run)"
		: undefined;

	// layer 2: agent signal
	const agentDone = shouldStop(agentOutput, config.stopSignal);
	if (!agentDone) {
		return {
			shouldStop: false,
			reason: "agent did not signal completion",
			testOutput: testResult.output,
		};
	}

	// minIterations check: ignore stop signal if below minimum
	if (
		config.minIterations != null
		&& currentIteration != null
		&& currentIteration < config.minIterations
	) {
		return {
			shouldStop: false,
			reason: `below minimum iterations (${currentIteration}/${config.minIterations})`,
			testOutput: testResult.output,
		};
	}

	// skip layer 3 when no exit script — test already passed
	if (!config.exitScript) {
		const reasonParts = ["all gates passed (no exit script)"];
		if (testWarning) reasonParts.push(testWarning);
		return {
			shouldStop: true,
			reason: reasonParts.join(" — "),
			testOutput: testResult.output,
		};
	}

	// layer 3: exit script
	const exitCmd = config.exitScript;
	const exitResult = await runCommand(exitCmd, cwd, exec);
	if (!exitResult.ok) {
		return {
			shouldStop: false,
			reason: `exit script failed: ${exitResult.output.slice(0, 200)}`,
			testOutput: testResult.output,
			exitScriptOutput: exitResult.output,
		};
	}

	const reasonParts = ["all gates passed"];
	if (testWarning) reasonParts.push(testWarning);
	return {
		shouldStop: true,
		reason: reasonParts.join(" — "),
		testOutput: testResult.output,
		exitScriptOutput: exitResult.output,
	};
}
