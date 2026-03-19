import { appendFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { runSync } from "../../pi-subagents/execution.js";
import type {
	AgentConfig,
	AgentSource,
} from "../../pi-subagents/agents.js";
import type { SingleResult } from "../../pi-subagents/types.js";
import { evaluateGate, shouldStop, type GateConfig } from "./gate.js";
import type { ExecFn, WiggumSettings } from "./settings.js";
import { DEFAULT_WIGGUM_REVIEW_PROMPT } from "./settings.js";

// ── Types ────────────────────────────────────────────────────

export interface FlowConfig {
	name: string;
	assembleContext: (iteration: number) => Promise<string>;
	agentConfig: AgentConfig;
	maxIterations: number;
	gateConfig: GateConfig;
}

export interface LoopResult {
	iterations: number;
	exitReason: "clean" | "max-iterations" | "stopped" | "error";
	lastOutput: string;
}

export interface WiggumWidgetState {
	iteration: number;
	maxIterations: number;
	phase: "agent" | "testing" | "gate" | "done";
	agentName: string;
	currentTool?: string;
	recentOutput: string[];
	tokens: number;
	durationMs: number;
}

export interface LoopOptions {
	cwd: string;
	exec: ExecFn;
	logFile?: string;
	signal?: AbortSignal;
	onIterationStart?: (iteration: number, max: number) => void;
	onIterationEnd?: (
		iteration: number,
		max: number,
		gateReason: string,
	) => void;
	onProgress?: (state: WiggumWidgetState) => void;
}

function writeLogLine(logFile: string | undefined, data: Record<string, unknown>): void {
	if (!logFile) return;
	try {
		appendFileSync(logFile, JSON.stringify(data) + "\n");
	} catch {}
}

// ── Agent construction ───────────────────────────────────────

export function buildInlineAgent(
	settings: WiggumSettings,
): AgentConfig {
	return {
		name: "wiggum-reviewer",
		description: "Fresh-context code reviewer for wiggum loop",
		systemPrompt: settings.reviewPrompt || DEFAULT_WIGGUM_REVIEW_PROMPT,
		source: "project" as AgentSource,
		filePath: "",
	};
}

// ── Output extraction ────────────────────────────────────────

/**
 * Extract the final assistant text from a SingleResult.
 * Mirrors pi-subagents' getFinalOutput pattern.
 */
export function extractOutput(result: SingleResult): string {
	const messages = result.messages || [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role !== "assistant") continue;
		const content = msg.content;
		if (!Array.isArray(content)) continue;
		const texts: string[] = [];
		for (const part of content) {
			if (
				part &&
				typeof part === "object" &&
				"type" in part &&
				part.type === "text" &&
				"text" in part &&
				typeof part.text === "string"
			) {
				texts.push(part.text);
			}
		}
		if (texts.length > 0) return texts.join("\n");
	}
	return "";
}

// ── Loop engine ──────────────────────────────────────────────

export async function runWiggumLoop(
	flow: FlowConfig,
	options: LoopOptions,
): Promise<LoopResult> {
	const { cwd, exec, signal } = options;
	const loopStart = Date.now();
	let lastOutput = "";
	let consecutiveErrors = 0;

	if (options.logFile) {
		try { writeFileSync(options.logFile, ""); } catch {}
	}

	for (let i = 1; i <= flow.maxIterations; i++) {
		// check abort
		if (signal?.aborted) {
			writeLogLine(options.logFile, {
				type: "summary",
				iterations: i - 1,
				exitReason: "stopped",
				totalDurationMs: Date.now() - loopStart,
			});
			return { iterations: i - 1, exitReason: "stopped", lastOutput };
		}

		const iterationStart = Date.now();
		options.onIterationStart?.(i, flow.maxIterations);

		// 1. assemble context
		let task: string;
		try {
			task = await flow.assembleContext(i);
		} catch (err) {
			lastOutput = err instanceof Error ? err.message : String(err);
			options.onIterationEnd?.(i, flow.maxIterations, `context error: ${lastOutput}`);
			consecutiveErrors++;
			if (consecutiveErrors >= 3) {
				writeLogLine(options.logFile, {
					type: "summary",
					iterations: i,
					exitReason: "error",
					totalDurationMs: Date.now() - loopStart,
				});
				return { iterations: i, exitReason: "error", lastOutput };
			}
			continue;
		}

		// 2. run fresh agent
		let result: SingleResult;
		let lastTokens = 0;
		let lastDurationMs = 0;
		try {
			const runId = randomUUID().slice(0, 8);
			result = await runSync(
				cwd,
				[flow.agentConfig],
				flow.agentConfig.name,
				task,
				{
					runId,
					signal,
					onUpdate: options.onProgress
						? (r) => {
							const p = r.details?.progress?.[0];
							if (!p) return;
							lastTokens = p.tokens || 0;
							lastDurationMs = p.durationMs || 0;
							options.onProgress!({
								iteration: i,
								maxIterations: flow.maxIterations,
								phase: "agent",
								agentName: flow.agentConfig.name,
								currentTool: p.currentTool,
								recentOutput: p.recentOutput || [],
								tokens: lastTokens,
								durationMs: lastDurationMs,
							});
						}
						: undefined,
				},
			);
		} catch (err) {
			lastOutput = err instanceof Error ? err.message : String(err);
			options.onIterationEnd?.(i, flow.maxIterations, `agent error: ${lastOutput}`);
			consecutiveErrors++;
			if (consecutiveErrors >= 3) {
				writeLogLine(options.logFile, {
					type: "summary",
					iterations: i,
					exitReason: "error",
					totalDurationMs: Date.now() - loopStart,
				});
				return { iterations: i, exitReason: "error", lastOutput };
			}
			continue;
		}

		consecutiveErrors = 0;

		lastOutput = extractOutput(result);

		// 3. evaluate gate
		options.onProgress?.({
			iteration: i,
			maxIterations: flow.maxIterations,
			phase: "testing",
			agentName: flow.agentConfig.name,
			recentOutput: [],
			tokens: lastTokens,
			durationMs: lastDurationMs,
		});

		const gate = await evaluateGate(
			lastOutput,
			flow.gateConfig,
			cwd,
			exec,
		);

		options.onIterationEnd?.(i, flow.maxIterations, gate.reason);

		writeLogLine(options.logFile, {
			iteration: i,
			maxIterations: flow.maxIterations,
			durationMs: Date.now() - iterationStart,
			gateResult: { shouldStop: gate.shouldStop, reason: gate.reason },
			agentSignal: shouldStop(lastOutput, flow.gateConfig.stopSignal),
		});

		if (gate.shouldStop) {
			writeLogLine(options.logFile, {
				type: "summary",
				iterations: i,
				exitReason: "clean",
				totalDurationMs: Date.now() - loopStart,
			});
			return { iterations: i, exitReason: "clean", lastOutput };
		}
	}

	writeLogLine(options.logFile, {
		type: "summary",
		iterations: flow.maxIterations,
		exitReason: "max-iterations",
		totalDurationMs: Date.now() - loopStart,
	});
	return {
		iterations: flow.maxIterations,
		exitReason: "max-iterations",
		lastOutput,
	};
}
