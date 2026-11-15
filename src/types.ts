export type FieldType = "d" | "f" | "s" | "m";

export interface Table {
  readonly begin: string;
  readonly end: string;
  readonly fields: Readonly<Record<string, FieldType>>;
}

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export const DiagnosticSeverity = { Error: 1, Warning: 2, Information: 3, Hint: 4 } as const;
export type DiagnosticSeverity = (typeof DiagnosticSeverity)[keyof typeof DiagnosticSeverity];

export const DiagnosticTag = { Unnecessary: 1 } as const;
export type DiagnosticTag = (typeof DiagnosticTag)[keyof typeof DiagnosticTag];

export type DiagnosticCode =
  | "unclosed-bracket"
  | "broken-list"
  | "missing-field"
  | "repeated-field"
  | "field-count"
  | "extra-record"
  | "unclosed-record"
  | "skipped-rest"
  | "unknown-field"
  | "no-value"
  | "empty-braces"
  | "outside-record"
  | "not-a-number"
  | "missing-end"
  | "space-separator"
  | "not-an-integer";

export interface Diagnostic {
  range: Range;
  severity: DiagnosticSeverity;
  code: DiagnosticCode;
  source: "l2txt";
  message: string;
  tags?: DiagnosticTag[];
  data?: { field: string };
}
