import assert from "node:assert/strict";
import { test } from "node:test";
import type * as VSCode from "vscode";
import { check, tables } from "../src/index.ts";
import { toMarkers, validateModel, type MarkerData } from "../src/monaco.ts";
import { toDiagnostics, watch } from "../src/vscode.ts";

const text = "skill_begin\tskill_id=1\tskill_level=1\tname=[A]\tdesc=[B]\tfoo=2\tskill_end";

test("monaco markers are one-based with Monaco severities", () => {
  assert.deepEqual(toMarkers(check(text, tables.C1.skillname))[0], {
    severity: 4,
    message: "Unknown field foo: skipped with its value",
    code: "unknown-field",
    source: "l2txt",
    startLineNumber: 1,
    startColumn: text.indexOf("foo") + 1,
    endLineNumber: 1,
    endColumn: text.indexOf("foo") + 4,
    tags: [1],
  } satisfies MarkerData);
});

test("validateModel sets the model's markers", () => {
  const set: [string, MarkerData[]][] = [];
  const model = { getValue: () => text, uri: { path: "/system/Skillname-e.txt" } };
  const monaco = { editor: { setModelMarkers: (_: unknown, owner: string, markers: MarkerData[]) => set.push([owner, markers]) } };
  assert.equal(validateModel(monaco, model), "C1");
  assert.equal(set[0][0], "l2txt");
  assert.equal(set[0][1].length, 2);
  assert.equal(validateModel(monaco, { ...model, uri: { path: "/notes.txt" } }), null);
  assert.deepEqual(set[1][1], []);
});

test("vscode diagnostics use the vscode classes", () => {
  class Range {
    position: number[];
    constructor(...position: number[]) {
      this.position = position;
    }
  }
  class Diagnostic {
    range: Range;
    message: string;
    severity: number;
    code?: string;
    source?: string;
    tags?: number[];
    constructor(range: Range, message: string, severity: number) {
      this.range = range;
      this.message = message;
      this.severity = severity;
    }
  }
  const vscode = { Range, Diagnostic, DiagnosticTag: { Unnecessary: 1 } } as unknown as typeof VSCode;
  const [diagnostic] = toDiagnostics(vscode, check(text, tables.C1.skillname)) as unknown as Diagnostic[];
  assert.deepEqual({ ...diagnostic }, {
    range: new Range(0, text.indexOf("foo"), 0, text.indexOf("foo") + 3),
    message: "Unknown field foo: skipped with its value",
    severity: 1,
    code: "unknown-field",
    source: "l2txt",
    tags: [1],
  });
});

test("watch keeps diagnostics of open script files", async () => {
  const collection = new Map<string, unknown[]>();
  const listeners: Record<string, (event: unknown) => void> = {};
  const on = (name: string) => (listener: (event: unknown) => void) => {
    listeners[name] = listener;
    return { dispose() {} };
  };
  const document = (path: string, content: string, scheme = "file") => ({
    uri: { scheme, path, toString: () => `${scheme}://${path}` },
    fileName: path,
    getText: () => content,
  });
  const vscode = {
    Range: class {},
    Diagnostic: class {},
    DiagnosticTag: { Unnecessary: 1 },
    Disposable: { from: (...items: { dispose(): void }[]) => ({ dispose: () => items.forEach(item => item.dispose()) }) },
    languages: {
      createDiagnosticCollection: () => ({
        set: (uri: { toString(): string }, items: unknown[]) => collection.set(uri.toString(), items),
        delete: (uri: { toString(): string }) => collection.delete(uri.toString()),
        dispose() {},
      }),
    },
    workspace: {
      textDocuments: [document("/system/Skillname-e.txt", text), document("/system/Skillname-e.txt", text, "git")],
      onDidOpenTextDocument: on("open"),
      onDidChangeTextDocument: on("change"),
      onDidCloseTextDocument: on("close"),
    },
  } as unknown as typeof VSCode;
  const disposable = watch(vscode, { delay: 5 });
  assert.deepEqual([...collection.keys()], ["file:///system/Skillname-e.txt"]);

  const edited = document("/system/Skillname-e.txt", "skill_begin\tskill_end");
  listeners.change({ document: edited });
  listeners.close(edited);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(collection.size, 0);

  listeners.open(document("/notes.txt", text));
  assert.equal(collection.size, 0);
  disposable.dispose();
});
