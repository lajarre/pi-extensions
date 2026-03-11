# Wave 02 — Implementation Plan

## Scope

Add `resolveProject` and `resolveWorktreeName` resolvers to `resolve.ts`.
Update `structuredName` to prepend them. Segment order becomes:

```
project : worktree : branch : pr : subfolder : description
  12        12        12     free     12          20
```

No new files. All changes in `resolve.ts` and `test/namenag.test.ts`.

## Definition of Done

- `resolveProject` handles: git remote parse (SSH + HTTPS + bare), `project.org`/`area.org` dirname fallback, cwd basename fallback, 12-char cap
- `resolveWorktreeName` returns prefix-stripped worktree leaf (12-char cap) or null
- `structuredName` assembles 6 segments in correct order
- All existing tests updated (they now include project prefix)
- All tests green: `npx tsx --test test/namenag.test.ts`

---

### Task 1: Add SEGMENT_CAPS entries for project and worktree

**Files:** `resolve.ts`

**Rationale:** Both new resolvers need caps defined before implementation.

**Code:**

```typescript
// resolve.ts — update SEGMENT_CAPS
export const SEGMENT_CAPS = {
	project: 12,
	worktree: 12,
	branch: 12,
	subfolder: 12,
	description: 20,
} as const;
```

**Tests:** No new tests needed — caps are exercised through resolver tests in Tasks 2–3.

**Verification:**

```bash
cd /Users/alex/workspace/aidev/pi-extensions/namenag && npx tsx --test test/namenag.test.ts
```

Expect: existing tests still pass (caps change is additive, no consumer changes yet).

**Commit:** `🔧 Add project and worktree segment caps`

---

### Task 2: Implement `resolveProject` with tests (test-first)

**Files:** `test/namenag.test.ts`, then `resolve.ts`

**Design decisions:**

- Uses `git remote get-url origin` as primary strategy
- Parses repo name from SSH (`git@host:org/repo.git`) and HTTPS (`https://host/org/repo`, `https://host/org/repo.git`) URL formats
- Falls back to walking cwd upward for `project.org` or `area.org` file (uses `node:fs` `existsSync` — simple, synchronous, no exec overhead)
- Stops at home dir (`~/`) to avoid scanning system dirs
- Final fallback: `basename(cwd)`
- Truncated to 12 chars via `truncateSegment`

**Signature:**

```typescript
export async function resolveProject(cwd: string, exec: ExecFn): Promise<string | null>;
```

Returns `string` (never null in practice — basename fallback always produces something). Return type stays `string | null` for consistency with other resolvers, but null only if cwd is empty/root.

**Helper — `extractRepoName`:**

```typescript
/**
 * Extract repository name from a git remote URL.
 * Handles:
 *   git@github.com:org/repo.git  → repo
 *   https://github.com/org/repo.git → repo
 *   https://github.com/org/repo → repo
 *   ssh://git@host/org/repo.git → repo
 */
export function extractRepoName(remoteUrl: string): string | null {
	const trimmed = remoteUrl.trim();
	if (!trimmed) return null;

	// Strip trailing .git
	const clean = trimmed.replace(/\.git$/, "");

	// Extract last path segment
	// Works for both SSH (git@host:org/repo) and HTTPS (https://host/org/repo)
	const match = clean.match(/[/:]([^/:]+)$/);
	return match ? match[1] : null;
}
```

**Resolver implementation:**

```typescript
import { basename, dirname, resolve as pathResolve } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

export async function resolveProject(cwd: string, exec: ExecFn): Promise<string | null> {
	// Strategy 1: git remote origin → repo name
	try {
		const result = await exec("git", ["remote", "get-url", "origin"], { cwd, timeout: 3000 });
		if (result.exitCode === 0) {
			const name = extractRepoName(result.stdout);
			if (name) return truncateSegment(name, SEGMENT_CAPS.project);
		}
	} catch {
		// Fall through
	}

	// Strategy 2: walk upward for project.org / area.org
	const home = homedir();
	let dir = pathResolve(cwd);
	while (dir !== "/" && dir !== home) {
		if (existsSync(pathResolve(dir, "project.org")) || existsSync(pathResolve(dir, "area.org"))) {
			return truncateSegment(basename(dir), SEGMENT_CAPS.project);
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	// Strategy 3: cwd basename
	const fallback = basename(pathResolve(cwd));
	return fallback ? truncateSegment(fallback, SEGMENT_CAPS.project) : null;
}
```

**Tests (write first, before implementation):**

Add to `test/namenag.test.ts` — import `resolveProject` and `extractRepoName`:

```typescript
// Update import line at top of test file:
import {
	assembleSegments,
	detectWorktree,
	type ExecFn,
	extractRepoName,
	resolveBranch,
	resolveDescription,
	resolvePR,
	resolveProject,
	resolveSubfolder,
	resolveWorktreeName,
	stripBranchPrefix,
	stripWorktreePrefix,
	structuredName,
	truncateSegment,
} from "../resolve.js";
```

```typescript
describe("extractRepoName", () => {
	it("should parse SSH remote URL", () => {
		assert.equal(extractRepoName("git@github.com:org/repo.git"), "repo");
	});

	it("should parse HTTPS remote URL with .git", () => {
		assert.equal(extractRepoName("https://github.com/org/repo.git"), "repo");
	});

	it("should parse HTTPS remote URL without .git", () => {
		assert.equal(extractRepoName("https://github.com/org/repo"), "repo");
	});

	it("should parse SSH protocol URL", () => {
		assert.equal(extractRepoName("ssh://git@github.com/org/repo.git"), "repo");
	});

	it("should return null for empty string", () => {
		assert.equal(extractRepoName(""), null);
	});

	it("should handle URL with trailing whitespace", () => {
		assert.equal(extractRepoName("git@github.com:org/repo.git\n"), "repo");
	});
});

describe("resolveProject", () => {
	it("should extract repo name from git remote", async () => {
		const exec: ExecFn = async (cmd, args) => {
			if (cmd === "git" && args.includes("get-url")) {
				return { stdout: "git@github.com:mitsuhiko/pi-coding-agent.git\n", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 1 };
		};
		const result = await resolveProject("/some/repo", exec);
		assert.equal(result, "pi-coding-ag…");
	});

	it("should extract short repo name without truncation", async () => {
		const exec: ExecFn = async (cmd, args) => {
			if (cmd === "git" && args.includes("get-url")) {
				return { stdout: "https://github.com/org/namenag.git\n", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 1 };
		};
		const result = await resolveProject("/some/repo", exec);
		assert.equal(result, "namenag");
	});

	it("should fall back to cwd basename when no git remote", async () => {
		const exec: ExecFn = async () => {
			return { stdout: "", stderr: "fatal: not a git repository", exitCode: 128 };
		};
		const result = await resolveProject("/home/user/my-project", exec);
		assert.equal(result, "my-project");
	});

	it("should truncate long cwd basename", async () => {
		const exec: ExecFn = async () => {
			return { stdout: "", stderr: "fatal", exitCode: 128 };
		};
		const result = await resolveProject("/home/user/very-long-project-name", exec);
		assert.equal(result, "very-long-pr…");
	});

	it("should handle HTTPS URL without .git suffix", async () => {
		const exec: ExecFn = async (cmd, args) => {
			if (cmd === "git" && args.includes("get-url")) {
				return { stdout: "https://github.com/org/my-repo\n", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 1 };
		};
		const result = await resolveProject("/some/path", exec);
		assert.equal(result, "my-repo");
	});

	it("should handle exec throwing", async () => {
		const exec: ExecFn = async () => { throw new Error("nope"); };
		const result = await resolveProject("/home/user/fallback-dir", exec);
		assert.equal(result, "fallback-dir");
	});
});
```

**Verification:**

```bash
cd /Users/alex/workspace/aidev/pi-extensions/namenag && npx tsx --test test/namenag.test.ts
```

**Commit:** `✨ Add resolveProject resolver`

---

### Task 3: Implement `resolveWorktreeName` with tests (test-first)

**Files:** `test/namenag.test.ts`, then `resolve.ts`

**Design:** Thin wrapper around existing `detectWorktree` + `stripWorktreePrefix`. Takes `WorktreeInfo` directly (avoids duplicate git calls since `structuredName` already calls `detectWorktree`).

**Signature:**

```typescript
export function resolveWorktreeName(worktree: WorktreeInfo): string | null;
```

Note: synchronous — no async needed, just transforms existing data. The spec suggests `(cwd, exec)` but `structuredName` already computes `WorktreeInfo` for `resolveBranch`. Calling `detectWorktree` twice is wasteful. Taking `WorktreeInfo` is cleaner and still fully testable.

**Implementation:**

```typescript
/**
 * Resolve worktree segment from pre-computed worktree info.
 *
 * Returns prefix-stripped worktree leaf name, or null if not a linked worktree.
 * Cap: 12 chars.
 */
export function resolveWorktreeName(worktree: WorktreeInfo): string | null {
	if (!worktree.isLinkedWorktree || !worktree.worktreeLeaf) return null;
	const stripped = stripWorktreePrefix(worktree.worktreeLeaf);
	return truncateSegment(stripped, SEGMENT_CAPS.worktree);
}
```

**Tests (write first):**

```typescript
describe("resolveWorktreeName", () => {
	it("should return stripped worktree leaf for linked worktree", () => {
		const wt: WorktreeInfo = { isLinkedWorktree: true, worktreeLeaf: "feat-new-app" };
		assert.equal(resolveWorktreeName(wt), "new-app");
	});

	it("should return null for non-linked worktree", () => {
		const wt: WorktreeInfo = { isLinkedWorktree: false, worktreeLeaf: null };
		assert.equal(resolveWorktreeName(wt), null);
	});

	it("should truncate long worktree names", () => {
		const wt: WorktreeInfo = { isLinkedWorktree: true, worktreeLeaf: "feat-very-long-worktree-name" };
		assert.equal(resolveWorktreeName(wt), "very-long-wo…");
	});

	it("should handle worktree leaf without conventional prefix", () => {
		const wt: WorktreeInfo = { isLinkedWorktree: true, worktreeLeaf: "my-feature" };
		assert.equal(resolveWorktreeName(wt), "my-feature");
	});

	it("should handle worktree with null leaf (edge case)", () => {
		const wt: WorktreeInfo = { isLinkedWorktree: true, worktreeLeaf: null };
		assert.equal(resolveWorktreeName(wt), null);
	});

	it("should strip fix- prefix", () => {
		const wt: WorktreeInfo = { isLinkedWorktree: true, worktreeLeaf: "fix-auth-bug" };
		assert.equal(resolveWorktreeName(wt), "auth-bug");
	});
});
```

**Import note:** `WorktreeInfo` is already exported from `resolve.ts` — add it to the import in the test file (already included in Task 2 import update... actually need to add `WorktreeInfo`):

```typescript
import {
	assembleSegments,
	detectWorktree,
	type ExecFn,
	extractRepoName,
	resolveBranch,
	resolveDescription,
	resolvePR,
	resolveProject,
	resolveSubfolder,
	resolveWorktreeName,
	stripBranchPrefix,
	stripWorktreePrefix,
	structuredName,
	truncateSegment,
	type WorktreeInfo,
} from "../resolve.js";
```

**Verification:**

```bash
cd /Users/alex/workspace/aidev/pi-extensions/namenag && npx tsx --test test/namenag.test.ts
```

**Commit:** `✨ Add resolveWorktreeName resolver`

---

### Task 4: Update `structuredName` to include project and worktree segments

**Files:** `resolve.ts`

**Change:** Add `resolveProject` and `resolveWorktreeName` calls, pass 6 segments to `assembleSegments`.

**Current code:**

```typescript
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
```

**New code:**

```typescript
export async function structuredName(
	cwd: string,
	exec: ExecFn,
	context: string,
	llm: DescriptionLLMFn,
): Promise<string> {
	const worktree = await detectWorktree(cwd, exec);
	const worktreeName = resolveWorktreeName(worktree);

	const [project, branch, pr, subfolder, description] = await Promise.all([
		resolveProject(cwd, exec),
		resolveBranch(cwd, exec, worktree),
		resolvePR(cwd, exec),
		resolveSubfolder(cwd, exec),
		resolveDescription(context, llm),
	]);

	return assembleSegments([project, worktreeName, branch, pr, subfolder, description]);
}
```

Note: `resolveWorktreeName` is synchronous, so it runs inline after `detectWorktree`. `resolveProject` is async and joins the `Promise.all` batch.

**Tests:** No new unit tests here — covered by updated integration tests in Task 5.

**Verification:**

```bash
cd /Users/alex/workspace/aidev/pi-extensions/namenag && npx tsx --test test/namenag.test.ts
```

Expect: integration tests will FAIL at this point (they assert old 4-segment names). That's expected — Task 5 fixes them.

**Commit:** Combined with Task 5 (single logical change).

---

### Task 5: Update all integration tests for 6-segment names

**Files:** `test/namenag.test.ts`

**Rationale:** Every `structuredName` integration test now gets a project prefix (and possibly worktree prefix). We must update exec mocks to handle the `git remote get-url origin` call, and update expected output strings.

**Changes per test — `describe("structuredName")`:**

#### Test: "should produce full structured name with all segments"

Current mock exec handles: `--show-toplevel`, `--git-common-dir`, `--show-current`, `gh`.
Missing: `git remote get-url origin`.

- cwd: `/home/.tree/feat-new-app`
- Linked worktree: yes (common-dir outside toplevel)
- worktreeLeaf: `feat-new-app` → stripped: `new-app`
- Add remote handler returning e.g. `git@github.com:org/myproj.git` → project: `myproj`
- branch: `pr/7-live-prices` → `7-live-price…`
- pr: `pr70`
- subfolder: null (cwd == toplevel)
- description: `review-triage`

New expected: `"myproj:new-app:7-live-price…:pr70:review-triage"`

```typescript
it("should produce full structured name with all segments", async () => {
	const exec: ExecFn = async (cmd, args) => {
		if (cmd === "git" && args.includes("--show-toplevel")) {
			return { stdout: "/home/.tree/feat-new-app\n", stderr: "", exitCode: 0 };
		}
		if (cmd === "git" && args.includes("--git-common-dir")) {
			return { stdout: "/home/main/.git\n", stderr: "", exitCode: 0 };
		}
		if (cmd === "git" && args.includes("--show-current")) {
			return { stdout: "pr/7-live-prices\n", stderr: "", exitCode: 0 };
		}
		if (cmd === "git" && args.includes("get-url")) {
			return { stdout: "git@github.com:org/myproj.git\n", stderr: "", exitCode: 0 };
		}
		if (cmd === "gh") {
			return { stdout: "70\n", stderr: "", exitCode: 0 };
		}
		return { stdout: "", stderr: "", exitCode: 1 };
	};
	const llm = async () => "review-triage";

	const result = await structuredName("/home/.tree/feat-new-app", exec, "context", llm);
	assert.equal(result, "myproj:new-app:7-live-price…:pr70:review-triage");
});
```

#### Test: "should produce description-only when on main with no PR"

- cwd: `/repo`
- Not linked worktree (common-dir = `.git`)
- branch: `main` → null
- Add remote returning e.g. `https://github.com/org/myrepo.git` → project: `myrepo`
- No worktree segment
- No PR
- description: `debug-worker-cache`

New expected: `"myrepo:debug-worker-cache"`

```typescript
it("should produce description-only when on main with no PR", async () => {
	const exec: ExecFn = async (cmd, args) => {
		if (args.includes("--show-toplevel")) {
			return { stdout: "/repo\n", stderr: "", exitCode: 0 };
		}
		if (args.includes("--git-common-dir")) {
			return { stdout: ".git\n", stderr: "", exitCode: 0 };
		}
		if (args.includes("--show-current")) {
			return { stdout: "main\n", stderr: "", exitCode: 0 };
		}
		if (cmd === "git" && args.includes("get-url")) {
			return { stdout: "https://github.com/org/myrepo.git\n", stderr: "", exitCode: 0 };
		}
		if (cmd === "gh") {
			return { stdout: "", stderr: "no PR", exitCode: 1 };
		}
		return { stdout: "", stderr: "", exitCode: 1 };
	};
	const llm = async () => "debug-worker-cache";

	const result = await structuredName("/repo", exec, "context", llm);
	assert.equal(result, "myrepo:debug-worker-cache");
});
```

#### Test: "should return empty string when all resolvers fail"

- cwd: `/no-git` — all git commands fail → project falls back to basename `no-git`
- LLM fails, empty context

Actually this changes: project fallback = `basename("/no-git")` = `no-git`. So result is `"no-git"` not `""`.

Wait — the test passes empty context `""` to structuredName. Let me retrace:
- `resolveProject` — git remote fails, no project.org walk hits, fallback = `basename("/no-git")` = `no-git`
- `resolveWorktreeName` — detectWorktree fails → null
- `resolveBranch` — fails → null
- `resolvePR` — fails → null
- `resolveSubfolder` — fails → null
- `resolveDescription` — empty context → null

Result: `"no-git"` (only project segment survives).

```typescript
it("should return project-only when all other resolvers fail", async () => {
	const exec: ExecFn = async () => ({ stdout: "", stderr: "fatal", exitCode: 128 });
	const llm = async () => {
		throw new Error("fail");
	};

	const result = await structuredName("/no-git", exec, "", llm);
	assert.equal(result, "no-git");
});
```

Note: test description also changes to reflect new behavior.

#### Test: "should include subfolder when in subdirectory"

- cwd: `/repo/pkg/worker`
- Not linked worktree
- branch: `main` → null
- Add remote → `https://github.com/org/myrepo.git` → project: `myrepo`
- PR: 70 → `pr70`
- subfolder: `pkg-worker`
- description: `cache-refactor`

New expected: `"myrepo:pr70:pkg-worker:cache-refactor"`

```typescript
it("should include subfolder when in subdirectory", async () => {
	const exec: ExecFn = async (cmd, args) => {
		if (args.includes("--show-toplevel")) {
			return { stdout: "/repo\n", stderr: "", exitCode: 0 };
		}
		if (args.includes("--git-common-dir")) {
			return { stdout: ".git\n", stderr: "", exitCode: 0 };
		}
		if (args.includes("--show-current")) {
			return { stdout: "main\n", stderr: "", exitCode: 0 };
		}
		if (cmd === "git" && args.includes("get-url")) {
			return { stdout: "https://github.com/org/myrepo.git\n", stderr: "", exitCode: 0 };
		}
		if (cmd === "gh") {
			return { stdout: "70\n", stderr: "", exitCode: 0 };
		}
		return { stdout: "", stderr: "", exitCode: 1 };
	};
	const llm = async () => "cache-refactor";

	const result = await structuredName("/repo/pkg/worker", exec, "context", llm);
	assert.equal(result, "myrepo:pr70:pkg-worker:cache-refactor");
});
```

**Changes per test — `describe("structured naming integration")`:**

#### Test: "should produce branch:pr:description for feature branch with PR"

Add remote returning `https://github.com/org/myrepo.git` → `myrepo`.
Not a worktree → no worktree segment.

New expected: `"myrepo:42-auth-refa…:pr42:token-handler"`

```typescript
it("should produce project:branch:pr:description for feature branch with PR", async () => {
	const exec: ExecFn = async (cmd, args) => {
		if (cmd === "git" && args.includes("--show-toplevel")) {
			return { stdout: "/repo\n", stderr: "", exitCode: 0 };
		}
		if (cmd === "git" && args.includes("--git-common-dir")) {
			return { stdout: ".git\n", stderr: "", exitCode: 0 };
		}
		if (cmd === "git" && args.includes("--show-current")) {
			return { stdout: "feat/42-auth-refactor\n", stderr: "", exitCode: 0 };
		}
		if (cmd === "git" && args.includes("get-url")) {
			return { stdout: "https://github.com/org/myrepo.git\n", stderr: "", exitCode: 0 };
		}
		if (cmd === "gh") {
			return { stdout: "42\n", stderr: "", exitCode: 0 };
		}
		return { stdout: "", stderr: "", exitCode: 1 };
	};
	const llm = async () => "token-handler";

	const result = await structuredName("/repo", exec, "context", llm);
	assert.equal(result, "myrepo:42-auth-refa…:pr42:token-handler");
});
```

#### Test: "should produce pr:subfolder:description when branch matches worktree"

- cwd: `/home/user/.tree/feat-new-app/pkg/worker`
- Linked worktree: yes → worktree: `new-app`
- Branch `feat/new-app` slug matches worktree slug → branch null
- Add remote → `git@github.com:org/myproj.git` → project: `myproj`

New expected: `"myproj:new-app:pr70:pkg-worker:cache-refactor"`

```typescript
it("should produce project:worktree:pr:subfolder:description when branch matches worktree", async () => {
	const exec: ExecFn = async (cmd, args) => {
		if (cmd === "git" && args.includes("--show-toplevel")) {
			return { stdout: "/home/user/.tree/feat-new-app\n", stderr: "", exitCode: 0 };
		}
		if (cmd === "git" && args.includes("--git-common-dir")) {
			return { stdout: "/home/user/main/.git\n", stderr: "", exitCode: 0 };
		}
		if (cmd === "git" && args.includes("--show-current")) {
			return { stdout: "feat/new-app\n", stderr: "", exitCode: 0 };
		}
		if (cmd === "git" && args.includes("get-url")) {
			return { stdout: "git@github.com:org/myproj.git\n", stderr: "", exitCode: 0 };
		}
		if (cmd === "gh") {
			return { stdout: "70\n", stderr: "", exitCode: 0 };
		}
		return { stdout: "", stderr: "", exitCode: 1 };
	};
	const llm = async () => "cache-refactor";

	const result = await structuredName("/home/user/.tree/feat-new-app/pkg/worker", exec, "context", llm);
	assert.equal(result, "myproj:new-app:pr70:pkg-worker:cache-refactor");
});
```

#### Test: "should produce description-only on main without PR"

Add remote → project: `myrepo`. Result: `"myrepo:debug-worker-cache"`.

```typescript
it("should produce project:description on main without PR", async () => {
	const exec: ExecFn = async (cmd, args) => {
		if (cmd === "git" && args.includes("--show-toplevel")) {
			return { stdout: "/repo\n", stderr: "", exitCode: 0 };
		}
		if (cmd === "git" && args.includes("--git-common-dir")) {
			return { stdout: ".git\n", stderr: "", exitCode: 0 };
		}
		if (cmd === "git" && args.includes("--show-current")) {
			return { stdout: "main\n", stderr: "", exitCode: 0 };
		}
		if (cmd === "git" && args.includes("get-url")) {
			return { stdout: "https://github.com/org/myrepo.git\n", stderr: "", exitCode: 0 };
		}
		if (cmd === "gh") {
			return { stdout: "", stderr: "no pull request", exitCode: 1 };
		}
		return { stdout: "", stderr: "", exitCode: 1 };
	};
	const llm = async () => "debug-worker-cache";

	const result = await structuredName("/repo", exec, "context", llm);
	assert.equal(result, "myrepo:debug-worker-cache");
});
```

#### Test: "should fall back to full LLM naming when no git and description fails"

- All git fails → project = basename of `/plain-dir` = `plain-dir`
- LLM throws → description null
- Result: `"plain-dir"` (not empty!)

This changes the test's logic — structured result is no longer empty, so fallback won't trigger. Update to reflect new behavior:

```typescript
it("should use project basename when no git and description fails", async () => {
	const exec: ExecFn = async () => ({
		stdout: "",
		stderr: "fatal: not a git repository",
		exitCode: 128,
	});
	const llm = async () => {
		throw new Error("description failed");
	};
	const result = await structuredName("/plain-dir", exec, "context", llm);
	assert.equal(result, "plain-dir");
});
```

**Changes to `describe("fallback behavior")`:**

#### Test: "should use old-style LLM when all structured segments are null"

With project fallback, structured result won't be empty anymore for any real path. This test needs to test the scenario where project also fails. The only way project returns null is if cwd is root-like. Update to test the mock harness fallback path with an explicit empty structured result:

```typescript
it("should use old-style LLM when structured name is empty", async () => {
	// Directly test mock harness fallback — structuredName now rarely returns ""
	// since project has basename fallback, but the fallback path must still work
	const mock = createMockPi();
	registerTestHandlers(mock.api, {
		structuredResult: "",
		fallbackResult: "legacy-fallback-name",
	});
	await mock.fire("session_start");
	await mock.fire("session_compact");

	assert.equal(mock.getSessionName(), "legacy-fallback-name");
});
```

#### Test: "should soft-notify when both structured and fallback fail"

Same approach — test with explicit empty structured result:

```typescript
it("should soft-notify when both structured and fallback fail", async () => {
	const mock = createMockPi();
	registerTestHandlers(mock.api, {
		structuredResult: "",
		fallbackResult: "",
	});
	await mock.fire("session_start");
	await mock.fire("session_compact");

	assert.equal(mock.getSessionName(), undefined);
	assert.ok(mock.notifications.some((n) => n.message.includes("Session unnamed")));
});
```

**Update `assembleSegments` test for 6-segment examples:**

Add a test with 6 segments:

```typescript
it("should handle 6-segment structured name", () => {
	const result = assembleSegments(["myproj", "new-app", "42-auth", "pr42", "pkg-worker", "token-handler"]);
	assert.equal(result, "myproj:new-app:42-auth:pr42:pkg-worker:token-handler");
});

it("should filter null project and worktree segments", () => {
	const result = assembleSegments([null, null, "42-auth", "pr42", null, "ordering-fix"]);
	assert.equal(result, "42-auth:pr42:ordering-fix");
});
```

**Verification:**

```bash
cd /Users/alex/workspace/aidev/pi-extensions/namenag && npx tsx --test test/namenag.test.ts
```

All tests green.

**Commit:** `✨ Prepend project and worktree segments to structured name`

Commit message body:

```
Adds resolveProject (git remote → project.org walk → basename
fallback) and resolveWorktreeName (prefix-stripped linked worktree
leaf). Segment order: project:worktree:branch:pr:subfolder:description.

Wave 02 of structured naming — provides global uniqueness across
concurrent sessions in different repos/worktrees.
```

---

### Task 6: Update resolve.ts imports

**Files:** `resolve.ts`

**Change:** Add `node:fs` and `node:os` imports at the top of resolve.ts:

```typescript
import { basename, dirname, relative, resolve as pathResolve } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
```

This replaces the current single import:

```typescript
import { basename, relative, resolve as pathResolve } from "node:path";
```

**Note:** This is part of the Task 2 implementation but called out explicitly since it modifies the import block.

---

### Task 7: Final verification and commit

**Files:** All changed files

**Verification sequence:**

```bash
cd /Users/alex/workspace/aidev/pi-extensions/namenag

# 1. Run all tests
npx tsx --test test/namenag.test.ts

# 2. Check no lint/type issues (if tsc available)
npx tsc --noEmit 2>/dev/null || true

# 3. Review changes
git diff --stat
git diff
```

**Expected green:** All tests pass. No regressions.

**Final commit structure (if not already committed per-task):**

Option A — single atomic commit:
```
✨ Add project + worktree segments to structured name

Wave 02: resolveProject (git remote → project.org → basename),
resolveWorktreeName (prefix-stripped linked worktree leaf).
Segment order: project:worktree:branch:pr:subfolder:description.
```

Option B — split commits (preferred per AGENTS.md tangled-changes rule):
1. `🔧 Add project and worktree segment caps` — resolve.ts only
2. `✨ Add resolveProject resolver` — resolve.ts + test
3. `✨ Add resolveWorktreeName resolver` — resolve.ts + test
4. `✨ Prepend project + worktree in structuredName` — resolve.ts + test updates

---

## ADR Candidates

### ADR-01: `resolveWorktreeName` takes `WorktreeInfo` not `(cwd, exec)`

**Context:** Spec suggests `resolveWorktreeName(cwd, exec)` signature. `structuredName` already calls `detectWorktree` for `resolveBranch`. Calling it again wastes two git subprocess invocations.

**Decision:** `resolveWorktreeName(worktree: WorktreeInfo)` — synchronous, takes pre-computed info. Consistent with how `resolveBranch` already receives `WorktreeInfo`.

**Consequence:** Slightly different from spec signature. Function is synchronous (no async). Cleaner, faster, more testable.

### ADR-02: `resolveProject` uses `node:fs` for project.org walk

**Context:** All other resolvers use `exec` for external calls (git, gh). The project.org/area.org walk needs filesystem access. Options: (a) use exec with `test -f`, (b) use `node:fs` directly.

**Decision:** Use `existsSync` from `node:fs`. Simple synchronous check, no subprocess overhead per directory level. The git remote strategy still uses exec.

**Consequence:** Introduces `node:fs` and `node:os` as new imports. File-walk not mockable via `ExecFn` alone — but primary path (git remote) is fully mockable, and basename fallback covers the remaining test cases without needing to mock the walk.

### ADR-03: Project segment always present (basename fallback)

**Context:** `resolveProject` has a final fallback: `basename(cwd)`. This means the project segment is almost never null (only if cwd is `/`). Previous "all resolvers fail → empty string" behavior changes.

**Decision:** Accept this. A project identifier, even imprecise, is better than nothing for session uniqueness. The structured name will always have at least the project segment.

**Consequence:** Tests asserting empty string for "all fail" must be updated. Fallback-to-LLM naming in `index.ts` triggers less often (structured name is rarely empty now).
