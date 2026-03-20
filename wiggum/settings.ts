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
	minIterations: number;
	stopSignal: string;
	testCommand: string;
	exitScript: string | null;
	reviewPrompt: string;
}

// ── Constants ────────────────────────────────────────────────

export const SETTINGS_PATH = join(
	homedir(), ".pi", "agent", "settings.json",
);

export const DEFAULT_STOP_SIGNAL = "WIGGUM_STOP";

export const DEFAULT_MAX_ITERATIONS = 10;

export const DEFAULT_MIN_ITERATIONS = 2;

export const DEFAULT_TEST_COMMAND = "lefthook run pre-push";

export const CONVENTION_EXIT_SCRIPT = "./script/end-loop-test.sh";

export const DEFAULT_WIGGUM_REVIEW_PROMPT = `You are an independent code reviewer examining this codebase \
for the first time. You have no prior context — review with \
completely fresh eyes.

IMPORTANT: Do not limit yourself to the diff. Read the full \
source files to understand the codebase, then fix every issue \
you find — in the diff and beyond.

Look for bugs, logic errors, dead code, missing error handling, \
unnecessary complexity, API/CLI mismatches, stale docs. Fix \
issues you find directly in the files — do not just note them. \
Be thorough — this codebase will outlive you.

Treat the existing architecture as a foundation to build on. \
Improve internals, harden edge cases, add missing features — \
but preserve the public shape: types, abstractions, data \
models, and API contracts stay unless the guidelines say \
otherwise.`;

export const REVIEW_GUIDELINES_TEMPLATE = `# Review Guidelines

## review criteria

Flag issues that:
- Meaningfully impact accuracy, performance, security, or
  maintainability
- Are discrete and actionable
- Were introduced in the changes being reviewed
- The author would likely fix if aware of them

Do NOT flag:
- Pre-existing issues outside the current changes
- Style preferences enforced by formatters/linters
- Speculative impact without provable affected code

### Priority levels

Tag each finding:
- [P0] Blocking. Drop everything.
- [P1] Urgent. Next cycle.
- [P2] Normal. Fix eventually.
- [P3] Low. Nice to have.

### Review priorities

- Call out new dependencies and justify them
- Prefer simple solutions over unnecessary abstractions
- Favor fail-fast over logging-and-continue
- Flag dead code, unused state, unreachable branches
- Check error handling (codes not messages, no silent swallow)
- Check untrusted input (SQL injection, open redirects, SSRF)

## Design principles

When fixing issues, follow these principles:
- Public types and abstractions are API contracts — refactor
  their internals, don't delete them
- Data model fields are part of the persisted schema — add
  fields, don't remove existing ones
- Multi-step operations belong in named helper functions
- CLI should require explicit commands — empty input prints
  usage, never defaults to a command
- Persistence must handle user-configured paths (create parent
  directories) and fail atomically (temp file + rename)
- Option/flag parsing should handle edge cases: separator (--),
  duplicates, blank values
- Prefer idiomatic language patterns (e.g., ExitCode over
  process::exit in Rust)

## Project-specific

<!-- Add your project's review priorities here.
     Examples:
     - CLI and library API must stay in sync
     - All public functions need doc comments
     - No hardcoded file paths
     - Tests required for new behavior
-->
`;

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
	minIterations?: number;
	stopSignal?: string;
	testCommand?: string;
	exitScript?: string;
	reviewPrompt?: string;
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
		minIterations:
			typeof raw.minIterations === "number" && raw.minIterations >= 1
				? raw.minIterations
				: DEFAULT_MIN_ITERATIONS,
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
