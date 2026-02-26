/**
 * Integration tests for ModalEditor key sequences.
 * Full tests require the harness seam from Task 3 (ModalEditor export).
 */

import { describe, it } from "node:test";

describe("ModalEditor integration", () => {
  it.todo("insert → normal: Escape returns to NORMAL mode");
  it.todo("normal → insert: i enters INSERT mode");
  it.todo("dw deletes forward word and stores in register");
  it.todo("x deletes character under cursor");
  it.todo("u undoes last edit");
  it.todo("cursor stays within bounds when at line start");
});
