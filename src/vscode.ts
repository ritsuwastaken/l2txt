import type * as VSCode from "vscode";
import { validate, type Client, type Diagnostic } from "./index.ts";

export const toDiagnostics = (vscode: typeof VSCode, diagnostics: Diagnostic[]): VSCode.Diagnostic[] =>
  diagnostics.map(({ range, severity, code, source, message, tags }) => {
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character),
      message,
      severity - 1,
    );
    diagnostic.code = code;
    diagnostic.source = source;
    if (tags)
      diagnostic.tags = [vscode.DiagnosticTag.Unnecessary];
    return diagnostic;
  });

export function watch(vscode: typeof VSCode, options: { client?: Client; delay?: number } = {}): VSCode.Disposable {
  const collection = vscode.languages.createDiagnosticCollection("l2txt");
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const update = (document: VSCode.TextDocument) => {
    const result = validate(document.getText(), document.fileName, options);
    if (result)
      collection.set(document.uri, toDiagnostics(vscode, result.diagnostics));
  };
  const later = (document: VSCode.TextDocument) => {
    const key = document.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => update(document), options.delay ?? 300));
  };
  vscode.workspace.textDocuments.forEach(update);
  return vscode.Disposable.from(
    collection,
    vscode.workspace.onDidOpenTextDocument(update),
    vscode.workspace.onDidChangeTextDocument(({ document }) => later(document)),
    vscode.workspace.onDidCloseTextDocument(({ uri }) => collection.delete(uri)),
    { dispose: () => timers.forEach(clearTimeout) },
  );
}
