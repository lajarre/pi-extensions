import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	assembleQualityContext,
	buildStopSignalBlock,
	getDiffCommands,
	isFreeform,
	loadProjectGuidelines,
	type ContextOptions,
} from "../context.js";
import type { ExecFn } from "../settings.js";

// ── Helpers ──────────────────────────────────────────────────

function mockExec(responses: Record<string, string> = {}): ExecFn {
	return async (cmd, args) => {
		const key = [cmd, ...args].join(" ");
		return {
			stdout: responses[key] ?? "",
			stderr: "",
			code: 0,
		};
	};
}

function baseOptions(
	overrides: Partial<ContextOptions> = {},
): ContextOptions {
	return {
		iteration: 1,
		maxIterations: 10,
		scope: "uncommitted",
		cwd: "/tmp",
		exec: mockExec(),
		...overrides,
	};
}

// ── getDiffCommands ──────────────────────────────────────────

describe("getDiffCommands", () => {
	it("uncommitted returns git diff + git diff --cached", () => {
		const cmds = getDiffCommands("uncommitted");
		assert.equal(cmds.length, 2);
		assert.deepEqual(cmds[0], ["git", "diff"]);
		assert.deepEqual(cmds[1], ["git", "diff", "--cached"]);
	});

	it("last-commit returns git diff HEAD~1", () => {
		const cmds = getDiffCommands("last-commit");
		assert.equal(cmds.length, 1);
		assert.deepEqual(cmds[0], ["git", "diff", "HEAD~1"]);
	});

	it("branch returns git diff main..HEAD", () => {
		const cmds = getDiffCommands("branch");
		assert.equal(cmds.length, 1);
		assert.deepEqual(cmds[0], ["git", "diff", "main..HEAD"]);
	});

	it("freeform returns empty array", () => {
		assert.equal(getDiffCommands("review the auth module").length, 0);
	});
});

// ── isFreeform ───────────────────────────────────────────────

describe("isFreeform", () => {
	it("false for known scopes", () => {
		assert.ok(!isFreeform("uncommitted"));
		assert.ok(!isFreeform("last-commit"));
		assert.ok(!isFreeform("branch"));
	});

	it("true for arbitrary string", () => {
		assert.ok(isFreeform("check auth module"));
	});
});

// ── buildStopSignalBlock ─────────────────────────────────────

describe("buildStopSignalBlock", () => {
	it("contains EXTREMELY-IMPORTANT tag", () => {
		const block = buildStopSignalBlock("WIGGUM_STOP");
		assert.ok(block.includes("<EXTREMELY-IMPORTANT>"));
		assert.ok(block.includes("</EXTREMELY-IMPORTANT>"));
	});

	it("contains the signal token", () => {
		const block = buildStopSignalBlock("CUSTOM_TOKEN");
		assert.ok(block.includes("CUSTOM_TOKEN"));
	});
});

// ── assembleQualityContext ───────────────────────────────────

describe("assembleQualityContext", () => {
	it("includes iteration number", async () => {
		const ctx = await assembleQualityContext(
			baseOptions({ iteration: 3, maxIterations: 10 }),
		);
		assert.ok(ctx.includes("iteration 3 of 10"));
	});

	it("includes stop signal block", async () => {
		const ctx = await assembleQualityContext(baseOptions());
		assert.ok(ctx.includes("<EXTREMELY-IMPORTANT>"));
		assert.ok(ctx.includes("WIGGUM_STOP"));
	});

	it("includes focus text when provided", async () => {
		const ctx = await assembleQualityContext(
			baseOptions({ focus: "error handling" }),
		);
		assert.ok(ctx.includes("error handling"));
	});

	it("does not include focus text when absent", async () => {
		const ctx = await assembleQualityContext(baseOptions());
		assert.ok(!ctx.includes("Additional focus"));
	});

	it("uses freeform text for scope", async () => {
		const ctx = await assembleQualityContext(
			baseOptions({ scope: "review the auth module" }),
		);
		assert.ok(ctx.includes("review the auth module"));
	});

	it("includes diff output for uncommitted scope", async () => {
		const exec = mockExec({
			"git diff": "+added line\n-removed line",
			"git diff --cached": "+staged change",
			"git diff --name-only": "src/auth.ts",
			"git diff --name-only --cached": "src/staged.ts",
		});
		const ctx = await assembleQualityContext(
			baseOptions({ exec }),
		);
		assert.ok(ctx.includes("+added line"));
		assert.ok(ctx.includes("+staged change"));
		assert.ok(ctx.includes("src/auth.ts"));
		assert.ok(ctx.includes("src/staged.ts"));
	});

	it("uses custom stop signal", async () => {
		const ctx = await assembleQualityContext(
			baseOptions({ stopSignal: "MY_SIGNAL" }),
		);
		assert.ok(ctx.includes("MY_SIGNAL"));
		assert.ok(!ctx.includes("WIGGUM_STOP"));
	});

	it("includes guidelines section when provided", async () => {
		const ctx = await assembleQualityContext(
			baseOptions({ guidelinesContent: "Check error handling" }),
		);
		assert.ok(ctx.includes("## Guidelines"));
		assert.ok(ctx.includes("Check error handling"));
	});

	it("omits guidelines section when undefined", async () => {
		const ctx = await assembleQualityContext(baseOptions());
		assert.ok(!ctx.includes("## Guidelines"));
	});

	it("omits guidelines section when empty string", async () => {
		const ctx = await assembleQualityContext(
			baseOptions({ guidelinesContent: "" }),
		);
		assert.ok(!ctx.includes("## Guidelines"));
	});

	it("includes guidelines content verbatim", async () => {
		const content = "- Check API coherence\n- No dead code";
		const ctx = await assembleQualityContext(
			baseOptions({ guidelinesContent: content }),
		);
		assert.ok(ctx.includes(content));
	});
});

// ── loadProjectGuidelines ────────────────────────────────────

describe("loadProjectGuidelines", () => {
	const tmpDirs: string[] = [];

	function makeTmpDir(): string {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "wiggum-test-"),
		);
		tmpDirs.push(dir);
		return dir;
	}

	afterEach(() => {
		for (const dir of tmpDirs) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		tmpDirs.length = 0;
	});

	it("finds file at worktree root", async () => {
		const root = makeTmpDir();
		const docDir = path.join(root, "doc");
		fs.mkdirSync(docDir);
		fs.writeFileSync(
			path.join(docDir, "review-guidelines.md"),
			"# My Guidelines\nCheck everything",
		);
		const exec: ExecFn = async () => ({
			stdout: root + "\n",
			stderr: "",
			code: 0,
		});
		const result = await loadProjectGuidelines("/some/cwd", exec);
		assert.equal(result, "# My Guidelines\nCheck everything");
	});

	it("falls back to cwd when not in git", async () => {
		const cwd = makeTmpDir();
		const docDir = path.join(cwd, "doc");
		fs.mkdirSync(docDir);
		fs.writeFileSync(
			path.join(docDir, "review-guidelines.md"),
			"Fallback content",
		);
		const exec: ExecFn = async () => ({
			stdout: "",
			stderr: "not a git repo",
			code: 128,
		});
		const result = await loadProjectGuidelines(cwd, exec);
		assert.equal(result, "Fallback content");
	});

	it("returns null when file absent", async () => {
		const cwd = makeTmpDir();
		const exec: ExecFn = async () => ({
			stdout: "",
			stderr: "not a git repo",
			code: 128,
		});
		const result = await loadProjectGuidelines(cwd, exec);
		assert.equal(result, null);
	});

	it("returns null for empty file", async () => {
		const cwd = makeTmpDir();
		const docDir = path.join(cwd, "doc");
		fs.mkdirSync(docDir);
		fs.writeFileSync(
			path.join(docDir, "review-guidelines.md"), "",
		);
		const exec: ExecFn = async () => ({
			stdout: "",
			stderr: "",
			code: 128,
		});
		const result = await loadProjectGuidelines(cwd, exec);
		assert.equal(result, null);
	});

	it("returns null for whitespace-only file", async () => {
		const cwd = makeTmpDir();
		const docDir = path.join(cwd, "doc");
		fs.mkdirSync(docDir);
		fs.writeFileSync(
			path.join(docDir, "review-guidelines.md"), "   \n\t\n  ",
		);
		const exec: ExecFn = async () => ({
			stdout: "",
			stderr: "",
			code: 128,
		});
		const result = await loadProjectGuidelines(cwd, exec);
		assert.equal(result, null);
	});
});
