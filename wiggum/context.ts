import type { ExecFn } from "./settings.js";
import { DEFAULT_WIGGUM_REVIEW_PROMPT } from "./settings.js";

// ── Types ────────────────────────────────────────────────────

export type ReviewScope =
	| "uncommitted"
	| "last-commit"
	| "branch"
	| string;  // freeform

export interface ContextOptions {
	iteration: number;
	maxIterations: number;
	scope: ReviewScope;
	cwd: string;
	exec: ExecFn;
	reviewPrompt?: string;
	focus?: string;
	stopSignal?: string;
}

// ── Diff commands ────────────────────────────────────────────

export function getDiffCommands(scope: ReviewScope): string[][] {
	switch (scope) {
		case "uncommitted":
			return [
				["git", "diff"],
				["git", "diff", "--cached"],
			];
		case "last-commit":
			return [["git", "diff", "HEAD~1"]];
		case "branch":
			return [["git", "diff", "main..HEAD"]];
		default:
			// freeform — no diff
			return [];
	}
}

export function isFreeform(scope: ReviewScope): boolean {
	return scope !== "uncommitted"
		&& scope !== "last-commit"
		&& scope !== "branch";
}

// ── Stop signal block ────────────────────────────────────────

export function buildStopSignalBlock(signal: string): string {
	return `<EXTREMELY-IMPORTANT>
When you have completed your review:
- If you found and fixed issues: describe what you fixed.
  Do NOT include ${signal}.
- If you found NO issues after thorough review: reply with
  exactly ${signal} on its own line. This is the ONLY way
  to signal that the review is complete.
</EXTREMELY-IMPORTANT>`;
}

// ── Context assembly ─────────────────────────────────────────

export async function assembleQualityContext(
	options: ContextOptions,
): Promise<string> {
	const {
		iteration,
		maxIterations,
		scope,
		cwd,
		exec,
		reviewPrompt = DEFAULT_WIGGUM_REVIEW_PROMPT,
		focus,
		stopSignal = "WIGGUM_STOP",
	} = options;

	const parts: string[] = [];

	parts.push(`# Code Review (iteration ${iteration} of ${maxIterations})`);
	parts.push("");
	parts.push(
		"You are a fresh code reviewer. You have never seen this "
		+ "codebase before. Review the following changes with fresh eyes.",
	);

	// changes section
	parts.push("");
	parts.push("## Changes to review");
	parts.push("");

	if (isFreeform(scope)) {
		parts.push(scope);
	} else {
		const commands = getDiffCommands(scope);
		const diffs: string[] = [];
		for (const cmd of commands) {
			try {
				const result = await exec(cmd[0]!, cmd.slice(1), { cwd });
				if (result.stdout.trim()) {
					diffs.push(result.stdout.trim());
				}
			} catch {
				// skip failed diff commands
			}
		}
		if (diffs.length > 0) {
			parts.push("```diff");
			parts.push(diffs.join("\n\n"));
			parts.push("```");
		} else {
			parts.push("(no changes detected)");
		}

		// changed file list
		const fileCmd = scope === "uncommitted"
			? ["git", "diff", "--name-only"]
			: scope === "last-commit"
				? ["git", "diff", "--name-only", "HEAD~1"]
				: ["git", "diff", "--name-only", "main..HEAD"];
		try {
			const fileResult = await exec(fileCmd[0]!, fileCmd.slice(1), { cwd });
			const files = fileResult.stdout.trim();
			if (files) {
				parts.push("");
				parts.push("## Changed files");
				parts.push("");
				parts.push(files);
			}
		} catch {
			// skip
		}
	}

	// instructions
	parts.push("");
	parts.push("## Instructions");
	parts.push("");
	parts.push(reviewPrompt);

	if (focus) {
		parts.push("");
		parts.push(`**Additional focus:** ${focus}`);
	}

	// stop signal — always last
	parts.push("");
	parts.push(buildStopSignalBlock(stopSignal));

	return parts.join("\n");
}
