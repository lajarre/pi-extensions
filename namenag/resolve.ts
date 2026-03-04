import { basename, resolve as pathResolve } from "node:path";

/**
 * Segment resolvers for structured session naming.
 *
 * Each resolver is a pure function: (cwd, exec) → string | null.
 * Deterministic segments (branch, PR, subfolder) never touch LLM.
 * Description resolver takes an LLM callback for injection.
 */

/** Shell exec signature — matches pi.exec() shape, mockable in tests. */
export type ExecFn = (
	command: string,
	args: string[],
	options?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/** Segment caps per spec. */
export const SEGMENT_CAPS = {
	branch: 12,
	subfolder: 12,
	description: 20,
} as const;

/** Truncate a string to `max` chars, appending `…` if over. Null-safe. */
export function truncateSegment(value: string | null, max: number): string | null {
	if (value === null) return null;
	if (value.length <= max) return value;
	return value.slice(0, max) + "…";
}

export interface WorktreeInfo {
	isLinkedWorktree: boolean;
	worktreeLeaf: string | null;
}

/**
 * Detect if cwd is inside a linked git worktree.
 *
 * Compares git toplevel to git-common-dir. If common-dir resolves
 * outside toplevel, it's a linked worktree.
 */
export async function detectWorktree(cwd: string, exec: ExecFn): Promise<WorktreeInfo> {
	try {
		const [toplevelResult, commonDirResult] = await Promise.all([
			exec("git", ["rev-parse", "--show-toplevel"], { cwd }),
			exec("git", ["rev-parse", "--git-common-dir"], { cwd }),
		]);

		if (toplevelResult.exitCode !== 0 || commonDirResult.exitCode !== 0) {
			return { isLinkedWorktree: false, worktreeLeaf: null };
		}

		const toplevel = toplevelResult.stdout.trim();
		const commonDirRaw = commonDirResult.stdout.trim();
		const commonDir = pathResolve(cwd, commonDirRaw);

		if (!commonDir.startsWith(`${toplevel}/`) && commonDir !== `${toplevel}/.git`) {
			return {
				isLinkedWorktree: true,
				worktreeLeaf: basename(toplevel),
			};
		}

		return { isLinkedWorktree: false, worktreeLeaf: null };
	} catch {
		return { isLinkedWorktree: false, worktreeLeaf: null };
	}
}
