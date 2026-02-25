/**
 * Post-Compact Reminder
 *
 * After compaction, the agent loses AGENTS.md context. This extension
 * detects compaction and injects a reminder on the next turn, telling
 * the agent to re-read AGENTS.md before proceeding.
 *
 * Inspired by the concept from:
 *   https://github.com/Dicklesworthstone/post_compact_reminder
 *   by Jeffrey Emanuel (MIT + OpenAI/Anthropic Rider)
 *
 * This is a clean-room reimplementation for Pi's extension system —
 * no code was copied from the original project.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

export default function (pi: ExtensionAPI) {
	let compactedSinceLastTurn = false;

	// 1. Detect compaction — set the flag
	pi.on("session_compact", async (_event, ctx) => {
		compactedSinceLastTurn = true;
		ctx.ui.setStatus(
			"post-compact",
			ctx.ui.theme.fg("warning", "⚠ Compacted — reminder queued")
		);
	});

	// 2. On next agent turn, inject the reminder
	pi.on("before_agent_start", async (event, ctx) => {
		if (!compactedSinceLastTurn) return;
		compactedSinceLastTurn = false;
		ctx.ui.setStatus("post-compact", undefined); // clear footer

		// Locate AGENTS.md — project-local first, then global
		const candidates = [
			resolve(ctx.cwd, "AGENTS.md"),
			resolve(ctx.cwd, ".pi", "AGENTS.md"),
		];
		const agentsMd = candidates.find((p) => existsSync(p)) ?? "AGENTS.md";

		const reminder = [
			"🚨 IMPORTANT: Context was just compacted. STOP.",
			"",
			"Before proceeding with ANY task you MUST:",
			`1. Re-read ${agentsMd} completely`,
			"2. Check the current working state: git status, git log --oneline -5",
			"3. Briefly confirm what key rules and conventions you found",
			"",
			"Do NOT continue until you have done this.",
		].join("\n");

		return {
			message: {
				customType: "post-compact-reminder",
				content: reminder,
				display: true,
			},
		};
	});

	// 3. Also catch session_start to handle compactions from a previous session
	//    that was restored mid-compaction (edge case)
	pi.on("session_start", async (_event, ctx) => {
		const branch = ctx.sessionManager.getBranch();
		if (branch.length === 0) return;

		const lastEntry = branch[branch.length - 1];
		if (lastEntry.type === "compaction") {
			compactedSinceLastTurn = true;
			ctx.ui.setStatus(
				"post-compact",
				ctx.ui.theme.fg("warning", "⚠ Session resumed after compaction — reminder queued")
			);
		}
	});
}
