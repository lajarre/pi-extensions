/**
 * Fork Rename
 *
 * Rename forked sessions so they do not keep the exact same /name.
 *
 * Default style:
 *   my-session -> my-session-fork1 -> my-session-fork2 -> ...
 *
 * Change NAME_STYLE to "n" if you prefer:
 *   my-session -> my-session-1 -> my-session-2 -> ...
 */

import { SessionManager, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

const NAME_STYLE: "forkN" | "n" = "forkN";

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getBaseName(name: string): string {
	return name.trim().replace(/-(?:fork)?\d+$/i, "");
}

function getPattern(base: string): RegExp {
	const escapedBase = escapeRegExp(base);
	if (NAME_STYLE === "n") return new RegExp(`^${escapedBase}-(\\d+)$`);
	return new RegExp(`^${escapedBase}-fork(\\d+)$`, "i");
}

function buildName(base: string, index: number): string {
	if (NAME_STYLE === "n") return `${base}-${index}`;
	return `${base}-fork${index}`;
}

export default function forkRename(pi: ExtensionAPI) {
	pi.on("session_fork", async (_event, ctx) => {
		const inheritedName = pi.getSessionName()?.trim();
		if (!inheritedName) return;

		const base = getBaseName(inheritedName);
		if (!base) return;

		let sessions = [] as Awaited<ReturnType<typeof SessionManager.list>>;
		try {
			sessions = await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir());
		} catch {
			// Fall back to a deterministic default if listing fails.
			const fallbackName = buildName(base, 1);
			pi.setSessionName(fallbackName);
			if (ctx.hasUI) ctx.ui.notify(`Fork renamed: ${fallbackName}`, "info");
			return;
		}

		const pattern = getPattern(base);
		let maxIndex = 0;

		for (const session of sessions) {
			if (!session.name) continue;
			const match = session.name.match(pattern);
			if (!match) continue;
			const index = Number(match[1]);
			if (Number.isFinite(index)) maxIndex = Math.max(maxIndex, index);
		}

		const nextName = buildName(base, maxIndex + 1);
		if (nextName === inheritedName) return;

		pi.setSessionName(nextName);
		if (ctx.hasUI) ctx.ui.notify(`Fork renamed: ${nextName}`, "info");
	});
}
