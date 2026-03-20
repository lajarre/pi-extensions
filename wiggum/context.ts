import { readFileSync } from "node:fs";
import { join } from "node:path";
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
	guidelinesContent?: string;
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
		guidelinesContent,
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
		const fileCmds = scope === "uncommitted"
			? [
				["git", "diff", "--name-only"],
				["git", "diff", "--name-only", "--cached"],
			]
			: scope === "last-commit"
				? [["git", "diff", "--name-only", "HEAD~1"]]
				: [["git", "diff", "--name-only", "main..HEAD"]];
		const allFiles = new Set<string>();
		for (const cmd of fileCmds) {
			try {
				const fileResult = await exec(cmd[0]!, cmd.slice(1), { cwd });
				for (const f of fileResult.stdout.trim().split("\n")) {
					if (f.trim()) allFiles.add(f.trim());
				}
			} catch {
				// skip
			}
		}
		if (allFiles.size > 0) {
			parts.push("");
			parts.push("## Changed files");
			parts.push("");
			parts.push([...allFiles].sort().join("\n"));
		}
	}

	// guidelines
	if (guidelinesContent) {
		parts.push("");
		parts.push("## Guidelines");
		parts.push("");
		parts.push(guidelinesContent);
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

// ── Guidelines loading ───────────────────────────────────────

function readTrimmedOrNull(filePath: string): string | null {
	try {
		const content = readFileSync(filePath, "utf-8").trim();
		return content || null;
	} catch {
		return null;
	}
}

export async function loadProjectGuidelines(
	cwd: string,
	exec: ExecFn,
): Promise<string | null> {
	const result = await exec(
		"git", ["rev-parse", "--show-toplevel"], { cwd },
	);
	if (result.code === 0 && result.stdout.trim()) {
		const root = result.stdout.trim();
		const content = readTrimmedOrNull(
			join(root, "doc", "review-guidelines.md"),
		);
		if (content) return content;
	}
	return readTrimmedOrNull(
		join(cwd, "doc", "review-guidelines.md"),
	);
}
