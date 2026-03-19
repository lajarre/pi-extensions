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
}

export interface CommandResult {
	ok: boolean;
	output: string;
}

export interface GateResult {
	shouldStop: boolean;
	reason: string;
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
): Promise<GateResult> {
	// layer 1: test command
	const testResult = await runCommand(config.testCommand, cwd, exec);
	if (!testResult.ok) {
		return {
			shouldStop: false,
			reason: `tests failed: ${testResult.output.slice(0, 200)}`,
		};
	}

	// layer 2: agent signal
	const agentDone = shouldStop(agentOutput, config.stopSignal);
	if (!agentDone) {
		return {
			shouldStop: false,
			reason: "agent did not signal completion",
		};
	}

	// skip layer 3 when no exit script — test already passed
	if (!config.exitScript) {
		return { shouldStop: true, reason: "all gates passed (no exit script)" };
	}

	// layer 3: exit script
	const exitCmd = config.exitScript;
	const exitResult = await runCommand(exitCmd, cwd, exec);
	if (!exitResult.ok) {
		return {
			shouldStop: false,
			reason: `exit script failed: ${exitResult.output.slice(0, 200)}`,
		};
	}

	return { shouldStop: true, reason: "all gates passed" };
}
