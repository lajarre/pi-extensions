import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Types ────────────────────────────────────────────────────

export type ExecFn = (
	command: string,
	args: string[],
	options?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface WiggumSettings {
	maxIterations: number;
	stopSignal: string;
	testCommand: string;
	exitScript: string | null;
	reviewPrompt: string;
	logFile: string;
}

// ── Constants ────────────────────────────────────────────────

export const SETTINGS_PATH = join(
	homedir(), ".pi", "agent", "settings.json",
);

export const DEFAULT_STOP_SIGNAL = "WIGGUM_STOP";

export const DEFAULT_MAX_ITERATIONS = 10;

export const DEFAULT_TEST_COMMAND = "lefthook run pre-push";

export const CONVENTION_EXIT_SCRIPT = "./script/end-loop-test.sh";

export const DEFAULT_WIGGUM_REVIEW_PROMPT = `You are an independent code reviewer examining changes for the \
first time. You have no prior context about these changes — \
review with completely fresh eyes.

Question everything: does each line need to exist? Look for bugs, \
logic errors, dead code, missing error handling, unnecessary \
complexity.

If you find issues, fix them directly in the files. Be thorough \
— this codebase will outlive you.`;

/**
 * Fallback exit patterns — copied from pi-review-loop.
 * Used when the agent ignores the WIGGUM_STOP instruction.
 */
export const FALLBACK_EXIT_PATTERNS: RegExp[] = [
	/no\s+(\w+\s+)?issues\s+found/i,
	/no\s+(\w+\s+)?bugs\s+found/i,
	/(?:^|\n)\s*(?:looks\s+good|all\s+good)[\s.,!]*(?:$|\n)/im,
];

export const FALLBACK_CONTINUE_PATTERNS: RegExp[] = [
	/fixed\s+\d+\s+issues?/i,
	/ready\s+for\s+(another|the\s+next)\s+review/i,
	/(issues|bugs|problems|changes|fixes)\s*:/i,
];

// ── Settings loader ──────────────────────────────────────────

interface RawSettings {
	maxIterations?: number;
	stopSignal?: string;
	testCommand?: string;
	exitScript?: string;
	reviewPrompt?: string;
	logFile?: string;
}

export function loadSettings(): WiggumSettings {
	let raw: RawSettings = {};
	try {
		const content = readFileSync(SETTINGS_PATH, "utf-8");
		const parsed = JSON.parse(content);
		raw = parsed?.wiggumLoop ?? {};
	} catch {
		// defaults
	}

	return {
		maxIterations:
			typeof raw.maxIterations === "number" && raw.maxIterations >= 1
				? raw.maxIterations
				: DEFAULT_MAX_ITERATIONS,
		stopSignal:
			typeof raw.stopSignal === "string" && raw.stopSignal.trim()
				? raw.stopSignal.trim()
				: DEFAULT_STOP_SIGNAL,
		testCommand:
			typeof raw.testCommand === "string" && raw.testCommand.trim()
				? raw.testCommand.trim()
				: DEFAULT_TEST_COMMAND,
		exitScript:
			typeof raw.exitScript === "string" && raw.exitScript.trim()
				? raw.exitScript.trim()
				: null,
		reviewPrompt:
			typeof raw.reviewPrompt === "string" && raw.reviewPrompt.trim()
				? raw.reviewPrompt.trim()
				: DEFAULT_WIGGUM_REVIEW_PROMPT,
		logFile:
			typeof raw.logFile === "string" && raw.logFile.trim()
				? raw.logFile.trim()
				: "wiggum-log.jsonl",
	};
}

// ── Exit script resolution ───────────────────────────────────

export function resolveExitScript(
	settings: WiggumSettings,
	cwd: string,
	env: Record<string, string | undefined> = process.env,
): string | null {
	// 1. env var
	const envScript = env.WIGGUM_EXIT_SCRIPT?.trim();
	if (envScript) return envScript;

	// 2. settings
	if (settings.exitScript) return settings.exitScript;

	// 3. convention path
	const conventionPath = join(cwd, CONVENTION_EXIT_SCRIPT);
	if (existsSync(conventionPath)) return conventionPath;

	// 4. fallback — null means use test command
	return null;
}
