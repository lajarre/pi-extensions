# Structured Session Naming — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace namenag's flat LLM-only session naming with a structured, hierarchical name built from deterministic environment signals (git branch, `gh` PR, subfolder) plus LLM for the activity description only.

**Architecture:** Pure segment resolvers in a new `resolve.ts` — each takes `(cwd, exec)` and returns `string | null`. An orchestrator calls them in parallel and assembles via colon-join. The main `index.ts` wires the structured pipeline into existing triggers and adds `/name-auto`. Fallback to old-style LLM naming when all segments produce nothing.

**Tech Stack:** TypeScript, `pi.exec()` for shell commands, `@mariozechner/pi-ai` for LLM, Node test runner.

---

## Source Files

| File | Role | LOC estimate |
|------|------|-------------|
| `resolve.ts` (new) | Segment resolvers, assembly, orchestrator | ~200 |
| `index.ts` (modify) | Wire structured pipeline, `/name-auto`, fallback | ~220 |
| `test/namenag.test.ts` (modify) | All new tests + preserve existing | ~600 |

## Dependency Graph

```
Task 1 (types + truncate)
├── Task 2 (detectWorktree) ── depends on Task 1
├── Task 4 (resolvePR) ── depends on Task 1
├── Task 5 (resolveSubfolder) ── depends on Task 1
│
Task 3 (resolveBranch) ── depends on Task 1, Task 2
Task 6 (assembleSegments) ── depends on Task 1
Task 7 (resolveDescription) ── depends on Task 1
Task 8 (structuredName orchestrator) ── depends on Tasks 2–7
Task 9 (update gatherContext) ── no deps
Task 10 (wire pipeline + fallback) ── depends on Tasks 8, 9
Task 11 (/name-auto command) ── depends on Task 10
Task 12 (integration tests) ── depends on Task 11
```

---

### Task 1: Create `resolve.ts` with types and `truncateSegment`

**Files:**
- Create: `resolve.ts`

**Step 1: Write the failing test**

Add to `test/namenag.test.ts`:

```typescript
import { truncateSegment } from "../resolve.js";

describe("truncateSegment", () => {
  it("should return short strings unchanged", () => {
    assert.equal(truncateSegment("hello", 12), "hello");
  });

  it("should truncate at max with ellipsis", () => {
    assert.equal(truncateSegment("very-long-branch-name", 12), "very-long-br…");
  });

  it("should handle exact length", () => {
    assert.equal(truncateSegment("exactly12chr", 12), "exactly12chr");
  });

  it("should handle empty string", () => {
    assert.equal(truncateSegment("", 12), "");
  });

  it("should return null for null input", () => {
    assert.equal(truncateSegment(null, 12), null);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/alex/workspace/aidev/pi-extensions/namenag && npx tsx --test test/namenag.test.ts`
Expected: FAIL — `resolve.js` does not exist.

**Step 3: Write minimal implementation**

Create `resolve.ts`:

```typescript
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
```

**Step 4: Run test to verify it passes**

Run: `npx tsx --test test/namenag.test.ts`
Expected: All truncateSegment tests PASS, all existing tests still PASS.

**Step 5: Commit**

```bash
git add resolve.ts test/namenag.test.ts
git commit -m "✨ Add resolve.ts with types and truncateSegment" -- resolve.ts test/namenag.test.ts
```

---

### Task 2: Implement `detectWorktree`

**Files:**
- Modify: `resolve.ts`
- Modify: `test/namenag.test.ts`

**Dependencies:** Task 1

**Context:** Worktree detection compares `git rev-parse --show-toplevel` to `git rev-parse --git-common-dir`. If git-common-dir resolves outside toplevel → linked worktree. The worktree leaf name is the basename of toplevel.

**Step 1: Write the failing tests**

```typescript
import { detectWorktree } from "../resolve.js";

describe("detectWorktree", () => {
  it("should detect linked worktree", async () => {
    const exec: ExecFn = async (cmd, args) => {
      if (args.includes("--show-toplevel")) {
        return { stdout: "/home/user/.tree/feat-new-app\n", stderr: "", exitCode: 0 };
      }
      if (args.includes("--git-common-dir")) {
        return { stdout: "../../main-repo/.git\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const result = await detectWorktree("/home/user/.tree/feat-new-app", exec);
    assert.deepEqual(result, { isLinkedWorktree: true, worktreeLeaf: "feat-new-app" });
  });

  it("should detect main worktree (not linked)", async () => {
    const exec: ExecFn = async (cmd, args) => {
      if (args.includes("--show-toplevel")) {
        return { stdout: "/home/user/main-repo\n", stderr: "", exitCode: 0 };
      }
      if (args.includes("--git-common-dir")) {
        return { stdout: ".git\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const result = await detectWorktree("/home/user/main-repo", exec);
    assert.deepEqual(result, { isLinkedWorktree: false, worktreeLeaf: null });
  });

  it("should handle non-git directory", async () => {
    const exec: ExecFn = async () => {
      return { stdout: "", stderr: "fatal: not a git repository", exitCode: 128 };
    };
    const result = await detectWorktree("/home/user/plain-dir", exec);
    assert.deepEqual(result, { isLinkedWorktree: false, worktreeLeaf: null });
  });

  it("should handle absolute git-common-dir outside toplevel", async () => {
    const exec: ExecFn = async (cmd, args) => {
      if (args.includes("--show-toplevel")) {
        return { stdout: "/home/user/.tree/fix-bug\n", stderr: "", exitCode: 0 };
      }
      if (args.includes("--git-common-dir")) {
        // Absolute path pointing elsewhere
        return { stdout: "/home/user/main-repo/.git\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const result = await detectWorktree("/home/user/.tree/fix-bug", exec);
    assert.deepEqual(result, { isLinkedWorktree: true, worktreeLeaf: "fix-bug" });
  });
});
```

**Step 2: Run tests — expect FAIL (function doesn't exist)**

**Step 3: Implement in `resolve.ts`**

```typescript
import { resolve as pathResolve, basename } from "node:path";

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

    // Resolve common-dir relative to cwd
    const commonDir = pathResolve(cwd, commonDirRaw);

    // If common-dir is NOT inside toplevel → linked worktree
    if (!commonDir.startsWith(toplevel + "/") && commonDir !== toplevel + "/.git") {
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
```

**Step 4: Run tests — expect PASS**

**Step 5: Commit**

```bash
git add resolve.ts test/namenag.test.ts
git commit -m "✨ Add detectWorktree for linked worktree detection" -- resolve.ts test/namenag.test.ts
```

---

### Task 3: Implement `resolveBranch`

**Files:**
- Modify: `resolve.ts`
- Modify: `test/namenag.test.ts`

**Dependencies:** Tasks 1, 2

**Context:** Runs `git branch --show-current`. Strips conventional prefixes (`feat/`, `fix/`, `pr/`, `hotfix/`). Skips when: branch = main/master, or branch slug = worktree leaf (both prefix-stripped). Truncated at 12 chars.

**Step 1: Write the failing tests**

```typescript
import { resolveBranch, stripBranchPrefix } from "../resolve.js";

describe("stripBranchPrefix", () => {
  it("should strip feat/ prefix", () => {
    assert.equal(stripBranchPrefix("feat/new-login"), "new-login");
  });

  it("should strip fix/ prefix", () => {
    assert.equal(stripBranchPrefix("fix/broken-auth"), "broken-auth");
  });

  it("should strip pr/ prefix", () => {
    assert.equal(stripBranchPrefix("pr/42-review"), "42-review");
  });

  it("should strip hotfix/ prefix", () => {
    assert.equal(stripBranchPrefix("hotfix/urgent"), "urgent");
  });

  it("should not strip unknown prefixes", () => {
    assert.equal(stripBranchPrefix("release/v2"), "release/v2");
  });

  it("should handle no prefix", () => {
    assert.equal(stripBranchPrefix("my-branch"), "my-branch");
  });
});

describe("stripWorktreePrefix", () => {
  // Worktree leaf names use `-` separator instead of `/`
  it("should strip feat- prefix from worktree leaf", () => {
    assert.equal(stripWorktreePrefix("feat-new-app"), "new-app");
  });

  it("should strip fix- prefix", () => {
    assert.equal(stripWorktreePrefix("fix-bug"), "bug");
  });

  it("should not strip unknown prefixes", () => {
    assert.equal(stripWorktreePrefix("release-v2"), "release-v2");
  });
});

describe("resolveBranch", () => {
  it("should return stripped branch name", async () => {
    const exec: ExecFn = async (cmd, args) => {
      if (args.includes("--show-current")) {
        return { stdout: "feat/42-auth-refactor\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const wt = { isLinkedWorktree: false, worktreeLeaf: null };
    const result = await resolveBranch("/repo", exec, wt);
    assert.equal(result, "42-auth-refa…");  // 12 chars + …
  });

  it("should skip main branch", async () => {
    const exec: ExecFn = async () => ({ stdout: "main\n", stderr: "", exitCode: 0 });
    const wt = { isLinkedWorktree: false, worktreeLeaf: null };
    const result = await resolveBranch("/repo", exec, wt);
    assert.equal(result, null);
  });

  it("should skip master branch", async () => {
    const exec: ExecFn = async () => ({ stdout: "master\n", stderr: "", exitCode: 0 });
    const wt = { isLinkedWorktree: false, worktreeLeaf: null };
    const result = await resolveBranch("/repo", exec, wt);
    assert.equal(result, null);
  });

  it("should skip when branch slug matches worktree leaf (both prefix-stripped)", async () => {
    // Branch: feat/new-app → slug: new-app
    // Worktree leaf: feat-new-app → stripped: new-app
    const exec: ExecFn = async () => ({ stdout: "feat/new-app\n", stderr: "", exitCode: 0 });
    const wt = { isLinkedWorktree: true, worktreeLeaf: "feat-new-app" };
    const result = await resolveBranch("/repo", exec, wt);
    assert.equal(result, null);
  });

  it("should include branch when different from worktree leaf", async () => {
    // Branch: pr/7-live-prices → slug: 7-live-prices
    // Worktree leaf: feat-new-app → stripped: new-app
    const exec: ExecFn = async () => ({ stdout: "pr/7-live-prices\n", stderr: "", exitCode: 0 });
    const wt = { isLinkedWorktree: true, worktreeLeaf: "feat-new-app" };
    const result = await resolveBranch("/repo", exec, wt);
    assert.equal(result, "7-live-price…");  // truncated at 12+…
  });

  it("should return short branch without truncation", async () => {
    const exec: ExecFn = async () => ({ stdout: "feat/login\n", stderr: "", exitCode: 0 });
    const wt = { isLinkedWorktree: false, worktreeLeaf: null };
    const result = await resolveBranch("/repo", exec, wt);
    assert.equal(result, "login");
  });

  it("should handle git failure gracefully", async () => {
    const exec: ExecFn = async () => ({ stdout: "", stderr: "fatal", exitCode: 128 });
    const wt = { isLinkedWorktree: false, worktreeLeaf: null };
    const result = await resolveBranch("/repo", exec, wt);
    assert.equal(result, null);
  });

  it("should handle detached HEAD", async () => {
    const exec: ExecFn = async () => ({ stdout: "\n", stderr: "", exitCode: 0 });
    const wt = { isLinkedWorktree: false, worktreeLeaf: null };
    const result = await resolveBranch("/repo", exec, wt);
    assert.equal(result, null);
  });
});
```

**Step 2: Run tests — expect FAIL**

**Step 3: Implement in `resolve.ts`**

```typescript
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
    if (!branch) return null; // detached HEAD

    // Skip default branches
    if (branch === "main" || branch === "master") return null;

    const slug = stripBranchPrefix(branch);

    // Skip if slug matches worktree leaf (both prefix-stripped)
    if (worktree.isLinkedWorktree && worktree.worktreeLeaf) {
      const worktreeSlug = stripWorktreePrefix(worktree.worktreeLeaf);
      if (slug === worktreeSlug) return null;
    }

    return truncateSegment(slug, SEGMENT_CAPS.branch);
  } catch {
    return null;
  }
}
```

**Step 4: Run tests — expect PASS**

**Step 5: Commit**

```bash
git add resolve.ts test/namenag.test.ts
git commit -m "✨ Add resolveBranch with prefix stripping and skip logic" -- resolve.ts test/namenag.test.ts
```

---

### Task 4: Implement `resolvePR`

**Files:**
- Modify: `resolve.ts`
- Modify: `test/namenag.test.ts`

**Dependencies:** Task 1

**Context:** Runs `gh pr view --json number -q .number` with a 3-second timeout. Returns `pr<N>` or null. Fails silently for all error conditions.

**Step 1: Write the failing tests**

```typescript
import { resolvePR } from "../resolve.js";

describe("resolvePR", () => {
  it("should return pr<N> on success", async () => {
    const exec: ExecFn = async () => ({ stdout: "42\n", stderr: "", exitCode: 0 });
    const result = await resolvePR("/repo", exec);
    assert.equal(result, "pr42");
  });

  it("should return null when no PR", async () => {
    const exec: ExecFn = async () => ({
      stdout: "",
      stderr: "no pull requests found",
      exitCode: 1,
    });
    const result = await resolvePR("/repo", exec);
    assert.equal(result, null);
  });

  it("should return null on timeout (simulated via rejection)", async () => {
    const exec: ExecFn = async () => {
      throw new Error("timed out");
    };
    const result = await resolvePR("/repo", exec);
    assert.equal(result, null);
  });

  it("should return null when gh not installed", async () => {
    const exec: ExecFn = async () => ({
      stdout: "",
      stderr: "command not found: gh",
      exitCode: 127,
    });
    const result = await resolvePR("/repo", exec);
    assert.equal(result, null);
  });

  it("should return null for non-numeric output", async () => {
    const exec: ExecFn = async () => ({ stdout: "not-a-number\n", stderr: "", exitCode: 0 });
    const result = await resolvePR("/repo", exec);
    assert.equal(result, null);
  });

  it("should pass 3s timeout to exec", async () => {
    let capturedTimeout: number | undefined;
    const exec: ExecFn = async (_cmd, _args, opts) => {
      capturedTimeout = opts?.timeout;
      return { stdout: "7\n", stderr: "", exitCode: 0 };
    };
    await resolvePR("/repo", exec);
    assert.equal(capturedTimeout, 3000);
  });
});
```

**Step 2: Run tests — expect FAIL**

**Step 3: Implement in `resolve.ts`**

```typescript
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
    if (isNaN(num)) return null;

    return `pr${num}`;
  } catch {
    return null;
  }
}
```

**Step 4: Run tests — expect PASS**

**Step 5: Commit**

```bash
git add resolve.ts test/namenag.test.ts
git commit -m "✨ Add resolvePR with 3s timeout and silent failure" -- resolve.ts test/namenag.test.ts
```

---

### Task 5: Implement `resolveSubfolder`

**Files:**
- Modify: `resolve.ts`
- Modify: `test/namenag.test.ts`

**Dependencies:** Task 1

**Context:** Determines project root (git root first, then walk up for `project.org`/`area.org`, stop before `~/`). If cwd is deeper than root, returns the relative path slugified (`/` → `-`). Truncated at 12 chars.

**Step 1: Write the failing tests**

```typescript
import { resolveSubfolder } from "../resolve.js";

describe("resolveSubfolder", () => {
  it("should return null when at project root", async () => {
    const exec: ExecFn = async () => ({ stdout: "/home/user/project\n", stderr: "", exitCode: 0 });
    const result = await resolveSubfolder("/home/user/project", exec);
    assert.equal(result, null);
  });

  it("should return slugified relative path for nested cwd", async () => {
    const exec: ExecFn = async () => ({ stdout: "/home/user/project\n", stderr: "", exitCode: 0 });
    const result = await resolveSubfolder("/home/user/project/pkg/worker", exec);
    assert.equal(result, "pkg-worker");
  });

  it("should truncate long subfolder paths", async () => {
    const exec: ExecFn = async () => ({ stdout: "/home/user/project\n", stderr: "", exitCode: 0 });
    const result = await resolveSubfolder(
      "/home/user/project/packages/very-long-name/src",
      exec,
    );
    // "packages-very-long-name-src" → truncated at 12 + …
    assert.equal(result, "packages-ver…");
  });

  it("should return null for non-git directory (no project.org fallback in tests)", async () => {
    // exec fails → resolveSubfolder returns null (no filesystem walk in unit test)
    const exec: ExecFn = async () => ({ stdout: "", stderr: "fatal", exitCode: 128 });
    const result = await resolveSubfolder("/home/user/plain-dir/sub", exec);
    assert.equal(result, null);
  });

  it("should handle single-level nesting", async () => {
    const exec: ExecFn = async () => ({ stdout: "/repo\n", stderr: "", exitCode: 0 });
    const result = await resolveSubfolder("/repo/src", exec);
    assert.equal(result, "src");
  });
});
```

**Step 2: Run tests — expect FAIL**

**Step 3: Implement in `resolve.ts`**

```typescript
import { relative } from "node:path";

/**
 * Resolve subfolder segment.
 *
 * Project root: git root (`git rev-parse --show-toplevel`).
 * Falls back to walking up for `project.org`/`area.org` — but that
 * requires filesystem access so is deferred to integration if needed.
 *
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
```

**Step 4: Run tests — expect PASS**

**Step 5: Commit**

```bash
git add resolve.ts test/namenag.test.ts
git commit -m "✨ Add resolveSubfolder with slugified relative path" -- resolve.ts test/namenag.test.ts
```

---

### Task 6: Implement `assembleSegments`

**Files:**
- Modify: `resolve.ts`
- Modify: `test/namenag.test.ts`

**Dependencies:** Task 1

**Context:** Takes array `[branch, pr, subfolder, description]`, filters nulls/empties, joins with `:`. Per-segment truncation is already done by individual resolvers.

**Step 1: Write the failing tests**

```typescript
import { assembleSegments } from "../resolve.js";

describe("assembleSegments", () => {
  it("should join all segments with colon", () => {
    const result = assembleSegments(["42-auth", "pr42", "pkg-worker", "token-handler"]);
    assert.equal(result, "42-auth:pr42:pkg-worker:token-handler");
  });

  it("should filter null segments", () => {
    const result = assembleSegments([null, "pr42", null, "ordering-fix"]);
    assert.equal(result, "pr42:ordering-fix");
  });

  it("should filter empty string segments", () => {
    const result = assembleSegments(["", "pr42", "", "review"]);
    assert.equal(result, "pr42:review");
  });

  it("should return empty string when all segments are null", () => {
    const result = assembleSegments([null, null, null, null]);
    assert.equal(result, "");
  });

  it("should handle single segment", () => {
    const result = assembleSegments([null, null, null, "debug-cache"]);
    assert.equal(result, "debug-cache");
  });

  it("should handle mixed null and empty", () => {
    const result = assembleSegments([null, "", null, ""]);
    assert.equal(result, "");
  });
});
```

**Step 2: Run tests — expect FAIL**

**Step 3: Implement in `resolve.ts`**

```typescript
/**
 * Assemble name segments with colon separator.
 *
 * Order: [branch, pr, subfolder, description]
 * Filters null/empty. Each segment is already individually truncated.
 */
export function assembleSegments(segments: (string | null)[]): string {
  return segments.filter((s): s is string => !!s).join(":");
}
```

**Step 4: Run tests — expect PASS**

**Step 5: Commit**

```bash
git add resolve.ts test/namenag.test.ts
git commit -m "✨ Add assembleSegments with colon-join" -- resolve.ts test/namenag.test.ts
```

---

### Task 7: Implement `resolveDescription`

**Files:**
- Modify: `resolve.ts`
- Modify: `test/namenag.test.ts`

**Dependencies:** Task 1

**Context:** Takes recent user messages + an LLM callback. The LLM call is injected as a function parameter (not imported directly) so tests don't need to mock the module. The prompt asks for 1–3 words kebab-case. Result truncated at 20 chars.

**Step 1: Write the failing tests**

```typescript
import { resolveDescription } from "../resolve.js";

describe("resolveDescription", () => {
  it("should return LLM-generated description", async () => {
    const llm = async (_context: string) => "refactor-auth";
    const result = await resolveDescription("Help me refactor auth", llm);
    assert.equal(result, "refactor-auth");
  });

  it("should truncate long descriptions at 20 chars", async () => {
    const llm = async () => "very-long-description-name";
    const result = await resolveDescription("context", llm);
    assert.equal(result, "very-long-descriptio…");
  });

  it("should sanitize LLM output to kebab-case", async () => {
    const llm = async () => '"Refactor Auth Module!"';
    const result = await resolveDescription("context", llm);
    assert.equal(result, "refactor-auth-module");
  });

  it("should return null on LLM failure", async () => {
    const llm = async () => { throw new Error("LLM failed"); };
    const result = await resolveDescription("context", llm);
    assert.equal(result, null);
  });

  it("should return null on empty LLM response", async () => {
    const llm = async () => "";
    const result = await resolveDescription("context", llm);
    assert.equal(result, null);
  });

  it("should return null on empty context", async () => {
    const llm = async () => "should-not-reach";
    const result = await resolveDescription("", llm);
    assert.equal(result, null);
  });
});
```

**Step 2: Run tests — expect FAIL**

**Step 3: Implement in `resolve.ts`**

```typescript
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
```

**Step 4: Run tests — expect PASS**

**Step 5: Commit**

```bash
git add resolve.ts test/namenag.test.ts
git commit -m "✨ Add resolveDescription with injected LLM callback" -- resolve.ts test/namenag.test.ts
```

---

### Task 8: Implement `structuredName` orchestrator

**Files:**
- Modify: `resolve.ts`
- Modify: `test/namenag.test.ts`

**Dependencies:** Tasks 2–7

**Context:** The orchestrator runs all resolvers (some in parallel where possible) and assembles the result. Returns the assembled name string, or empty string if all segments are null (caller handles fallback).

**Step 1: Write the failing tests**

```typescript
import { structuredName, type ExecFn, type DescriptionLLMFn } from "../resolve.js";

describe("structuredName", () => {
  it("should produce full structured name with all segments", async () => {
    const exec: ExecFn = async (cmd, args) => {
      // detectWorktree — linked worktree
      if (cmd === "git" && args.includes("--show-toplevel")) {
        return { stdout: "/home/.tree/feat-new-app\n", stderr: "", exitCode: 0 };
      }
      if (cmd === "git" && args.includes("--git-common-dir")) {
        return { stdout: "/home/main/.git\n", stderr: "", exitCode: 0 };
      }
      // branch
      if (cmd === "git" && args.includes("--show-current")) {
        return { stdout: "pr/7-live-prices\n", stderr: "", exitCode: 0 };
      }
      // PR
      if (cmd === "gh") {
        return { stdout: "70\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const llm: DescriptionLLMFn = async () => "review-triage";

    const result = await structuredName("/home/.tree/feat-new-app", exec, "context", llm);
    assert.equal(result, "7-live-price…:pr70:review-triage");
  });

  it("should produce description-only when on main, no PR", async () => {
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
      if (cmd === "gh") {
        return { stdout: "", stderr: "no PR", exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const llm: DescriptionLLMFn = async () => "debug-worker-cache";

    const result = await structuredName("/repo", exec, "context", llm);
    assert.equal(result, "debug-worker-cache");
  });

  it("should return empty string when all resolvers fail and LLM fails", async () => {
    const exec: ExecFn = async () => ({ stdout: "", stderr: "fatal", exitCode: 128 });
    const llm: DescriptionLLMFn = async () => { throw new Error("fail"); };

    const result = await structuredName("/no-git", exec, "", llm);
    assert.equal(result, "");
  });

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
      if (cmd === "gh") {
        return { stdout: "70\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    const llm: DescriptionLLMFn = async () => "cache-refactor";

    const result = await structuredName("/repo/pkg/worker", exec, "context", llm);
    assert.equal(result, "pr70:pkg-worker:cache-refactor");
  });
});
```

**Step 2: Run tests — expect FAIL**

**Step 3: Implement in `resolve.ts`**

```typescript
/**
 * Orchestrate all segment resolvers and assemble the structured name.
 *
 * Resolvers run in parallel where possible. Returns assembled colon-joined
 * string, or empty string if all segments are null (caller handles fallback).
 */
export async function structuredName(
  cwd: string,
  exec: ExecFn,
  context: string,
  llm: DescriptionLLMFn,
): Promise<string> {
  // Detect worktree first (needed by resolveBranch)
  const worktree = await detectWorktree(cwd, exec);

  // Run remaining resolvers in parallel
  const [branch, pr, subfolder, description] = await Promise.all([
    resolveBranch(cwd, exec, worktree),
    resolvePR(cwd, exec),
    resolveSubfolder(cwd, exec),
    resolveDescription(context, llm),
  ]);

  return assembleSegments([branch, pr, subfolder, description]);
}
```

**Step 4: Run tests — expect PASS**

**Step 5: Commit**

```bash
git add resolve.ts test/namenag.test.ts
git commit -m "✨ Add structuredName orchestrator" -- resolve.ts test/namenag.test.ts
```

---

### Task 9: Update `gatherContext` to use last 3 messages, most-recent-first

**Files:**
- Modify: `index.ts`
- Modify: `test/namenag.test.ts`

**Dependencies:** None

**Context:** The spec says "last 3 user messages from session branch (most recent first), max ~500 chars total". Current code iterates forward and grabs the first N messages. We need to reverse: iterate from the end, take last 3 user messages, reverse order (most recent first).

**Step 1: Write the failing test**

Add a test for gatherContext behavior. Since `gatherContext` is a private function inside the extension closure, we'll test it indirectly through the test harness by verifying the LLM receives recent-first context. Update `registerTestHandlers` to capture context passed to the LLM.

Actually, the spec change to gatherContext is internal. We need to refactor `gatherContext` to:
1. Iterate session entries in reverse
2. Collect last 3 user messages
3. Reverse them (most recent first)
4. Cap at 500 chars

Since this is internal to `index.ts`, we test via integration (Task 12). For now, just modify the function.

**Step 2: Modify `gatherContext` in `index.ts`**

Replace the existing `gatherContext` function:

```typescript
/** Extract text from the last 3 user messages (most recent first, ≤500 chars total). */
function gatherContext(ctx: { sessionManager: { getBranch(): SessionEntry[] } }): string {
  const entries = ctx.sessionManager.getBranch();
  const MAX_CHARS = 500;
  const MAX_MESSAGES = 3;

  // Collect user messages from the end
  const userMessages: string[] = [];
  for (let i = entries.length - 1; i >= 0 && userMessages.length < MAX_MESSAGES; i--) {
    const e = entries[i];
    if (e.type !== "message" || (e as any).message?.role !== "user") continue;

    const content = (e as any).message.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && block.text) text += block.text + "\n";
      }
    }
    if (text.trim()) userMessages.push(text.trim());
  }

  // Already in most-recent-first order (we iterated from end)
  return userMessages.join("\n").slice(0, MAX_CHARS).trim();
}
```

**Step 3: Run tests — all existing tests should still PASS**

Run: `npx tsx --test test/namenag.test.ts`

**Step 4: Commit**

```bash
git add index.ts
git commit -m "♻️ Refactor gatherContext to use last 3 user messages" -- index.ts
```

---

### Task 10: Wire structured pipeline into `autoName` + fallback

**Files:**
- Modify: `index.ts`
- Modify: `test/namenag.test.ts`

**Dependencies:** Tasks 8, 9

**Context:** Replace the current `autoName` body with:
1. Gather context (already done — Task 9).
2. Resolve model (unchanged).
3. Build an LLM callback that uses `complete()` with the new `DESCRIPTION_PROMPT`.
4. Call `structuredName(cwd, piExec, context, llmCallback)`.
5. If result is non-empty → apply it.
6. If result is empty (all resolvers returned null AND LLM failed) → fallback to old-style full LLM naming (2–4 word kebab-case from full prompt).

The key change: `autoName` now needs `ctx.cwd` for the segment resolvers. Check that `ExtensionContext` provides `cwd` — confirmed from types.d.ts: `cwd: string`.

**Step 1: Update imports in `index.ts`**

```typescript
import {
  structuredName,
  DESCRIPTION_PROMPT,
  type DescriptionLLMFn,
} from "./resolve.js";
```

**Step 2: Create a wrapper for `pi.exec` to match `ExecFn`**

Inside the extension factory:

```typescript
/** Wrap pi.exec to match the ExecFn signature used by resolvers. */
const piExec: ExecFn = async (command, args, options) => {
  const result = await pi.exec(command, args, {
    cwd: options?.cwd,
    timeout: options?.timeout,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
};
```

Note: Check that `pi.exec` returns `{ stdout, stderr, exitCode }` — confirmed from the `ExecResult` type in `types.d.ts`.

**Step 3: Refactor `autoName` in `index.ts`**

The old `NAME_PROMPT` is kept as `FALLBACK_NAME_PROMPT` for the fallback path.

```typescript
const FALLBACK_NAME_PROMPT = `You are a session naming assistant. Given conversation context, produce a short session name.

Rules:
- 2–4 words, kebab-case (e.g. "refactor-auth-module", "search-feature-shaping")
- Capture the primary topic or activity
- Be specific, not generic (not "coding-session" or "chat")
- Output ONLY the name, nothing else — no quotes, no explanation`;

async function autoName(ctx: any): Promise<void> {
  if (!isActive(ctx)) return;

  const context = gatherContext(ctx);
  if (!context) return;

  const resolved = await resolveModel(ctx);
  if (!resolved) {
    softNotify(ctx);
    return;
  }

  generating = true;
  try {
    // Build LLM callback for description resolver
    const llmCallback: DescriptionLLMFn = async (ctx_text: string) => {
      const userMessage: Message = {
        role: "user",
        content: [{ type: "text", text: `<conversation>\n${ctx_text}\n</conversation>` }],
        timestamp: Date.now(),
      };
      const response = await complete(
        resolved.model,
        { systemPrompt: DESCRIPTION_PROMPT, messages: [userMessage] },
        { apiKey: resolved.apiKey, maxTokens: 64 },
      );
      return response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("")
        .trim();
    };

    // Try structured naming first
    const name = await structuredName(ctx.cwd, piExec, context, llmCallback);

    if (name) {
      pi.setSessionName(name);
      markNamed();
      ctx.ui.notify(`Auto-named: ${name}. /name to change.`, "info");
      return;
    }

    // Fallback: old-style full LLM naming
    await fallbackName(ctx, context, resolved);
  } catch {
    softNotify(ctx);
  } finally {
    generating = false;
  }
}

/** Fallback: generate a 2–4 word kebab-case name from full LLM prompt. */
async function fallbackName(
  ctx: any,
  context: string,
  resolved: { model: any; apiKey: string },
): Promise<void> {
  try {
    const userMessage: Message = {
      role: "user",
      content: [{ type: "text", text: `<conversation>\n${context}\n</conversation>` }],
      timestamp: Date.now(),
    };
    const response = await complete(
      resolved.model,
      { systemPrompt: FALLBACK_NAME_PROMPT, messages: [userMessage] },
      { apiKey: resolved.apiKey, maxTokens: 64 },
    );

    const raw = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();

    const name = raw
      .toLowerCase()
      .replace(/[^a-z0-9-\s]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);

    if (!name) {
      softNotify(ctx);
      return;
    }

    pi.setSessionName(name);
    markNamed();
    ctx.ui.notify(`Auto-named: ${name}. /name to change.`, "info");
  } catch {
    softNotify(ctx);
  }
}
```

**Step 4: Update test harness `registerTestHandlers`**

The test harness must mirror the new structured pipeline. Add a `structuredNameResult` option alongside `autoNameResult` (fallback). The harness doesn't need to replicate the full resolver logic — it mocks the outcome:

```typescript
function registerTestHandlers(
  api: any,
  opts: {
    autoNameResult?: string;       // structured name result (or fallback)
    autoNameFails?: boolean;
    hasModel?: boolean;
    structuredResult?: string;     // explicit structured pipeline result
    fallbackResult?: string;       // explicit fallback result
  } = {},
) {
  // ... existing setup ...

  async function autoName(ctx: any): Promise<void> {
    if (!isActive(ctx)) return;

    const resolved = await resolveModel(ctx);
    if (!resolved) {
      softNotify(ctx);
      return;
    }

    generating = true;
    try {
      if (opts.autoNameFails) throw new Error("LLM failed");

      // If structuredResult is explicitly set, use structured pipeline path
      const structuredName = opts.structuredResult ?? opts.autoNameResult ?? "test-session-name";
      const raw = structuredName;

      // For structured names, sanitization is different (colons are allowed)
      const name = opts.structuredResult
        ? raw.trim().slice(0, 60)  // structured: already formatted
        : raw.toLowerCase()
            .replace(/[^a-z0-9-\s]/g, "")
            .replace(/\s+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 60);

      if (!name) {
        // Try fallback
        if (opts.fallbackResult) {
          api.setSessionName(opts.fallbackResult);
          markNamed();
          ctx.ui.notify(`Auto-named: ${opts.fallbackResult}. /name to change.`, "info");
          return;
        }
        softNotify(ctx);
        return;
      }

      api.setSessionName(name);
      markNamed();
      ctx.ui.notify(`Auto-named: ${name}. /name to change.`, "info");
    } catch {
      softNotify(ctx);
    } finally {
      generating = false;
    }
  }

  // ... rest unchanged ...
}
```

**Step 5: Run tests — all existing tests must still PASS**

Run: `npx tsx --test test/namenag.test.ts`

**Step 6: Commit**

```bash
git add index.ts test/namenag.test.ts
git commit -m "✨ Wire structured naming pipeline with fallback" -- index.ts test/namenag.test.ts
```

---

### Task 11: Register `/name-auto` command

**Files:**
- Modify: `index.ts`
- Modify: `test/namenag.test.ts`

**Dependencies:** Task 10

**Context:** `/name-auto` runs the full structured pipeline on demand. It ignores the `named` flag — always re-derives. Auto-triggers (compaction, ≥50 turns) still respect the `named` flag.

**Step 1: Write the failing tests**

```typescript
describe("/name-auto command", () => {
  it("should be registered as a command", async () => {
    const mock = createMockPi();
    const commands: Map<string, any> = new Map();
    mock.api.registerCommand = (name: string, opts: any) => {
      commands.set(name, opts);
    };
    // Load extension would register the command
    // For now, test that registerCommand is called with "name-auto"
    registerTestHandlers(mock.api, { registerNameAuto: true });
    assert.ok(commands.has("name-auto"), "/name-auto command should be registered");
  });

  it("should work even when session is already named", async () => {
    const mock = createMockPi();
    mock.setSessionName("old-name");
    registerTestHandlers(mock.api, { autoNameResult: "new-structured-name" });
    await mock.fire("session_start");

    // Simulate /name-auto — calls autoName ignoring `named` flag
    // The command handler calls a special forceAutoName that skips the `named` check
    await mock.fire("name_auto_command");

    assert.equal(mock.getSessionName(), "new-structured-name");
  });

  it("should not interfere with auto-trigger named flag", async () => {
    const mock = createMockPi();
    mock.setSessionName("existing");
    registerTestHandlers(mock.api, { autoNameResult: "should-not-apply" });
    await mock.fire("session_start");

    // Auto-trigger should NOT overwrite (named=true from session_start reset)
    await mock.fire("session_compact");

    assert.equal(mock.getSessionName(), "existing", "Auto-trigger should respect named flag");
  });
});
```

**Step 2: Implement in `index.ts`**

Add command registration inside the extension factory function, after all event listeners:

```typescript
/** Force-run structured naming, ignoring `named` flag. For /name-auto. */
async function forceAutoName(ctx: any): Promise<void> {
  // Temporarily clear named flag, run pipeline, restore if needed
  const wasNamed = named;
  named = false;
  try {
    await autoName(ctx);
  } finally {
    // If autoName didn't set a name, restore the flag
    if (!named) named = wasNamed;
  }
}

pi.registerCommand("name-auto", {
  description: "Re-derive session name from environment + activity",
  async handler(_args, ctx) {
    await forceAutoName(ctx);
  },
});
```

**Step 3: Update test harness for command testing**

Add `registerCommand` mock to `createMockPi` and `name_auto_command` event handling to the test harness.

**Step 4: Run tests — expect PASS**

**Step 5: Commit**

```bash
git add index.ts test/namenag.test.ts
git commit -m "✨ Register /name-auto command" -- index.ts test/namenag.test.ts
```

---

### Task 12: Add integration and edge-case tests

**Files:**
- Modify: `test/namenag.test.ts`

**Dependencies:** Task 11

**Context:** Comprehensive tests that cover the full structured naming flow, fallback behavior, and edge cases. All git/gh calls mocked via injected `exec`.

**Step 1: Write integration tests**

```typescript
describe("structured naming integration", () => {
  it("should produce branch:pr:description for feature branch with PR", async () => {
    // Mock: feat/42-auth-refactor branch, PR#42, at repo root
    // Expected: 42-auth-refa…:pr42:<description>
    // ...
  });

  it("should produce pr:subfolder:description when branch matches worktree", async () => {
    // Mock: feat/new-app branch, worktree feat-new-app → branch skipped
    // PR#70, cwd = /repo/pkg/worker
    // Expected: pr70:pkg-worker:<description>
    // ...
  });

  it("should produce description-only on main without PR", async () => {
    // Mock: main branch, no PR, at root
    // Expected: <description>
    // ...
  });

  it("should fall back to full LLM naming when no git and LLM description fails", async () => {
    // Mock: not a git repo, LLM description fails
    // Fallback LLM returns "shaping-api"
    // Expected: "shaping-api"
    // ...
  });
});

describe("fallback behavior", () => {
  it("should use old-style LLM when all structured segments are null", async () => {
    // All resolvers return null, description LLM fails
    // Fallback LLM succeeds
    // ...
  });

  it("should soft-notify when both structured and fallback fail", async () => {
    // Everything fails
    // Expected: soft notification
    // ...
  });
});

describe("/name-auto vs auto-triggers", () => {
  it("auto-trigger should not overwrite existing name", async () => {
    // Set name, fire compaction → name unchanged
    // ...
  });

  it("/name-auto should overwrite existing name", async () => {
    // Set name, fire /name-auto → name changed
    // ...
  });
});

describe("segment edge cases", () => {
  it("branch with issue ID kept intact within 12 chars", async () => {
    // Branch: "42-auth" → fits → "42-auth"
    // ...
  });

  it("PR number naturally short, no truncation needed", async () => {
    // PR#7 → "pr7"
    // ...
  });

  it("deeply nested subfolder truncated with ellipsis", async () => {
    // cwd = /repo/packages/deep/nested/path
    // Relative: "packages-deep-nested-path" → "packages-dee…"
    // ...
  });
});
```

**Step 2: Run all tests**

Run: `npx tsx --test test/namenag.test.ts`
Expected: ALL tests PASS.

**Step 3: Commit**

```bash
git add test/namenag.test.ts
git commit -m "✅ Add integration and edge-case tests for structured naming" -- test/namenag.test.ts
```

---

## Final Verification

After all tasks complete:

```bash
cd /Users/alex/workspace/aidev/pi-extensions/namenag
npx tsx --test test/namenag.test.ts
wc -l index.ts resolve.ts
```

**Expected:**
- All tests pass
- `index.ts` < 250 LOC
- `resolve.ts` < 250 LOC
- Combined < 500 LOC

---

## ADR Candidates

Decisions not fully specified by the spec that the implementer may need to resolve:

### ADR-1: ExecFn signature — match pi.exec exactly or simplify?

`pi.exec()` returns `ExecResult` which has `stdout`, `stderr`, `exitCode` plus potentially more fields. The `ExecFn` type in `resolve.ts` uses a minimal subset. **Decision needed:** Should `ExecFn` exactly mirror `ExecResult` or use a minimal interface? Recommendation: minimal — easier to mock, only uses what resolvers need.

### ADR-2: Worktree detection — resolve relative vs absolute git-common-dir

The spec says "if git-common-dir resolves outside toplevel." `git rev-parse --git-common-dir` can return a relative path (e.g., `.git`, `../../main/.git`) or absolute path. We resolve it against `cwd` with `path.resolve()`. **Decision needed:** Is resolving against `cwd` correct, or should it be resolved against `toplevel`? Git docs say common-dir is relative to `.git` dir, but in practice for worktrees it points to the main repo's `.git`. Recommendation: resolve against `cwd` — works for both relative and absolute cases.

### ADR-3: Fallback trigger — when exactly does fallback fire?

The spec says fallback when "structured pipeline produces an empty name (all resolvers return null AND LLM fails)." But what if only the LLM description succeeds? Then structured name = description only (no colon segments). That's a valid structured name, not a fallback. **Decision needed:** Confirm that description-only is a valid structured result (no fallback). Recommendation: yes, any non-empty assembly is valid.

### ADR-4: Sanitization of structured names — colons allowed?

Current code sanitizes names to `[a-z0-9-]` only. Structured names use `:` separator. **Decision needed:** Allow colons in session names? The `pi.setSessionName()` API likely accepts any string. Recommendation: structured names skip the old sanitization — segments are individually sanitized (kebab-case), joined with colon, no further sanitization needed.

### ADR-5: `gatherContext` used by both structured and fallback paths

Both the structured pipeline (for `resolveDescription`) and the fallback (for full LLM naming) use `gatherContext`. **Decision needed:** Should they share the same context, or should fallback use a different extraction (e.g., more messages, forward order)? Recommendation: share — same 3 recent messages, consistent behavior.

### ADR-6: `pi.exec` availability — is it always accessible?

The `ExecFn` wraps `pi.exec()`. The `pi` parameter is `ExtensionAPI` which has `exec()`. But resolvers need `exec` passed in from the event handler context. **Decision needed:** Should we capture `pi.exec` at extension init and pass it as a closure, or thread it from the event context? The `ExtensionAPI.exec()` is available directly on the `pi` object — simpler to capture at init. Recommendation: capture at init, create wrapper once.

### ADR-7: `/name-auto` command handler context type

The command handler receives `ExtensionCommandContext` (not `ExtensionContext`). It has `waitForIdle()` etc. But `autoName` expects the standard `ExtensionContext` shape. **Decision needed:** Does `ExtensionCommandContext` extend `ExtensionContext`? From types.d.ts: yes, it does. No issue — just needs confirmation during implementation.

---

## Spec Ambiguities

1. **Worktree prefix stripping uses `-` separator** — the spec mentions worktree leaf names use `-` but branch names use `/`. The regex patterns must differ: `feat/` for branches, `feat-` for worktree leaves. Confirmed in spec.

2. **`project.org`/`area.org` fallback for project root** — the spec mentions this for non-git directories, but implementation requires filesystem walking. The resolvers take `exec` (shell commands), not filesystem access. **Resolution:** Only implement git-root detection; `project.org` walk is a future enhancement or can use `exec("find", ...)` if needed.

3. **Soft target ~60 chars** — the spec mentions a "soft total target ~60 chars" but also says "No hard max; truncate from right." Per-segment caps (12+uncapped+12+20) can exceed 60 easily. **Resolution:** Individual segment caps enforce reasonable length; no additional total truncation needed.

4. **Caching spec conflict** — shaping.md says "Cache per session" for PR resolver, but spec.md says "No caching — always query on each trigger." **Resolution:** Follow spec.md (no caching). The shaping doc is pre-spec.

5. **`/name-auto` args** — the spec doesn't specify whether `/name-auto` takes arguments. **Resolution:** No arguments — always runs full pipeline fresh.
