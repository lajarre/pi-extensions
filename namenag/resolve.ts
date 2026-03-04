import { basename, relative, resolve as pathResolve } from "node:path";

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

const BRANCH_PREFIX_RE = /^(feat|fix|pr|hotfix)\//;
const WORKTREE_PREFIX_RE = /^(feat|fix|pr|hotfix)-/;

/** Strip conventional prefix from a git branch name. */
export function stripBranchPrefix(branch: string): string {
	return branch.replace(BRANCH_PREFIX_RE, "");
}

/** Strip conventional prefix from a worktree leaf name (uses `-` separator). */
export function stripWorktreePrefix(leaf: string): string {
	return leaf.replace(WORKTREE_PREFIX_RE, "");
}

/**
 * Resolve branch segment.
 *
 * Returns stripped branch name, or null if:
 * - Not in a git repo / detached HEAD
 * - Branch is main or master
 * - Branch slug matches worktree leaf (after prefix stripping on both)
 */
export async function resolveBranch(
	cwd: string,
	exec: ExecFn,
	worktree: WorktreeInfo,
): Promise<string | null> {
	try {
		const result = await exec("git", ["branch", "--show-current"], { cwd });
		if (result.exitCode !== 0) return null;

		const branch = result.stdout.trim();
		if (!branch) return null;
		if (branch === "main" || branch === "master") return null;

		const slug = stripBranchPrefix(branch);

		if (worktree.isLinkedWorktree && worktree.worktreeLeaf) {
			const worktreeSlug = stripWorktreePrefix(worktree.worktreeLeaf);
			if (slug === worktreeSlug) return null;
		}

		return truncateSegment(slug, SEGMENT_CAPS.branch);
	} catch {
		return null;
	}
}

/**
 * Resolve PR segment via `gh pr view`.
 *
 * Returns `pr<N>` string or null. Fails silently for all errors:
 * gh not installed, no PR, timeout, network, non-numeric output.
 */
export async function resolvePR(cwd: string, exec: ExecFn): Promise<string | null> {
	try {
		const result = await exec("gh", ["pr", "view", "--json", "number", "-q", ".number"], {
			cwd,
			timeout: 3000,
		});

		if (result.exitCode !== 0) return null;

		const num = parseInt(result.stdout.trim(), 10);
		if (Number.isNaN(num)) return null;

		return `pr${num}`;
	} catch {
		return null;
	}
}

/**
 * Resolve subfolder segment.
 *
 * Project root: git root (`git rev-parse --show-toplevel`).
 * Returns slugified relative path from root to cwd, or null if at root.
 */
export async function resolveSubfolder(cwd: string, exec: ExecFn): Promise<string | null> {
	try {
		const result = await exec("git", ["rev-parse", "--show-toplevel"], { cwd });
		if (result.exitCode !== 0) return null;

		const root = result.stdout.trim();
		const rel = relative(root, cwd);
		if (!rel || rel === ".") return null;

		const slug = rel.replace(/\//g, "-");
		return truncateSegment(slug, SEGMENT_CAPS.subfolder);
	} catch {
		return null;
	}
}

/**
 * Assemble name segments with colon separator.
 *
 * Order: [branch, pr, subfolder, description]
 * Filters null/empty. Each segment is already individually truncated.
 */
export function assembleSegments(segments: (string | null)[]): string {
	return segments.filter((segment): segment is string => !!segment).join(":");
}

/** LLM callback type — takes conversation context, returns raw name string. */
export type DescriptionLLMFn = (context: string) => Promise<string>;

/** Prompt for LLM description — only 1–3 word activity description. */
export const DESCRIPTION_PROMPT = `You are a session naming assistant. Given recent conversation context, produce a short activity description.

Rules:
- 1–3 words, kebab-case (e.g. "refactor-auth", "debug-cache", "shaping-api")
- Describe the current activity or topic
- Be specific, not generic (not "coding" or "chatting")
- Output ONLY the description, nothing else — no quotes, no explanation`;

/**
 * Resolve the LLM description segment.
 *
 * Takes conversation context string and an LLM callback.
 * Sanitizes output to kebab-case, truncates at 20 chars.
 */
export async function resolveDescription(
	context: string,
	llm: DescriptionLLMFn,
): Promise<string | null> {
	if (!context) return null;

	try {
		const raw = await llm(context);

		const name = raw
			.toLowerCase()
			.replace(/[^a-z0-9-\s]/g, "")
			.replace(/\s+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "");

		if (!name) return null;

		return truncateSegment(name, SEGMENT_CAPS.description);
	} catch {
		return null;
	}
}

/**
 * Orchestrate all segment resolvers and assemble the structured name.
 *
 * detectWorktree runs first (needed by resolveBranch).
 * Remaining resolvers run in parallel.
 */
export async function structuredName(
	cwd: string,
	exec: ExecFn,
	context: string,
	llm: DescriptionLLMFn,
): Promise<string> {
	const worktree = await detectWorktree(cwd, exec);

	const [branch, pr, subfolder, description] = await Promise.all([
		resolveBranch(cwd, exec, worktree),
		resolvePR(cwd, exec),
		resolveSubfolder(cwd, exec),
		resolveDescription(context, llm),
	]);

	return assembleSegments([branch, pr, subfolder, description]);
}
