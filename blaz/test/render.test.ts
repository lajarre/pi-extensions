import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	alignFooterLine,
	buildFooterRight,
	buildFooterStatsLeft,
	buildPwdLine,
	buildRightAlignedLine,
	injectLabelOnBorder,
	replaceHomePrefix,
	stripAnsi,
	truncatePlain,
	visibleWidth,
} from "../render.js";

describe("stripAnsi", () => {
	it("removes sgr sequences", () => {
		assert.equal(stripAnsi("\x1b[31mred\x1b[0m"), "red");
	});
});

describe("visibleWidth", () => {
	it("measures visible chars only", () => {
		assert.equal(visibleWidth("\x1b[31mabc\x1b[0m"), 3);
	});
});

describe("truncatePlain", () => {
	it("keeps short text", () => {
		assert.equal(truncatePlain("abc", 5), "abc");
	});

	it("truncates long text with ellipsis", () => {
		assert.equal(truncatePlain("abcdefgh", 5), "ab...");
	});

	it("handles wide characters", () => {
		assert.equal(visibleWidth("界"), 2);
		assert.equal(truncatePlain("ab界cd", 5), "ab...");
	});
});

describe("replaceHomePrefix", () => {
	it("replaces home prefix with tilde", () => {
		assert.equal(replaceHomePrefix("/Users/alex/workspace", "/Users/alex"), "~/workspace");
	});
});

describe("buildPwdLine", () => {
	it("includes branch but not session name", () => {
		assert.equal(buildPwdLine("~/workspace/aidev", "main"), "~/workspace/aidev (main)");
	});
});

describe("buildRightAlignedLine", () => {
	it("right aligns plain text", () => {
		assert.equal(buildRightAlignedLine("name", 10), "      name");
	});

	it("handles wide text", () => {
		const line = buildRightAlignedLine("界界", 8);
		assert.equal(visibleWidth(line), 8);
		assert.ok(line.endsWith("界界"));
	});
});

describe("injectLabelOnBorder", () => {
	it("places the label on the same line", () => {
		const line = "─".repeat(20);
		const result = injectLabelOnBorder(line, "namgenagg", 20);
		assert.equal(result.prefix + result.label, `───────── namgenagg `);
	});

	it("preserves scroll indicator prefix when present", () => {
		const line = "─── ↑ 3 more ───────";
		const result = injectLabelOnBorder(line, "name", 20);
		assert.equal(result.prefix + result.label, "─── ↑ 3 more ─ name ");
	});

	it("accounts for wide labels", () => {
		const line = "─".repeat(12);
		const result = injectLabelOnBorder(line, "界界", 12);
		assert.equal(visibleWidth(result.prefix + result.label), 12);
	});
});

describe("footer line helpers", () => {
	it("builds left stats string", () => {
		assert.equal(
			buildFooterStatsLeft({
				input: 1200,
				output: 3400,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 1.234,
				contextPercent: 42.3,
				contextWindow: 272000,
				autoCompactEnabled: true,
				modelName: "gpt-5.4",
				providerCount: 1,
				reasoning: true,
				usingSubscription: false,
			}),
			"↑1.2k ↓3.4k $1.234 42.3%/272k (auto)",
		);
	});

	it("builds right side with provider and thinking", () => {
		assert.equal(
			buildFooterRight({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextPercent: null,
				contextWindow: 0,
				autoCompactEnabled: true,
				modelName: "gpt-5.4",
				providerName: "openai-codex",
				providerCount: 2,
				thinkingLevel: "xhigh",
				reasoning: true,
				usingSubscription: false,
			}),
			"(openai-codex) gpt-5.4 • xhigh",
		);
	});

	it("aligns footer sides within width", () => {
		const line = alignFooterLine("left", "right", 20);
		assert.equal(visibleWidth(line), 20);
		assert.match(line, /^left\s+right$/);
	});
});
