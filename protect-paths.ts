/**
 * Protect Paths Extension
 *
 * Standalone directory protection hooks that complement @aliou/pi-guardrails
 * (which handles .env files and dangerous command confirmation)
 *
 * This extension protects:
 * - .git/ directory contents (prevents repository corruption)
 * - Homebrew install/upgrade commands (remind to use project package manager)
 * - Direct delete commands (rm/rmdir/unlink) are blocked on macOS
 *   (use Trash tool)
 * - Manual `mv ... ~/.Trash` flows are blocked (use Trash tool)
 * - Piped shell execution (e.g. `curl ... | sh`)
 *
 * Bash command checks are AST-backed via just-bash parsing so nested
 * substitutions/functions/conditionals are inspected instead of regex-only matching
 *
 * Dependency note:
 * - For best results, install `just-bash` >= 2 (provides the bash AST parser export)
 * - If unavailable, this extension falls back to best-effort regex checks
 */

import { resolve, sep, dirname, relative } from "node:path";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

let parseBash: ((input: string) => any) | null = null;
let justBashLoadPromise: Promise<void> | null = null;
let justBashLoadDone = false;

async function ensureJustBashLoaded(): Promise<void> {
    if (justBashLoadDone) return;

    if (!justBashLoadPromise) {
        justBashLoadPromise = import("just-bash")
            .then((mod: any) => {
                parseBash = typeof mod?.parse === "function" ? mod.parse : null;
            })
            .catch(() => {
                parseBash = null;
            })
            .finally(() => {
                justBashLoadDone = true;
            });
    }

    await justBashLoadPromise;
}

let warnedAstUnavailable = false;
function maybeWarnAstUnavailable(ctx: any): void {
    if (warnedAstUnavailable) return;
    if (parseBash) return;
    if (!ctx?.hasUI) return;

    warnedAstUnavailable = true;
    ctx.ui.notify(
        "protect-paths: just-bash >= 2 is not available; falling back to best-effort regex command checks",
        "warning",
    );
}

type BashInvocation = {
    pipelineIndex: number;
    pipelineLength: number;
    commandNameRaw: string;
    assignments: string[];
    args: string[];
    effectiveCommandNameRaw: string;
    effectiveCommandName: string;
    effectiveArgs: string[];
    redirections: Array<{ target: string }>;
};

type BashAnalysis = {
    parseError?: string;
    invocations: BashInvocation[];
};

const WRAPPER_COMMANDS = new Set(["command", "builtin", "nohup"]);

function commandBaseName(value: string): string {
    const normalized = value.replace(/\\+/g, "/");
    const idx = normalized.lastIndexOf("/");
    const base = idx >= 0 ? normalized.slice(idx + 1) : normalized;
    return base.toLowerCase();
}

function partToText(part: any): string {
    if (!part || typeof part !== "object") return "";

    switch (part.type) {
        case "Literal":
        case "SingleQuoted":
        case "Escaped":
            return typeof part.value === "string" ? part.value : "";
        case "DoubleQuoted":
            return Array.isArray(part.parts) ? part.parts.map(partToText).join("") : "";
        case "Glob":
            return typeof part.pattern === "string" ? part.pattern : "";
        case "TildeExpansion":
            return typeof part.user === "string" && part.user.length > 0 ? `~${part.user}` : "~";
        case "BraceExpansion":
            return "{...}";
        case "ParameterExpansion":
            return typeof part.parameter === "string" && part.parameter.length > 0
                ? "${" + part.parameter + "}"
                : "${}";
        case "CommandSubstitution":
            return "$(...)";
        case "ProcessSubstitution":
            return part.direction === "output" ? ">(...)" : "<(...)";
        case "ArithmeticExpansion":
            return "$((...))";
        default:
            return "";
    }
}

function wordToText(word: any): string {
    if (!word || typeof word !== "object" || !Array.isArray(word.parts)) return "";
    return word.parts.map(partToText).join("");
}

type UnwrappedCommand = {
    nextCommandRaw: string;
    nextArgs: string[];
};

const SUDO_SHORT_VALUE_OPTIONS = new Set(["-C", "-D", "-g", "-h", "-p", "-R", "-T", "-u", "-r", "-t"]);
const SUDO_LONG_VALUE_OPTIONS = new Set([
    "--chdir",
    "--chroot",
    "--close-from",
    "--group",
    "--host",
    "--other-user",
    "--prompt",
    "--role",
    "--type",
    "--user",
]);

function unwrapSimpleWrapper(args: string[]): UnwrappedCommand | null {
    let idx = 0;
    while (idx < args.length) {
        const token = args[idx] ?? "";
        if (token === "--") {
            idx += 1;
            break;
        }
        if (token.startsWith("-")) {
            idx += 1;
            continue;
        }
        break;
    }

    const nextCommandRaw = (args[idx] ?? "").trim();
    if (!nextCommandRaw) return null;

    return {
        nextCommandRaw,
        nextArgs: args.slice(idx + 1),
    };
}

function tokenizeQuotedWords(value: string): string[] {
    const matches = value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    return matches.map((token) => token.replace(/^['"]|['"]$/g, ""));
}

function splitCommandString(value: string): { command: string; args: string[] } | null {
    const tokens = tokenizeQuotedWords(value);
    if (tokens.length === 0) return null;

    return {
        command: tokens[0],
        args: tokens.slice(1),
    };
}

function findOptionWithPossibleValue(token: string, options: Set<string>): string | null {
    for (const option of options) {
        if (token === option || token.startsWith(`${option}=`)) {
            return option;
        }
    }

    return null;
}

function unwrapEnv(args: string[]): UnwrappedCommand | null {
    let idx = 0;
    while (idx < args.length) {
        const token = args[idx] ?? "";
        if (token === "--") {
            idx += 1;
            break;
        }

        if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) {
            idx += 1;
            continue;
        }

        if (token === "-S" || token === "--split-string") {
            idx += 1;
            const value = args[idx] ?? "";
            const parsed = splitCommandString(value);
            if (parsed) {
                return {
                    nextCommandRaw: parsed.command,
                    nextArgs: [...parsed.args, ...args.slice(idx + 1)],
                };
            }
            if (idx < args.length) idx += 1;
            continue;
        }

        if (token.startsWith("--split-string=")) {
            const parsed = splitCommandString(token.slice("--split-string=".length));
            if (parsed) {
                return {
                    nextCommandRaw: parsed.command,
                    nextArgs: [...parsed.args, ...args.slice(idx + 1)],
                };
            }
            idx += 1;
            continue;
        }

        if (token === "-C" || token === "-u") {
            idx += 1;
            if (idx < args.length) idx += 1;
            continue;
        }

        if (token === "--chdir" || token === "--unset") {
            idx += 1;
            if (idx < args.length) idx += 1;
            continue;
        }

        if (token.startsWith("--chdir=") || token.startsWith("--unset=")) {
            idx += 1;
            continue;
        }

        if (token.startsWith("-")) {
            idx += 1;
            continue;
        }

        break;
    }

    const nextCommandRaw = (args[idx] ?? "").trim();
    if (!nextCommandRaw) return null;

    return {
        nextCommandRaw,
        nextArgs: args.slice(idx + 1),
    };
}

function unwrapSudo(args: string[]): UnwrappedCommand | null {
    let idx = 0;
    while (idx < args.length) {
        const token = args[idx] ?? "";
        if (token === "--") {
            idx += 1;
            break;
        }

        if (SUDO_LONG_VALUE_OPTIONS.has(token)) {
            idx += 1;
            if (idx < args.length) idx += 1;
            continue;
        }

        if (token.includes("=") && findOptionWithPossibleValue(token, SUDO_LONG_VALUE_OPTIONS)) {
            idx += 1;
            continue;
        }

        if (SUDO_SHORT_VALUE_OPTIONS.has(token)) {
            idx += 1;
            if (idx < args.length) idx += 1;
            continue;
        }

        if (token.startsWith("-") && token.length > 2 && SUDO_SHORT_VALUE_OPTIONS.has(token.slice(0, 2))) {
            idx += 1;
            continue;
        }

        if (token.startsWith("-")) {
            idx += 1;
            continue;
        }

        break;
    }

    const nextCommandRaw = (args[idx] ?? "").trim();
    if (!nextCommandRaw) return null;

    return {
        nextCommandRaw,
        nextArgs: args.slice(idx + 1),
    };
}

function unwrapExec(args: string[]): UnwrappedCommand | null {
    let idx = 0;
    while (idx < args.length) {
        const token = args[idx] ?? "";
        if (token === "--") {
            idx += 1;
            break;
        }

        if (token === "-a") {
            idx += 1;
            if (idx < args.length) idx += 1;
            continue;
        }

        if (token.startsWith("-a") && token.length > 2) {
            idx += 1;
            continue;
        }

        if (token.startsWith("-")) {
            idx += 1;
            continue;
        }

        break;
    }

    const nextCommandRaw = (args[idx] ?? "").trim();
    if (!nextCommandRaw) return null;

    return {
        nextCommandRaw,
        nextArgs: args.slice(idx + 1),
    };
}

function unwrapNice(args: string[]): UnwrappedCommand | null {
    let idx = 0;
    while (idx < args.length) {
        const token = args[idx] ?? "";
        if (token === "--") {
            idx += 1;
            break;
        }

        if (token === "-n") {
            idx += 1;
            if (idx < args.length) idx += 1;
            continue;
        }

        if (token.startsWith("-n") && token.length > 2) {
            idx += 1;
            continue;
        }

        if (token.startsWith("-")) {
            idx += 1;
            continue;
        }

        break;
    }

    const nextCommandRaw = (args[idx] ?? "").trim();
    if (!nextCommandRaw) return null;

    return {
        nextCommandRaw,
        nextArgs: args.slice(idx + 1),
    };
}

function unwrapStdbuf(args: string[]): UnwrappedCommand | null {
    let idx = 0;
    while (idx < args.length) {
        const token = args[idx] ?? "";
        if (token === "--") {
            idx += 1;
            break;
        }

        if (token === "-i" || token === "-o" || token === "-e") {
            idx += 1;
            if (idx < args.length) idx += 1;
            continue;
        }

        if ((token.startsWith("-i") || token.startsWith("-o") || token.startsWith("-e")) && token.length > 2) {
            idx += 1;
            continue;
        }

        if (token.startsWith("-")) {
            idx += 1;
            continue;
        }

        break;
    }

    const nextCommandRaw = (args[idx] ?? "").trim();
    if (!nextCommandRaw) return null;

    return {
        nextCommandRaw,
        nextArgs: args.slice(idx + 1),
    };
}

function unwrapTime(args: string[]): UnwrappedCommand | null {
    let idx = 0;
    while (idx < args.length) {
        const token = args[idx] ?? "";
        if (token === "--") {
            idx += 1;
            break;
        }

        if (token === "-p" || token === "--portability") {
            idx += 1;
            continue;
        }

        if (token === "-f" || token === "-o") {
            idx += 1;
            if (idx < args.length) idx += 1;
            continue;
        }

        if (token.startsWith("-f") || token.startsWith("-o")) {
            idx += 1;
            continue;
        }

        if (token === "--format" || token === "--output") {
            idx += 1;
            if (idx < args.length) idx += 1;
            continue;
        }

        if (token.startsWith("--format=") || token.startsWith("--output=")) {
            idx += 1;
            continue;
        }

        if (token.startsWith("-")) {
            idx += 1;
            continue;
        }

        break;
    }

    const nextCommandRaw = (args[idx] ?? "").trim();
    if (!nextCommandRaw) return null;

    return {
        nextCommandRaw,
        nextArgs: args.slice(idx + 1),
    };
}

function unwrapCommandLayer(commandNameRaw: string, args: string[]): UnwrappedCommand | null {
    const base = commandBaseName(commandNameRaw);

    if (WRAPPER_COMMANDS.has(base)) {
        return unwrapSimpleWrapper(args);
    }

    if (base === "env") {
        return unwrapEnv(args);
    }

    if (base === "sudo") {
        return unwrapSudo(args);
    }

    if (base === "exec") {
        return unwrapExec(args);
    }

    if (base === "nice") {
        return unwrapNice(args);
    }

    if (base === "stdbuf") {
        return unwrapStdbuf(args);
    }

    if (base === "time") {
        return unwrapTime(args);
    }

    return null;
}

function resolveEffectiveCommand(commandNameRaw: string, args: string[]): {
    effectiveCommandNameRaw: string;
    effectiveCommandName: string;
    effectiveArgs: string[];
} {
    let currentCommandRaw = commandNameRaw.trim();
    let currentArgs = [...args];
    const seenStates = new Set<string>();

    while (true) {
        const stateKey = `${currentCommandRaw}\0${currentArgs.join("\0")}`;
        if (seenStates.has(stateKey)) {
            break;
        }
        seenStates.add(stateKey);

        const unwrapped = unwrapCommandLayer(currentCommandRaw, currentArgs);
        if (!unwrapped) break;

        currentCommandRaw = unwrapped.nextCommandRaw;
        currentArgs = unwrapped.nextArgs;
    }

    return {
        effectiveCommandNameRaw: currentCommandRaw,
        effectiveCommandName: commandBaseName(currentCommandRaw),
        effectiveArgs: currentArgs,
    };
}

function extractShellDashCScript(args: string[]): string | null {
    let idx = 0;

    while (idx < args.length) {
        const token = (args[idx] ?? "").trim();
        if (!token) {
            idx += 1;
            continue;
        }

        if (token === "--") {
            break;
        }

        if (token === "-c") {
            const script = (args[idx + 1] ?? "").trim();
            return script || null;
        }

        if (/^-[A-Za-z]+$/.test(token) && token.includes("c")) {
            const script = (args[idx + 1] ?? "").trim();
            return script || null;
        }

        if (token === "-o" || token === "+o") {
            idx += 2;
            continue;
        }

        if (token.startsWith("-o") || token.startsWith("+o")) {
            idx += 1;
            continue;
        }

        if (token.startsWith("-") || token.startsWith("+")) {
            idx += 1;
            continue;
        }

        break;
    }

    return null;
}

function collectNestedScriptsFromWord(word: any, collect: (script: any) => void): void {
    if (!word || typeof word !== "object" || !Array.isArray(word.parts)) return;

    for (const part of word.parts) {
        if (!part || typeof part !== "object") continue;

        if (part.type === "DoubleQuoted") {
            collectNestedScriptsFromWord(part, collect);
            continue;
        }

        if ((part.type === "CommandSubstitution" || part.type === "ProcessSubstitution") && part.body) {
            collect(part.body);
        }
    }
}

function analyzeBashScript(command: string): BashAnalysis {
    try {
        if (!parseBash) {
            return { parseError: "just-bash parse unavailable", invocations: [] };
        }

        const ast: any = parseBash(command);
        const invocations: BashInvocation[] = [];

        const visitScript = (script: any) => {
            if (!script || typeof script !== "object" || !Array.isArray(script.statements)) return;

            for (const statement of script.statements) {
                if (!statement || typeof statement !== "object" || !Array.isArray(statement.pipelines)) continue;

                for (const pipeline of statement.pipelines) {
                    if (!pipeline || typeof pipeline !== "object" || !Array.isArray(pipeline.commands)) continue;

                    const pipelineLength = pipeline.commands.length;

                    for (const [pipelineIndex, commandNode] of pipeline.commands.entries()) {
                        if (!commandNode || typeof commandNode !== "object") continue;

                        if (commandNode.type === "SimpleCommand") {
                            const commandNameRaw = wordToText(commandNode.name).trim();
                            const assignments = Array.isArray(commandNode.assignments)
                                ? commandNode.assignments
                                    .map((assignment: any) =>
                                        wordToText(assignment?.value ?? assignment?.word ?? assignment))
                                    .filter(Boolean)
                                : [];
                            const args = Array.isArray(commandNode.args)
                                ? commandNode.args.map((arg: any) => wordToText(arg)).filter(Boolean)
                                : [];
                            const redirections = Array.isArray(commandNode.redirections)
                                ? commandNode.redirections.map((r: any) => ({
                                    target: r?.target?.type === "HereDoc" ? "heredoc" : wordToText(r?.target),
                                }))
                                : [];

                            const effective = resolveEffectiveCommand(commandNameRaw, args);
                            invocations.push({
                                pipelineIndex,
                                pipelineLength,
                                commandNameRaw,
                                assignments,
                                args,
                                effectiveCommandNameRaw: effective.effectiveCommandNameRaw,
                                effectiveCommandName: effective.effectiveCommandName,
                                effectiveArgs: effective.effectiveArgs,
                                redirections,
                            });

                            if (SHELL_EXECUTABLES.has(effective.effectiveCommandName)) {
                                const shellScript = extractShellDashCScript(effective.effectiveArgs);
                                if (shellScript) {
                                    const nested = analyzeBashScript(shellScript);
                                    if (!nested.parseError && nested.invocations.length > 0) {
                                        invocations.push(...nested.invocations);
                                    }
                                }
                            }

                            if (commandNode.name) {
                                collectNestedScriptsFromWord(commandNode.name, visitScript);
                            }
                            if (Array.isArray(commandNode.args)) {
                                for (const arg of commandNode.args) {
                                    collectNestedScriptsFromWord(arg, visitScript);
                                }
                            }
                            if (Array.isArray(commandNode.assignments)) {
                                for (const assignment of commandNode.assignments) {
                                    if (assignment?.value) {
                                        collectNestedScriptsFromWord(assignment.value, visitScript);
                                    }
                                    if (assignment?.word) {
                                        collectNestedScriptsFromWord(assignment.word, visitScript);
                                    }
                                }
                            }
                            if (Array.isArray(commandNode.redirections)) {
                                for (const redirection of commandNode.redirections) {
                                    if (redirection?.target) {
                                        collectNestedScriptsFromWord(redirection.target, visitScript);
                                    }
                                }
                            }
                            continue;
                        }

                        if (Array.isArray(commandNode.body)) visitScript({ statements: commandNode.body });
                        if (commandNode.body && Array.isArray(commandNode.body.statements)) {
                            visitScript(commandNode.body);
                        }
                        if (Array.isArray(commandNode.condition)) visitScript({ statements: commandNode.condition });
                        if (Array.isArray(commandNode.clauses)) {
                            for (const clause of commandNode.clauses) {
                                if (Array.isArray(clause?.condition)) visitScript({ statements: clause.condition });
                                if (Array.isArray(clause?.body)) visitScript({ statements: clause.body });
                            }
                        }
                        if (Array.isArray(commandNode.elseBody)) visitScript({ statements: commandNode.elseBody });
                        if (Array.isArray(commandNode.items)) {
                            for (const item of commandNode.items) {
                                if (Array.isArray(item?.body)) visitScript({ statements: item.body });
                            }
                        }
                        if (commandNode.word) collectNestedScriptsFromWord(commandNode.word, visitScript);
                        if (Array.isArray(commandNode.words)) {
                            for (const word of commandNode.words) {
                                collectNestedScriptsFromWord(word, visitScript);
                            }
                        }
                    }
                }
            }
        };

        visitScript(ast);
        return { invocations };
    } catch (error: any) {
        return { parseError: error?.message ?? String(error), invocations: [] };
    }
}

// ============================================================================
// Configuration
// ============================================================================

const SHELL_EXECUTABLES = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const DELETE_EXECUTABLES = new Set(["rm", "rmdir", "unlink"]);
const BREW_ACTIONS = new Set(["install", "upgrade", "reinstall"]);
const TRASH_MOVE_BLOCK_REASON = "Manual Trash moves are blocked. Use move_to_trash.";
const BREW_QUERY_OPTIONS = new Set([
    "--prefix",
    "--cellar",
    "--repository",
    "--cache",
    "--env",
    "--config",
    "--version",
    "--help",
    "-h",
]);

const GIT_REF_REGEX = /(^|[^A-Za-z0-9._-])((?:[^\s]*[\\/])?\.git(?:[\\/][^\s]*)?)(?=$|[^A-Za-z0-9._-])/gi;
const GIT_SPLIT_REF_REGEX = /(^|[^A-Za-z0-9._-])((?:[^\s]*[\\/])?\.g(?:\$\{[^}]+\}|\$\([^)]+\)|\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!_-])|\{[^}]*\})it(?:[\\/][^\s]*)?)(?=$|[^A-Za-z0-9._-])/gi;
const NON_PATH_LITERAL_COMMANDS = new Set(["echo", "printf"]);
const DELETE_BRACE_EXPANSION_REGEX = /\br\{[^}]*\}m\b/i;

const HOME_DIR = process.env.HOME ? resolve(process.env.HOME) : "";
const MACOS_TRASH_DIR = HOME_DIR ? resolve(HOME_DIR, ".Trash") : "";
const MACOS_TRASH_SUPPORTED = process.platform === "darwin" && Boolean(HOME_DIR);
const TRASH_EXEC_TIMEOUT_MS = 15_000;

const MoveToTrashParams = Type.Object({
    paths: Type.Array(
        Type.String({
            minLength: 1,
            description: "Path to move to macOS Trash (relative or absolute, within current workspace)",
        }),
        {
            minItems: 1,
            description: "One or more workspace paths to move to macOS Trash",
        },
    ),
});

const READ_TOOLS = ["read", "grep", "find", "ls"];
const WRITE_TOOLS = ["write", "edit"];

// ============================================================================
// Path checking
// ============================================================================

const GIT_DIR_PATTERN = /(?:^|[/\\])\.git(?:[/\\]|$)/;

function normalizePathForProtection(filePath: string): string {
    return resolve(filePath).toLowerCase();
}

function isProtectedDirectory(filePath: string): boolean {
    return GIT_DIR_PATTERN.test(normalizePathForProtection(filePath));
}

function getProtectionReason(filePath: string): string {
    return `Accessing ${filePath} is not allowed. The .git directory is protected to prevent repository corruption.`;
}

function extractPathCandidates(toolName: string, input: Record<string, unknown>): string[] {
    const candidates: string[] = [];

    const pushCandidate = (value: unknown) => {
        const text = String(value ?? "").trim();
        if (!text) return;
        candidates.push(text);
    };

    pushCandidate(input.file_path ?? input.path);

    if (toolName === "grep") {
        pushCandidate(input.glob);
    }

    if (toolName === "find") {
        pushCandidate(input.pattern);
    }

    return [...new Set(candidates)];
}

function appendMatches(refs: Set<string>, token: string, regex: RegExp): void {
    regex.lastIndex = 0;
    for (const match of token.matchAll(regex)) {
        const captured = typeof match[2] === "string" ? match[2].trim() : "";
        if (!captured) continue;
        refs.add(captured);
    }
}

function hasHereDocInvocation(analysis: BashAnalysis): boolean {
    return analysis.invocations.some((invocation) =>
        invocation.redirections.some((redirection) => redirection.target === "heredoc"));
}

function hasPotentialShellExpansion(command: string): boolean {
    return /\$|`|\{[^}]*,[^}]*\}|\{[^}]*\.\.[^}]*\}|[?*\[]/.test(command);
}

function isDynamicCommandNameToken(value: string): boolean {
    const trimmed = value.trim();

    if (/^\$\(|^`|^\$\{|^\$[A-Za-z0-9@*#?$!_-]/.test(trimmed)) {
        return true;
    }

    return /\$\{[^}]+\}|\$\([^)]+\)|`[^`]+`|\$[A-Za-z0-9@*#?$!_-]/.test(trimmed);
}

function normalizeExpandableText(value: string): string {
    return value
        .replace(/\$'([^']*)'/g, "$1")
        .replace(/\$"([^"]*)"/g, "$1")
        .replace(/\$\{[^}]*\}|\$\([^)]+\)|`[^`]*`|\$[A-Za-z0-9@*#?$!_-]+/g, "")
        .replace(/\{([^}]*)\}/g, (_match, inner: string) => {
            if (inner.includes("..")) return inner.split("..")[0] ?? "";
            return inner.replace(/,/g, "");
        })
        .replace(/\[([^\]]+)\]/g, "$1")
        .replace(/[?*]/g, "")
        .toLowerCase();
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripWrappingQuotes(value: string): string {
    let trimmed = value.trim();

    while (trimmed.length >= 2) {
        const first = trimmed[0] ?? "";
        const last = trimmed[trimmed.length - 1] ?? "";
        if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
            trimmed = trimmed.slice(1, -1).trim();
            continue;
        }
        break;
    }

    return trimmed;
}

function isTrashDestinationPath(value: string): boolean {
    const unquoted = stripWrappingQuotes(value);
    if (!unquoted) return false;

    const normalized = unquoted.replace(/\\+/g, "/");

    if (/^(?:~|\$HOME|\$\{HOME\})\/\.Trash(?:\/|$)/.test(normalized)) {
        return true;
    }

    if (!MACOS_TRASH_DIR) {
        return false;
    }

    const lowerNormalized = normalized.toLowerCase();
    const lowerTrashDir = MACOS_TRASH_DIR.replace(/\\+/g, "/").toLowerCase();
    return lowerNormalized === lowerTrashDir || lowerNormalized.startsWith(`${lowerTrashDir}/`);
}

function extractMvDestinationArg(args: string[]): string | null {
    let targetDirectory: string | null = null;
    const positional: string[] = [];

    for (let idx = 0; idx < args.length; idx++) {
        const token = (args[idx] ?? "").trim();
        if (!token) continue;

        if (token === "--") {
            positional.push(...args.slice(idx + 1).map((value) => value.trim()).filter(Boolean));
            break;
        }

        if (token === "-t" || token === "--target-directory") {
            if (idx + 1 < args.length) {
                targetDirectory = (args[idx + 1] ?? "").trim();
                idx += 1;
            }
            continue;
        }

        if (token.startsWith("--target-directory=")) {
            targetDirectory = token.slice("--target-directory=".length).trim();
            continue;
        }

        if (token.startsWith("-t") && token.length > 2) {
            targetDirectory = token.slice(2).trim();
            continue;
        }

        if (token.startsWith("-")) {
            continue;
        }

        positional.push(token);
    }

    if (targetDirectory) {
        return targetDirectory;
    }

    return positional.length >= 2
        ? positional[positional.length - 1] ?? null
        : null;
}

function isMvIntoTrash(args: string[]): boolean {
    const destination = extractMvDestinationArg(args);
    if (!destination) {
        return false;
    }

    return isTrashDestinationPath(destination);
}

function containsObfuscatedGitReference(value: string): boolean {
    const compact = value.replace(/\s+/g, "");

    if (/\.g(?:\$\([^)]+\)|`[^`]+`)+t/i.test(compact)) {
        return true;
    }

    if (/\.g(?:\$\{[^}]+\}|\$[A-Za-z0-9@*#?$!_-]+|\$\([^)]+\)|`[^`]+`|\[[^\]]+\]|[?*])+(?:[\\/]|$)/i.test(compact)) {
        return true;
    }

    if (/\.g(?:\$\{[^}]+\}|\$[A-Za-z0-9@*#?$!_-]+|\$\([^)]+\)|`[^`]+`|\[[^\]]+\]|[?*])+t/i.test(compact)) {
        return true;
    }

    if (/\.gi(?:\$\{[^}]+\}|\$[A-Za-z0-9@*#?$!_-]+|\$\([^)]+\)|`[^`]+`|[?*])+t/i.test(compact)) {
        return true;
    }

    if (/\.g\[[^\]]+\]t/i.test(compact) || /\.gi[?*]/i.test(compact)) {
        return true;
    }

    if (/\.gi\[[^\]]+\](?:[\\/]|$)/i.test(compact)) {
        return true;
    }

    if (/\.g(?:\[[^\]]+\]|[?*])(?:\[[^\]]+\]|[?*])(?:[\\/]|$)/i.test(compact)) {
        return true;
    }

    if (/\.g\{(?:it(?:,[^{}]*)?|[^{}]*,it(?:,[^{}]*)?)\}(?:[\\/]|$)/i.test(compact)) {
        return true;
    }

    if (/\.(?:\?|\[[^\]]+\])it(?:[\\/]|$)/i.test(compact)) {
        return true;
    }

    const assignmentEntries = [...value.matchAll(/(?:^|[;\n]|&&|\|\||\s)([A-Za-z_][A-Za-z0-9_]*)=([^;\n&|\s]+)(?=$|[;\n]|&&|\|\||\s)/g)]
        .map((match) => ({
            name: match[1] ?? "",
            value: String(match[2] ?? "").replace(/^['"]|['"]$/g, "").toLowerCase(),
        }))
        .filter((entry) => entry.name.length > 0 && entry.value.length > 0);

    const variableRefRegex = (name: string): string =>
        `\\$(?:\\{${escapeRegex(name)}\\}|${escapeRegex(name)})`;

    for (const entry of assignmentEntries) {
        if (entry.value !== ".git") continue;

        const pattern = new RegExp(`${variableRefRegex(entry.name)}(?=$|[\\\\/\"';|&])`, "i");
        if (pattern.test(compact)) {
            return true;
        }
    }

    const varsByValue = new Map<string, string[]>();
    for (const entry of assignmentEntries) {
        const existing = varsByValue.get(entry.value) ?? [];
        existing.push(entry.name);
        varsByValue.set(entry.value, existing);
    }

    const compositionPairs: Array<[string, string]> = [[".g", "it"], [".gi", "t"], [".", "git"]];
    for (const [prefixValue, suffixValue] of compositionPairs) {
        const prefixVars = varsByValue.get(prefixValue) ?? [];
        const suffixVars = varsByValue.get(suffixValue) ?? [];

        for (const prefixVar of prefixVars) {
            for (const suffixVar of suffixVars) {
                const pattern = new RegExp(
                    `${variableRefRegex(prefixVar)}${variableRefRegex(suffixVar)}(?=$|[\\\\/\"';|&])`,
                    "i",
                );
                if (pattern.test(compact)) {
                    return true;
                }
            }
        }
    }

    const normalized = normalizeExpandableText(value);
    return /(^|[^A-Za-z0-9._-])\.git(?:[\\/]|$)/.test(normalized) || normalized === ".git";
}

function containsObfuscatedDeleteCommand(value: string): boolean {
    const compact = value.replace(/\s+/g, "");
    if (/\br(?:\$\([^)]+\)|`[^`]+`)+m\b/i.test(compact)) {
        return true;
    }

    if (/(^|[^A-Za-z0-9._-])r\{(?:m(?:,[^{}]*)?|[^{}]*,m(?:,[^{}]*)?)\}(?=$|[^A-Za-z0-9._-])/i.test(compact)) {
        return true;
    }

    return /\b(?:rm|rmdir|unlink)\b/.test(normalizeExpandableText(value));
}

function extractProtectedDirRefsFromCommand(command: string, precomputed?: BashAnalysis): string[] {
    const refs = new Set<string>();

    const analysis = precomputed ?? analyzeBashScript(command);
    if (!analysis.parseError) {
        for (const invocation of analysis.invocations) {
            const isStandaloneLiteral =
                NON_PATH_LITERAL_COMMANDS.has(invocation.effectiveCommandName)
                && invocation.pipelineLength === 1
                && invocation.redirections.length === 0;
            const includeArgs = !isStandaloneLiteral;
            const tokens = [
                invocation.commandNameRaw,
                ...invocation.assignments,
                invocation.effectiveCommandNameRaw,
                ...(includeArgs ? invocation.args : []),
                ...(includeArgs ? invocation.effectiveArgs : []),
                ...invocation.redirections.map((r) => r.target),
            ].filter((value) => typeof value === "string" && value.length > 0);

            for (const token of tokens) {
                appendMatches(refs, token, GIT_REF_REGEX);
            }
        }

        const needsFullScan = hasHereDocInvocation(analysis) || hasPotentialShellExpansion(command);
        if (needsFullScan) {
            appendMatches(refs, command, GIT_REF_REGEX);
            appendMatches(refs, command, GIT_SPLIT_REF_REGEX);
            if (containsObfuscatedGitReference(command)) {
                refs.add(".git");
            }
        }
    } else {
        // Fallback: keep regex behavior if parser fails
        appendMatches(refs, command, GIT_REF_REGEX);
        appendMatches(refs, command, GIT_SPLIT_REF_REGEX);
        if (containsObfuscatedGitReference(command)) {
            refs.add(".git");
        }
    }

    return [...refs];
}

type FallbackInvocation = {
    commandNameRaw: string;
    effectiveCommandNameRaw: string;
    effectiveCommandName: string;
    effectiveArgs: string[];
};

function splitTopLevelCommandSegments(command: string): string[] {
    const segments: string[] = [];
    let current = "";
    let inSingle = false;
    let inDouble = false;
    let escapeNext = false;

    const pushSegment = () => {
        const trimmed = current.trim();
        if (trimmed) segments.push(trimmed);
        current = "";
    };

    for (let i = 0; i < command.length; i++) {
        const char = command[i] ?? "";
        const prev = command[i - 1] ?? "";
        const next = command[i + 1] ?? "";

        if (escapeNext) {
            current += char;
            escapeNext = false;
            continue;
        }

        if (char === "\\" && !inSingle) {
            current += char;
            escapeNext = true;
            continue;
        }

        if (!inDouble && char === "'") {
            inSingle = !inSingle;
            current += char;
            continue;
        }

        if (!inSingle && char === '"') {
            inDouble = !inDouble;
            current += char;
            continue;
        }

        if (!inSingle && !inDouble) {
            if (char === ";" || char === "\n") {
                pushSegment();
                continue;
            }

            if (char === "|") {
                pushSegment();
                if (next === "|" || next === "&") i += 1;
                continue;
            }

            if (char === "&") {
                const isRedirection = prev === ">" || prev === "<" || next === ">" || next === "<";
                if (!isRedirection) {
                    pushSegment();
                    if (next === "&") i += 1;
                    continue;
                }
            }
        }

        current += char;
    }

    pushSegment();

    return segments;
}

function tokenizeCommandSegment(segment: string): string[] {
    return tokenizeQuotedWords(segment)
        .map((token) => token.replace(/^[({]+/g, "").replace(/[;)}]+$/g, ""))
        .filter(Boolean);
}

function extractCommandFromTokens(tokens: string[]): { commandNameRaw: string; args: string[] } | null {
    if (tokens.length === 0) return null;

    let idx = 0;
    while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[idx] ?? "")) {
        idx += 1;
    }

    if (idx >= tokens.length) return null;

    return {
        commandNameRaw: tokens[idx] ?? "",
        args: tokens.slice(idx + 1),
    };
}

function analyzeFallbackInvocations(command: string, depth: number = 0): FallbackInvocation[] {
    if (depth > 6) return [];

    const invocations: FallbackInvocation[] = [];
    const segments = splitTopLevelCommandSegments(command);

    for (const segment of segments) {
        const tokens = tokenizeCommandSegment(segment);
        if (tokens.length === 0) continue;

        const extractedCommand = extractCommandFromTokens(tokens);
        if (!extractedCommand) continue;

        const commandNameRaw = extractedCommand.commandNameRaw;
        const args = extractedCommand.args;
        const effective = resolveEffectiveCommand(commandNameRaw, args);

        invocations.push({
            commandNameRaw,
            effectiveCommandNameRaw: effective.effectiveCommandNameRaw,
            effectiveCommandName: effective.effectiveCommandName,
            effectiveArgs: effective.effectiveArgs,
        });

        if (SHELL_EXECUTABLES.has(effective.effectiveCommandName)) {
            const nestedScript = extractShellDashCScript(effective.effectiveArgs);
            if (nestedScript) {
                invocations.push(...analyzeFallbackInvocations(nestedScript, depth + 1));
            }
        }
    }

    return invocations;
}

function isBrewInvocationInstallOrUpgrade(args: string[]): boolean {
    let actionIndex = 0;

    while (actionIndex < args.length) {
        const token = (args[actionIndex] ?? "").trim().toLowerCase();

        if (!token) {
            actionIndex += 1;
            continue;
        }

        if (token === "--") {
            actionIndex += 1;
            break;
        }

        if (!token.startsWith("-")) {
            break;
        }

        if (
            BREW_QUERY_OPTIONS.has(token)
            || token.startsWith("--prefix=")
            || token.startsWith("--cellar=")
            || token.startsWith("--repository=")
            || token.startsWith("--cache=")
            || token.startsWith("--env=")
        ) {
            return false;
        }

        actionIndex += 1;
    }

    const first = (args[actionIndex] ?? "").trim().toLowerCase();
    if (!first) return false;

    const second = (args[actionIndex + 1] ?? "").trim().toLowerCase();

    if (BREW_ACTIONS.has(first)) {
        return true;
    }

    if (first === "cask" && BREW_ACTIONS.has(second)) {
        return true;
    }

    if (first === "bundle") {
        return !second
            || second.startsWith("-")
            || second === "install"
            || second === "upgrade"
            || second === "reinstall";
    }

    return false;
}

function isBrewInstallOrUpgradeHeuristic(command: string): boolean {
    const invocations = analyzeFallbackInvocations(command);

    for (const invocation of invocations) {
        if (invocation.effectiveCommandName === "brew") {
            if (isBrewInvocationInstallOrUpgrade(invocation.effectiveArgs)) {
                return true;
            }
            continue;
        }

        if (invocation.effectiveCommandName === "xargs") {
            if (findBrewCommandInXargs(invocation.effectiveArgs)) {
                return true;
            }
            continue;
        }

        if (invocation.effectiveCommandName === "find") {
            if (findBrewCommandInFindExec(invocation.effectiveArgs)) {
                return true;
            }
        }
    }

    return false;
}

function isBrewInstallOrUpgrade(command: string, precomputed?: BashAnalysis): boolean {
    const analysis = precomputed ?? analyzeBashScript(command);

    if (!analysis.parseError) {
        for (const invocation of analysis.invocations) {
            if (invocation.effectiveCommandName === "brew") {
                if (isBrewInvocationInstallOrUpgrade(invocation.effectiveArgs)) {
                    return true;
                }
                continue;
            }

            if (invocation.effectiveCommandName === "xargs") {
                if (findBrewCommandInXargs(invocation.effectiveArgs)) {
                    return true;
                }
                continue;
            }

            if (invocation.effectiveCommandName === "find") {
                if (findBrewCommandInFindExec(invocation.effectiveArgs)) {
                    return true;
                }
            }
        }

        if (hasHereDocInvocation(analysis) || hasPotentialShellExpansion(command)) {
            return isBrewInstallOrUpgradeHeuristic(command);
        }

        return false;
    }

    return isBrewInstallOrUpgradeHeuristic(command);
}

const XARGS_SHORT_OPTIONS_WITH_VALUE = new Set(["-a", "-d", "-E", "-I", "-J", "-L", "-n", "-P", "-R", "-s", "-S"]);
const XARGS_SHORT_OPTIONS_WITH_OPTIONAL_VALUE = new Set(["-e", "-i", "-l"]);
const XARGS_LONG_OPTIONS_WITH_VALUE = new Set([
    "--arg-file",
    "--delimiter",
    "--max-args",
    "--max-procs",
    "--max-chars",
    "--process-slot-var",
]);
const XARGS_LONG_OPTIONS_WITH_OPTIONAL_VALUE = new Set(["--eof", "--eof-str", "--replace", "--max-lines"]);

function shouldConsumeOptionalXargsValue(option: string, candidate: string): boolean {
    const trimmed = candidate.trim();
    if (!trimmed || trimmed.startsWith("-")) return false;

    const lowerOption = option.toLowerCase();
    if (lowerOption === "-l" || lowerOption === "--max-lines") {
        return /^\d+$/.test(trimmed);
    }

    if (lowerOption === "-i" || lowerOption === "--replace") {
        return /\{|\}|%/.test(trimmed);
    }

    if (lowerOption === "-e" || lowerOption === "--eof" || lowerOption === "--eof-str") {
        const base = commandBaseName(trimmed);
        return !DELETE_EXECUTABLES.has(base) && !SHELL_EXECUTABLES.has(base);
    }

    return false;
}

function findXargsCommand(args: string[]): { commandRaw: string; args: string[] } | null {
    let idx = 0;
    while (idx < args.length) {
        const token = (args[idx] ?? "").trim();
        if (!token) {
            idx += 1;
            continue;
        }

        if (token === "--") {
            idx += 1;
            break;
        }

        if (token.startsWith("--")) {
            const lower = token.toLowerCase();
            const longWithValue = findOptionWithPossibleValue(lower, XARGS_LONG_OPTIONS_WITH_VALUE);
            if (longWithValue) {
                idx += 1;
                if (!lower.includes("=") && idx < args.length) idx += 1;
                continue;
            }

            const longOptional = findOptionWithPossibleValue(lower, XARGS_LONG_OPTIONS_WITH_OPTIONAL_VALUE);
            if (longOptional) {
                if (!lower.includes("=") && idx + 1 < args.length && shouldConsumeOptionalXargsValue(longOptional, args[idx + 1] ?? "")) {
                    idx += 2;
                    continue;
                }
                idx += 1;
                continue;
            }

            idx += 1;
            continue;
        }

        if (token.startsWith("-")) {
            if (XARGS_SHORT_OPTIONS_WITH_VALUE.has(token)) {
                idx += 1;
                if (idx < args.length) idx += 1;
                continue;
            }

            if (XARGS_SHORT_OPTIONS_WITH_OPTIONAL_VALUE.has(token)) {
                if (idx + 1 < args.length && shouldConsumeOptionalXargsValue(token, args[idx + 1] ?? "")) {
                    idx += 2;
                    continue;
                }
                idx += 1;
                continue;
            }

            idx += 1;
            continue;
        }

        return {
            commandRaw: token,
            args: args.slice(idx + 1),
        };
    }

    if (idx >= args.length) {
        return null;
    }

    return {
        commandRaw: args[idx] ?? "",
        args: args.slice(idx + 1),
    };
}

function resolveXargsEffectiveCommand(args: string[]): {
    commandRaw: string;
    effectiveCommandNameRaw: string;
    effectiveCommandName: string;
    effectiveArgs: string[];
} | null {
    const command = findXargsCommand(args);
    if (!command) return null;

    const effective = resolveEffectiveCommand(command.commandRaw, command.args);
    return {
        commandRaw: command.commandRaw,
        effectiveCommandNameRaw: effective.effectiveCommandNameRaw,
        effectiveCommandName: effective.effectiveCommandName,
        effectiveArgs: effective.effectiveArgs,
    };
}

function findDeleteCommandInXargs(args: string[]): string | null {
    const resolved = resolveXargsEffectiveCommand(args);
    if (!resolved) return null;

    return DELETE_EXECUTABLES.has(resolved.effectiveCommandName)
        ? resolved.effectiveCommandNameRaw || resolved.commandRaw
        : null;
}

function findShellCommandInXargs(args: string[]): string | null {
    const resolved = resolveXargsEffectiveCommand(args);
    if (!resolved) return null;

    const raw = resolved.commandRaw.trim();
    if (raw.startsWith("$")) {
        return raw;
    }

    if (resolved.effectiveCommandNameRaw.trim().startsWith("$")) {
        return resolved.effectiveCommandNameRaw;
    }

    return SHELL_EXECUTABLES.has(resolved.effectiveCommandName)
        ? resolved.effectiveCommandNameRaw || resolved.commandRaw
        : null;
}

function findBrewCommandInXargs(args: string[]): string | null {
    const resolved = resolveXargsEffectiveCommand(args);
    if (!resolved) return null;

    if (resolved.effectiveCommandName !== "brew") {
        return null;
    }

    return isBrewInvocationInstallOrUpgrade(resolved.effectiveArgs)
        ? resolved.effectiveCommandNameRaw || resolved.commandRaw
        : null;
}

function findTrashMoveCommandInXargs(args: string[]): string | null {
    if (!MACOS_TRASH_SUPPORTED) return null;

    const resolved = resolveXargsEffectiveCommand(args);
    if (!resolved) return null;

    if (resolved.effectiveCommandName !== "mv") {
        return null;
    }

    return isMvIntoTrash(resolved.effectiveArgs)
        ? resolved.effectiveCommandNameRaw || resolved.commandRaw || "mv"
        : null;
}

function parseFindExecCommand(args: string[]): Array<{ commandRaw: string; args: string[] }> {
    const commands: Array<{ commandRaw: string; args: string[] }> = [];

    for (let idx = 0; idx < args.length; idx++) {
        const token = (args[idx] ?? "").trim();
        if (token !== "-exec" && token !== "-execdir" && token !== "-ok" && token !== "-okdir") continue;

        const execArgs: string[] = [];
        for (let j = idx + 1; j < args.length; j++) {
            const part = (args[j] ?? "").trim();
            if (!part) continue;
            if (part === ";" || part === "\\;" || part === "+") break;
            execArgs.push(part);
        }

        if (execArgs.length === 0) continue;

        commands.push({
            commandRaw: execArgs[0] ?? "",
            args: execArgs.slice(1),
        });
    }

    return commands;
}

function findDeleteCommandInFindExec(args: string[]): string | null {
    for (const token of args) {
        if ((token ?? "").trim() === "-delete") {
            return "find -delete";
        }
    }

    for (const execCommand of parseFindExecCommand(args)) {
        const effective = resolveEffectiveCommand(execCommand.commandRaw, execCommand.args);
        if (DELETE_EXECUTABLES.has(effective.effectiveCommandName)) {
            return effective.effectiveCommandNameRaw || execCommand.commandRaw || "rm";
        }

        if (
            SHELL_EXECUTABLES.has(effective.effectiveCommandName)
            || effective.effectiveCommandName === "eval"
            || isDynamicCommandNameToken(effective.effectiveCommandNameRaw)
            || effective.effectiveCommandNameRaw.trim() === "{}"
            || execCommand.commandRaw.trim() === "{}"
        ) {
            return effective.effectiveCommandNameRaw || execCommand.commandRaw || "find -exec";
        }
    }

    return null;
}

function findBrewCommandInFindExec(args: string[]): string | null {
    for (const execCommand of parseFindExecCommand(args)) {
        const effective = resolveEffectiveCommand(execCommand.commandRaw, execCommand.args);
        if (effective.effectiveCommandName !== "brew") {
            continue;
        }

        if (isBrewInvocationInstallOrUpgrade(effective.effectiveArgs)) {
            return effective.effectiveCommandNameRaw || execCommand.commandRaw || "brew";
        }
    }

    return null;
}

function findTrashMoveCommandInFindExec(args: string[]): string | null {
    if (!MACOS_TRASH_SUPPORTED) return null;

    for (const execCommand of parseFindExecCommand(args)) {
        const effective = resolveEffectiveCommand(execCommand.commandRaw, execCommand.args);
        if (effective.effectiveCommandName !== "mv") {
            continue;
        }

        if (isMvIntoTrash(effective.effectiveArgs)) {
            return effective.effectiveCommandNameRaw || execCommand.commandRaw || "mv";
        }
    }

    return null;
}

function extractLeadingGroupedBody(commandTail: string): string | null {
    const trimmed = commandTail.trimStart();
    if (!trimmed) return null;

    const opener = trimmed[0];
    if (opener !== "(" && opener !== "{") return null;

    const closer = opener === "(" ? ")" : "}";
    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    let escapeNext = false;

    for (let i = 0; i < trimmed.length; i++) {
        const char = trimmed[i] ?? "";

        if (escapeNext) {
            escapeNext = false;
            continue;
        }

        if (char === "\\" && !inSingle) {
            escapeNext = true;
            continue;
        }

        if (!inDouble && char === "'") {
            inSingle = !inSingle;
            continue;
        }

        if (!inSingle && char === '"') {
            inDouble = !inDouble;
            continue;
        }

        if (inSingle || inDouble) continue;

        if (char === opener) {
            depth += 1;
            continue;
        }

        if (char === closer) {
            depth -= 1;
            if (depth === 0) {
                return trimmed.slice(1, i).trim();
            }
        }
    }

    return null;
}

function evalArgsInvokeShell(args: string[], depth: number = 0): boolean {
    if (depth > 4) return false;

    const script = args.join(" ").trim();
    if (!script) return false;

    const invocations = analyzeFallbackInvocations(script, depth + 1);
    for (const invocation of invocations) {
        if (invocation.effectiveCommandNameRaw.trim().startsWith("$")) {
            return true;
        }

        if (SHELL_EXECUTABLES.has(invocation.effectiveCommandName)) {
            return true;
        }

        if (invocation.effectiveCommandName === "eval" && invocation.effectiveArgs.length > 0) {
            if (evalArgsInvokeShell(invocation.effectiveArgs, depth + 1)) {
                return true;
            }
        }
    }

    return false;
}

function hasPipedShellHeuristic(command: string): boolean {
    let inSingle = false;
    let inDouble = false;
    let escapeNext = false;

    for (let i = 0; i < command.length; i++) {
        const char = command[i] ?? "";
        const next = command[i + 1] ?? "";

        if (escapeNext) {
            escapeNext = false;
            continue;
        }

        if (char === "\\" && !inSingle) {
            escapeNext = true;
            continue;
        }

        if (!inDouble && char === "'") {
            inSingle = !inSingle;
            continue;
        }

        if (!inSingle && char === '"') {
            inDouble = !inDouble;
            continue;
        }

        if (inSingle || inDouble) continue;

        if (char !== "|") continue;
        if (next === "|") {
            i += 1;
            continue;
        }

        const tail = command.slice(i + 1);
        const groupedBody = extractLeadingGroupedBody(tail);
        if (groupedBody) {
            const groupedInvocations = analyzeFallbackInvocations(groupedBody);
            if (groupedInvocations.some((invocation) => {
                if (invocation.effectiveCommandNameRaw.trim().startsWith("$")) return true;
                if (SHELL_EXECUTABLES.has(invocation.effectiveCommandName)) return true;
                if (invocation.effectiveCommandName !== "eval") return false;

                return evalArgsInvokeShell(invocation.effectiveArgs);
            })) {
                return true;
            }
            continue;
        }

        const [segment] = splitTopLevelCommandSegments(tail);
        if (!segment) continue;

        const tokens = tokenizeCommandSegment(segment);
        if (tokens.length === 0) continue;

        const parsedCommand = extractCommandFromTokens(tokens);
        if (!parsedCommand) continue;

        if (parsedCommand.commandNameRaw.trim().startsWith("$")) {
            return true;
        }

        const effective = resolveEffectiveCommand(parsedCommand.commandNameRaw, parsedCommand.args);
        if (effective.effectiveCommandNameRaw.trim().startsWith("$")) {
            return true;
        }

        if (
            effective.effectiveCommandName === "eval"
            && evalArgsInvokeShell(effective.effectiveArgs)
        ) {
            return true;
        }

        if (SHELL_EXECUTABLES.has(effective.effectiveCommandName)) {
            return true;
        }
    }

    return false;
}

type DangerousCommand = { kind: "delete" | "piped shell" | "dynamic" | "manual trash move"; commandName?: string };

type InvocationLike = {
    commandNameRaw: string;
    effectiveCommandNameRaw: string;
    effectiveCommandName: string;
    effectiveArgs: string[];
};

function detectDangerFromInvocation(invocation: InvocationLike): DangerousCommand | null {
    if (
        isDynamicCommandNameToken(invocation.commandNameRaw)
        || isDynamicCommandNameToken(invocation.effectiveCommandNameRaw)
    ) {
        return {
            kind: "dynamic",
            commandName: invocation.effectiveCommandNameRaw || invocation.commandNameRaw,
        };
    }

    if (DELETE_EXECUTABLES.has(invocation.effectiveCommandName)) {
        return {
            kind: "delete",
            commandName: invocation.effectiveCommandNameRaw || invocation.commandNameRaw,
        };
    }

    if (
        MACOS_TRASH_SUPPORTED
        && invocation.effectiveCommandName === "mv"
        && isMvIntoTrash(invocation.effectiveArgs)
    ) {
        return {
            kind: "manual trash move",
            commandName: invocation.effectiveCommandNameRaw || invocation.commandNameRaw,
        };
    }

    if (invocation.effectiveCommandName === "xargs") {
        const xargsTrashMove = findTrashMoveCommandInXargs(invocation.effectiveArgs);
        if (xargsTrashMove) {
            return {
                kind: "manual trash move",
                commandName: xargsTrashMove,
            };
        }

        const xargsDelete = findDeleteCommandInXargs(invocation.effectiveArgs);
        if (xargsDelete) {
            return {
                kind: "delete",
                commandName: xargsDelete,
            };
        }

        const xargsShell = findShellCommandInXargs(invocation.effectiveArgs);
        if (xargsShell) {
            return {
                kind: "piped shell",
                commandName: xargsShell,
            };
        }
    }

    if (invocation.effectiveCommandName === "find") {
        const findTrashMove = findTrashMoveCommandInFindExec(invocation.effectiveArgs);
        if (findTrashMove) {
            return {
                kind: "manual trash move",
                commandName: findTrashMove,
            };
        }

        const findDelete = findDeleteCommandInFindExec(invocation.effectiveArgs);
        if (findDelete) {
            return {
                kind: "delete",
                commandName: findDelete,
            };
        }
    }

    if (invocation.effectiveCommandName === "eval" && invocation.effectiveArgs.length > 0) {
        return {
            kind: "dynamic",
            commandName: invocation.effectiveCommandNameRaw || invocation.commandNameRaw,
        };
    }

    return null;
}

function detectDangerousCommandHeuristic(command: string): DangerousCommand | null {
    const invocations = analyzeFallbackInvocations(command);

    for (const invocation of invocations) {
        const danger = detectDangerFromInvocation(invocation);
        if (danger) {
            return danger;
        }
    }

    if (DELETE_BRACE_EXPANSION_REGEX.test(command)) {
        return { kind: "delete", commandName: "rm (brace expansion)" };
    }

    if (hasPotentialShellExpansion(command) && containsObfuscatedDeleteCommand(command)) {
        return { kind: "delete", commandName: "rm/rmdir/unlink (expanded)" };
    }

    if (hasPipedShellHeuristic(command)) {
        return { kind: "piped shell" };
    }

    return null;
}

function detectDangerousCommand(command: string, precomputed?: BashAnalysis): DangerousCommand | null {
    const analysis = precomputed ?? analyzeBashScript(command);

    if (!analysis.parseError) {
        for (const invocation of analysis.invocations) {
            const danger = detectDangerFromInvocation(invocation);
            if (danger) {
                return danger;
            }
        }

        const pipedShellMatch = analysis.invocations.find(
            (invocation) =>
                invocation.pipelineLength > 1
                && invocation.pipelineIndex > 0
                && SHELL_EXECUTABLES.has(invocation.effectiveCommandName),
        );
        if (pipedShellMatch) {
            return {
                kind: "piped shell",
                commandName: pipedShellMatch.effectiveCommandNameRaw || pipedShellMatch.commandNameRaw,
            };
        }

        if (hasHereDocInvocation(analysis) || hasPotentialShellExpansion(command)) {
            return detectDangerousCommandHeuristic(command);
        }

        if (hasPipedShellHeuristic(command)) {
            return { kind: "piped shell" };
        }

        return null;
    }

    return detectDangerousCommandHeuristic(command);
}

type TrashMoveResult = {
    source: string;
    destination: string;
    method: "finder";
};

function isPathWithin(pathToCheck: string, parentPath: string): boolean {
    if (!parentPath) return false;
    return pathToCheck === parentPath || pathToCheck.startsWith(`${parentPath}${sep}`);
}

async function resolvePathThroughRealAncestor(pathToResolve: string): Promise<string | null> {
    let cursor = pathToResolve;

    while (true) {
        try {
            const realCursor = await fs.realpath(cursor);
            const tail = relative(cursor, pathToResolve);
            return tail ? resolve(realCursor, tail) : realCursor;
        } catch (error: any) {
            const code = error?.code;
            if (code !== "ENOENT" && code !== "ENOTDIR") {
                throw error;
            }
        }

        const parent = dirname(cursor);
        if (parent === cursor) {
            return null;
        }
        cursor = parent;
    }
}

function validateTrashTarget(pathToTrash: string, cwd: string): { ok: true; absolutePath: string } | { ok: false; reason: string } {
    const rawPath = pathToTrash.trim();
    if (!rawPath) {
        return { ok: false, reason: "Path cannot be empty." };
    }

    if (rawPath === "." || rawPath === "..") {
        return { ok: false, reason: "Refusing to trash . or .." };
    }

    const absolutePath = resolve(cwd, rawPath);
    const cwdPath = resolve(cwd);
    const rootPath = resolve(sep);

    if (absolutePath === rootPath) {
        return { ok: false, reason: "Refusing to trash filesystem root /." };
    }

    if (HOME_DIR && absolutePath === HOME_DIR) {
        return { ok: false, reason: "Refusing to trash your home directory." };
    }

    if (absolutePath === cwdPath) {
        return { ok: false, reason: "Refusing to trash current workspace root." };
    }

    if (!isPathWithin(absolutePath, cwdPath)) {
        return {
            ok: false,
            reason: "Refusing to trash paths outside current workspace.",
        };
    }

    if (MACOS_TRASH_DIR && isPathWithin(absolutePath, MACOS_TRASH_DIR)) {
        return { ok: false, reason: "Path is already inside Trash." };
    }

    return { ok: true, absolutePath };
}

async function moveToFinderTrash(
    absolutePath: string,
    signal?: AbortSignal,
    timeoutMs: number = TRASH_EXEC_TIMEOUT_MS,
): Promise<void> {
    const script = [
        "on run argv",
        "tell application \"Finder\" to delete (item 1 of argv as POSIX file)",
        "end run",
    ];

    const args = script.flatMap((line) => ["-e", line]).concat(absolutePath);

    await new Promise<void>((resolvePromise, rejectPromise) => {
        execFile(
            "osascript",
            args,
            { signal, timeout: timeoutMs },
            (error, _stdout, stderr) => {
                if (error) {
                    const message = stderr?.trim() || error.message || "osascript failed";
                    rejectPromise(new Error(message));
                    return;
                }
                resolvePromise();
            },
        );
    });
}

function isAbortLikeError(error: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) return true;

    const maybeError = error as { name?: string; message?: string } | null | undefined;
    const name = maybeError?.name || "";
    const message = maybeError?.message || "";

    return name === "AbortError" || /aborted/i.test(message);
}

async function movePathToTrash(
    pathToTrash: string,
    cwd: string,
    signal?: AbortSignal,
): Promise<TrashMoveResult> {
    if (!MACOS_TRASH_SUPPORTED) {
        throw new Error("move_to_trash is supported on macOS only.");
    }

    const validated = validateTrashTarget(pathToTrash, cwd);
    if (!validated.ok) {
        throw new Error(validated.reason);
    }

    const absolutePath = validated.absolutePath;
    const pathStats = await fs.lstat(absolutePath);

    const cwdPath = resolve(cwd);
    const realCwdPath = await fs.realpath(cwdPath).catch(() => cwdPath);

    const isSymlink = pathStats.isSymbolicLink();
    let realAbsolutePath = absolutePath;

    if (!isSymlink) {
        realAbsolutePath = await fs.realpath(absolutePath);

        if (!isPathWithin(realAbsolutePath, realCwdPath)) {
            throw new Error("Refusing to trash target outside current workspace.");
        }

        if (realAbsolutePath === realCwdPath) {
            throw new Error("Refusing to trash current workspace root.");
        }
    }

    if (isProtectedDirectory(absolutePath) || (!isSymlink && isProtectedDirectory(realAbsolutePath))) {
        throw new Error(getProtectionReason(realAbsolutePath));
    }

    try {
        await moveToFinderTrash(absolutePath, signal, TRASH_EXEC_TIMEOUT_MS);
        return {
            source: absolutePath,
            destination: "macOS Trash (Finder-managed)",
            method: "finder",
        };
    } catch (error: any) {
        if (isAbortLikeError(error, signal)) {
            throw error;
        }

        const finderError = error?.message ?? String(error);
        throw new Error(`Finder trash failed: ${finderError}`);
    }
}

function truncateCommandForPrompt(command: string, maxChars: number = 80): string {
    return command.length > maxChars
        ? `${command.substring(0, maxChars)}...`
        : command;
}

// ============================================================================
// Extension
// ============================================================================

export default function (pi: ExtensionAPI) {
    let disabled = false;

    pi.registerCommand("no-protect", {
        description: "Toggle protect-paths guards off/on for this session",
        handler: async (_args, ctx) => {
            disabled = !disabled;
            ctx.ui.notify(
                disabled ? "protect-paths: disabled for this session" : "protect-paths: re-enabled",
                disabled ? "warning" : "info",
            );
        },
    });

    if (MACOS_TRASH_SUPPORTED) {
        pi.registerTool({
            name: "move_to_trash",
            label: "Move To Trash",
            description:
                "Move files/directories to macOS Trash instead of deleting them. "
                + "Accepts relative or absolute paths within the current workspace.",
            parameters: MoveToTrashParams,
            async execute(_toolCallId, params, signal, _onUpdate, ctx) {
                const moved: Array<{
                    requestedPath: string;
                    source: string;
                    destination: string;
                    method: "finder";
                }> = [];
                const errors: string[] = [];

                for (const pathToTrash of params.paths) {
                    try {
                        const result = await movePathToTrash(
                            pathToTrash,
                            ctx.cwd,
                            signal,
                        );
                        moved.push({
                            requestedPath: pathToTrash,
                            source: result.source,
                            destination: result.destination,
                            method: result.method,
                        });
                    } catch (error: any) {
                        const message = error?.message ?? String(error);
                        errors.push(`${pathToTrash}: ${message}`);
                    }
                }

                const lines = [
                    ...moved.map((item) =>
                        `Moved to Trash (${item.method}): ${item.requestedPath} -> ${item.destination}`),
                    ...errors.map((line) => `Error: ${line}`),
                ];

                if (moved.length === 0 && errors.length > 0) {
                    throw new Error(lines.join("\n"));
                }

                return {
                    content: [{ type: "text", text: lines.join("\n") }],
                    details: { moved, errors },
                };
            },
        });
    }

    pi.on("before_agent_start", (event) => {
        if (disabled || !MACOS_TRASH_SUPPORTED) return;

        const guardInstruction =
            "Never use rm/rmdir/unlink or mv into ~/.Trash in bash. "
            + "When asked to delete files, use the move_to_trash tool instead.";

        return {
            systemPrompt: `${event.systemPrompt}\n\n${guardInstruction}`,
        };
    });

    // --- Directory protection for file-oriented tools ---
    pi.on("tool_call", async (event, ctx) => {
        if (disabled) return;
        const isReadTool = READ_TOOLS.includes(event.toolName);
        const isWriteTool = WRITE_TOOLS.includes(event.toolName);
        if (!isReadTool && !isWriteTool) return;

        const pathCandidates = extractPathCandidates(event.toolName, event.input);
        if (pathCandidates.length === 0) return;

        for (const candidate of pathCandidates) {
            if (containsObfuscatedGitReference(candidate)) {
                return {
                    block: true,
                    reason: `Path pattern references protected .git content: ${candidate}`,
                };
            }

            const resolvedPath = resolve(ctx.cwd, candidate);

            if (isProtectedDirectory(resolvedPath)) {
                ctx.ui.notify(`Blocked access to protected path: ${candidate}`, "warning");
                return {
                    block: true,
                    reason: getProtectionReason(candidate),
                };
            }

            try {
                const realPath = await resolvePathThroughRealAncestor(resolvedPath);
                if (realPath && isProtectedDirectory(realPath)) {
                    ctx.ui.notify(`Blocked access to protected path via symlink: ${candidate}`, "warning");
                    return {
                        block: true,
                        reason: `Path resolves to protected location ${realPath}. ${getProtectionReason(realPath)}`,
                    };
                }
            } catch (error: any) {
                return {
                    block: true,
                    reason: `Unable to safely resolve path ${candidate}: ${error?.message ?? String(error)}`,
                };
            }
        }

        return;
    });

    // --- Bash command guardrails ---
    // Complements upstream @aliou/pi-guardrails.
    pi.on("tool_call", async (event, ctx) => {
        if (disabled) return;
        if (event.toolName !== "bash") return;

        await ensureJustBashLoaded();
        maybeWarnAstUnavailable(ctx);

        const command = String(event.input.command ?? "");
        const analysis = analyzeBashScript(command);

        const refs = extractProtectedDirRefsFromCommand(command, analysis);
        for (const ref of refs) {
            if (isProtectedDirectory(ref)) {
                ctx.ui.notify(`Blocked access to protected path: ${ref}`, "warning");
                return {
                    block: true,
                    reason: `Command references protected path ${ref}. ${getProtectionReason(ref)}`,
                };
            }
        }

        if (isBrewInstallOrUpgrade(command, analysis)) {
            ctx.ui.notify("Blocked brew command. Use the project's package manager instead.", "warning");
            return {
                block: true,
                reason: "Homebrew install/upgrade commands are blocked. Please use the project's package manager (npm, pnpm, bun, nix, etc.) instead.",
            };
        }

        const danger = detectDangerousCommand(command, analysis);
        if (!danger) return;

        if (danger.kind === "manual trash move") {
            if (MACOS_TRASH_SUPPORTED) {
                ctx.ui.notify("Blocked manual Trash move. Use move_to_trash tool instead.", "warning");
                return {
                    block: true,
                    reason: TRASH_MOVE_BLOCK_REASON,
                };
            }
            return;
        }

        if (danger.kind === "dynamic") {
            if (MACOS_TRASH_SUPPORTED) {
                return {
                    block: true,
                    reason: "Dynamic command expansions are blocked on macOS to prevent delete-command bypasses.",
                };
            }

            if (!ctx.hasUI) {
                return {
                    block: true,
                    reason: "Dynamic command expansion blocked in non-interactive mode.",
                };
            }

            const truncatedDynamic = truncateCommandForPrompt(command);
            const proceedDynamic = await ctx.ui.confirm(
                "Dynamic Command Expansion Detected",
                "This command uses runtime-expanded command names. "
                + "Proceed?\n\n"
                + `${truncatedDynamic}`,
            );

            if (!proceedDynamic) {
                return { block: true, reason: "User denied dynamic command expansion" };
            }

            return;
        }

        if (danger.kind === "delete") {
            if (MACOS_TRASH_SUPPORTED) {
                ctx.ui.notify("Blocked delete command. Use move_to_trash tool instead.", "warning");
                return {
                    block: true,
                    reason: "Direct delete commands are blocked. Use the move_to_trash tool.",
                };
            }

            if (!ctx.hasUI) {
                return {
                    block: true,
                    reason: "Delete command blocked: move_to_trash unavailable in non-interactive mode.",
                };
            }

            const truncatedDelete = truncateCommandForPrompt(command);
            const proceedDelete = await ctx.ui.confirm(
                "Delete Command Detected",
                "move_to_trash is unavailable on this platform. "
                + "Proceed with direct delete command?\n\n"
                + `${truncatedDelete}`,
            );

            if (!proceedDelete) {
                return { block: true, reason: "User denied delete command" };
            }

            return;
        }

        if (!ctx.hasUI) {
            return {
                block: true,
                reason: "Dangerous piped-shell command blocked in non-interactive mode.",
            };
        }

        const truncatedCmd = truncateCommandForPrompt(command);
        const proceed = await ctx.ui.confirm(
            "Dangerous Command Detected",
            `This command contains ${danger.kind}${danger.commandName ? ` (${danger.commandName})` : ""}:\n\n${truncatedCmd}\n\nAllow execution?`,
        );

        if (!proceed) {
            return { block: true, reason: "User denied dangerous command" };
        }

        return;
    });
}
