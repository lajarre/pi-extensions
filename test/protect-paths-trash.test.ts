import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { before, describe, it } from "node:test";

function ensureModuleStub(specifier: string, source: string): void {
    const modulePath = path.join(process.cwd(), "node_modules", ...specifier.split("/"));
    fs.mkdirSync(modulePath, { recursive: true });
    fs.writeFileSync(
        path.join(modulePath, "package.json"),
        JSON.stringify(
            {
                name: specifier,
                version: "0.0.0-test",
                main: "index.js",
            },
            null,
            2,
        ),
    );
    fs.writeFileSync(path.join(modulePath, "index.js"), source);
}

ensureModuleStub(
    "@sinclair/typebox",
    [
        "exports.Type = {",
        "  Object: (properties) => ({ type: 'object', properties }),",
        "  Optional: (schema) => ({ ...schema, optional: true }),",
        "  String: () => ({ type: 'string' }),",
        "  Array: (items, options = {}) => ({ type: 'array', items, ...options }),",
        "};",
    ].join("\n"),
);

let protectPathsExtension: any;

before(async () => {
    ({ default: protectPathsExtension } = await import("../protect-paths.ts"));
});

function createHarness(cwd?: string) {
    const toolCallHandlers: Array<(event: any, ctx: any) => Promise<any>> = [];
    const tools = new Map<string, any>();

    const ctx = {
        cwd: cwd ?? process.cwd(),
        hasUI: true,
        ui: {
            notify() {
                // no-op
            },
            async confirm() {
                return false;
            },
        },
    };

    const api = {
        registerCommand() {
            // no-op
        },
        registerTool(definition: any) {
            tools.set(definition.name, definition);
        },
        on(eventName: string, handler: any) {
            if (eventName === "tool_call") {
                toolCallHandlers.push(handler);
            }
        },
    };

    protectPathsExtension(api);

    return {
        ctx,
        getTool(name: string): any {
            return tools.get(name);
        },
        async runToolCall(event: any): Promise<any> {
            for (const handler of toolCallHandlers) {
                const result = await handler(event, ctx);
                if (result?.block) {
                    return result;
                }
            }
            return null;
        },
    };
}

async function withEnv(
    env: Record<string, string | undefined>,
    run: () => Promise<void>,
): Promise<void> {
    const before = new Map<string, string | undefined>();

    for (const [key, value] of Object.entries(env)) {
        before.set(key, process.env[key]);
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }

    try {
        await run();
    } finally {
        for (const [key, value] of before.entries()) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
}

const isDarwin = process.platform === "darwin";

describe("protect-paths manual Trash move guard", () => {
    it("blocks direct mv into ~/.Trash", { skip: !isDarwin }, async () => {
        const harness = createHarness();
        const result = await harness.runToolCall({
            toolName: "bash",
            input: { command: "mv file ~/.Trash" },
        });

        assert.equal(result?.block, true);
        assert.equal(result?.reason, "Manual Trash moves are blocked. Use move_to_trash.");
    });

    it("blocks HOME-based Trash destination forms", { skip: !isDarwin }, async () => {
        const harness = createHarness();

        const commands = [
            "mv file $HOME/.Trash",
            "mv file ${HOME}/.Trash",
        ];

        if (process.env.HOME) {
            commands.push(`mv file ${process.env.HOME}/.Trash`);
        }

        for (const command of commands) {
            const result = await harness.runToolCall({ toolName: "bash", input: { command } });
            assert.equal(result?.block, true, `Expected block for command: ${command}`);
            assert.equal(result?.reason, "Manual Trash moves are blocked. Use move_to_trash.");
        }
    });

    it("blocks wrapped/env and xargs/find -exec Trash moves", { skip: !isDarwin }, async () => {
        const harness = createHarness();
        const commands = [
            "env mv file ~/.Trash",
            "printf '%s\\n' file | xargs -I{} mv {} ~/.Trash",
            "find . -name file -exec mv {} ~/.Trash \\;",
        ];

        for (const command of commands) {
            const result = await harness.runToolCall({ toolName: "bash", input: { command } });
            assert.equal(result?.block, true, `Expected block for command: ${command}`);
            assert.equal(result?.reason, "Manual Trash moves are blocked. Use move_to_trash.");
        }
    });

    it("does not block non-trash mv", { skip: !isDarwin }, async () => {
        const harness = createHarness();
        const result = await harness.runToolCall({
            toolName: "bash",
            input: { command: "mv file ./backup" },
        });

        assert.equal(result, null);
    });

    it("move_to_trash successfully moves a file to Trash", { skip: !isDarwin }, async () => {
        const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "protect-paths-trash-"));
        const harness = createHarness(tempDir);
        const tool = harness.getTool("move_to_trash");
        assert.ok(tool, "move_to_trash should be registered on macOS");

        const filename = "trash-success-test.txt";
        const absolutePath = path.join(tempDir, filename);
        await fsp.writeFile(absolutePath, "will be trashed");

        const result = await tool.execute(
            "tool-call-id",
            { paths: [filename] },
            undefined,
            () => {
                // no-op
            },
            harness.ctx,
        );

        assert.ok(result, "execute should return a result");
        assert.ok(result.content?.length > 0, "result should have content");
        assert.match(result.content[0].text, /Moved to Trash/, "result text should confirm move");

        // File must no longer exist at original path
        await assert.rejects(
            fsp.access(absolutePath),
            "file should no longer exist at original path after trash",
        );
    });

    it("move_to_trash fails closed when Finder call fails", { skip: !isDarwin }, async () => {
        const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "protect-paths-trash-"));
        const harness = createHarness(tempDir);
        const tool = harness.getTool("move_to_trash");
        assert.ok(tool, "move_to_trash should be registered on macOS");

        const filename = "finder-fail-closed.txt";
        const absolutePath = path.join(tempDir, filename);
        await fsp.writeFile(absolutePath, "test");

        await withEnv({ PATH: "/definitely-not-found" }, async () => {
            await assert.rejects(
                tool.execute(
                    "tool-call-id",
                    { paths: [filename] },
                    undefined,
                    () => {
                        // no-op
                    },
                    harness.ctx,
                ),
                /Finder trash failed:/,
            );
        });

        await fsp.access(absolutePath);
    });
});
