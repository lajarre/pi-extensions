/**
 * Test harness for ModalEditor integration tests.
 *
 * NOTE: ModalEditor is not yet exported from index.ts.
 * This file contains stub scaffolding expanded in Task 3 when
 * ModalEditor gains an export + setText/getText/getCursor seam.
 *
 * Planned API (Task 3+):
 *
 *   const { editor, getRegister } = createEditorWithSpy("hello world");
 *   sendKeys(editor, ["\x1b", "d", "w"]);
 *   assert.equal(getRegister(), "hello ");
 */

// Minimal pi-tui stub types — avoids importing the full extension runtime.
export const stubTui = {
  requestRender() {},
  terminal: { rows: 40, cols: 120 },
} as unknown as import("@mariozechner/pi-tui").Tui;

export const stubTheme = {
  borderColor: (s: string) => s,
  fg: (_k: string, s: string) => s,
  bold: (s: string) => s,
} as unknown as import("@mariozechner/pi-tui").Theme;

export const stubKeybindings = {
  matches: () => false,
} as unknown as import("@mariozechner/pi-tui").Keybindings;

/**
 * Placeholder — replaced in Task 3 once ModalEditor is exported.
 */
export function createEditor(_initialText = ""): never {
  throw new Error("createEditor: ModalEditor not yet exported — implement in Task 3");
}
