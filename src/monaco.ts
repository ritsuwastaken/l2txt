import { validate, type Client, type Diagnostic } from "./index.ts";

export interface MarkerData {
  severity: 1 | 2 | 4 | 8;
  message: string;
  code: string;
  source: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  tags?: 1[];
}

interface Monaco<Model> {
  editor: { setModelMarkers(model: Model, owner: string, markers: MarkerData[]): void };
}

interface Model {
  getValue(): string;
  uri: { path: string };
}

const SEVERITY = { 1: 8, 2: 4, 3: 2, 4: 1 } as const;

export const toMarkers = (diagnostics: Diagnostic[]): MarkerData[] =>
  diagnostics.map(({ range, severity, code, source, message, tags }) => ({
    severity: SEVERITY[severity],
    message,
    code,
    source,
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
    ...(tags && { tags: [1 as const] }),
  }));

export function validateModel<M extends Model>(
  monaco: Monaco<M>,
  model: M,
  options: { fileName?: string; client?: Client } = {},
): Client | null {
  const result = validate(model.getValue(), options.fileName ?? model.uri.path, options);
  monaco.editor.setModelMarkers(model, "l2txt", result ? toMarkers(result.diagnostics) : []);
  return result?.client ?? null;
}
