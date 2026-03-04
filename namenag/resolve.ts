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
