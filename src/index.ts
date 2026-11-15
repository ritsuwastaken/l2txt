import { tables, type Client } from "./tables.ts";
import {
  DiagnosticSeverity,
  DiagnosticTag,
  type Diagnostic,
  type DiagnosticCode,
  type FieldType,
  type Position,
  type Table,
} from "./types.ts";

export { tables, type Client } from "./tables.ts";
export * from "./types.ts";

type ValueType = Exclude<FieldType, "n">;

interface Token {
  text: string;
  start: number;
  end: number;
  quoted: boolean;
  skipped: boolean;
}

interface Problem {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  message: string;
  start: number;
  end: number;
  skipped?: boolean;
  field?: string;
}

const { Error, Warning, Information, Hint } = DiagnosticSeverity;
const DELIMITERS = " 　\n\t\r=$;";
const INTEGER = /^[+-]?\d+$/;
const FLOAT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const MAX_DIAGNOSTICS = 2000;

const clients = Object.keys(tables) as Client[];

const usable = (table: Table) => Object.values(table.fields).some(type => type !== "n");

export function tablesFor(fileName: string): [Client, Table][] {
  const base = fileName.replace(/^.*[/\\]/, "").toLowerCase().replace(/\.txt$/, "");
  return clients.flatMap((client): [Client, Table][] => {
    const byName: Record<string, Table> = tables[client];
    const table = byName[base] ?? byName[base.replace(/-[a-z]+$/, "")];
    return table && usable(table) ? [[client, table]] : [];
  });
}

function* tokenize(text: string, problems: Problem[], from = 0, to = text.length): Generator<Token> {
  let i = from;
  while (i < to) {
    let token = "";
    let start = -1;
    let open = "";
    let opened = 0;
    let quoted = false;
    for (; i < to; i++) {
      const ch = text[i];
      if (open) {
        if (ch === (open === "{" ? "}" : "]")) {
          open = "";
          i++;
          break;
        }
        token += ch;
      } else if (ch === "{" || ch === "[") {
        if (start < 0)
          start = i;
        open = ch;
        opened = i;
        quoted = true;
      } else if (DELIMITERS.includes(ch)) {
        if (start >= 0)
          break;
      } else {
        if (start < 0)
          start = i;
        token += ch;
      }
    }
    if (open) {
      problems.push({
        code: "unclosed-bracket",
        severity: Error,
        message: `Unclosed '${open}': the rest of the file is read as one value`,
        start: opened,
        end: opened + 1,
      });
      problems.push({ code: "skipped-rest", severity: Hint, message: "Read as one value", start: opened, end: to, skipped: true });
      return;
    }
    if (start >= 0)
      yield { text: token, start, end: i, quoted, skipped: !token && text[start] === "{" };
  }
}

function checkValue(field: string, type: ValueType, value: Token, text: string, problems: Problem[]) {
  const at = { start: value.start, end: value.end, field };
  if (type === "d" && !INTEGER.test(value.text))
    problems.push({
      ...at,
      code: FLOAT.test(value.text) ? "not-an-integer" : "not-a-number",
      severity: FLOAT.test(value.text) ? Hint : Warning,
      message: `${field} is an integer field; read as ${parseInt(value.text) || 0}`,
    });
  else if (type === "f" && !FLOAT.test(value.text))
    problems.push({ ...at, code: "not-a-number", severity: Warning, message: `${field} must be a number; read as ${parseFloat(value.text) || 0}` });
  else if (type === "m" && text[value.start] === "{") {
    const inner: Problem[] = [];
    for (const _ of tokenize(text, inner, value.start + 1, value.end - 1));
    if (inner.length || value.text.includes("{"))
      problems.push({ ...at, code: "broken-list", severity: Error, message: `${field}: broken list (nested '{' or unclosed '[')` });
  }
}

const visible = (name: string) =>
  name.replace(/[^\x21-\x7e]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);

function separatedBySpace(text: string, token: Token) {
  let i = token.start - 1;
  let space = false;
  for (; i >= 0; i--) {
    const ch = text[i];
    if (ch === "\t" || ch === "\n")
      return false;
    if (ch !== " " && ch !== "　")
      break;
    space = true;
  }
  return space && i >= 0 && text[i] !== "=";
}

function problemsOf(text: string, table: Table): Problem[] {
  const problems: Problem[] = [];
  const fields = new Map(Object.entries(table.fields).map(([name, type]) => [name.toLowerCase(), { name, type }]));
  const values = [...fields.values()].filter((field): field is { name: string; type: ValueType } => field.type !== "n");
  const begin = table.begin.toLowerCase();
  const end = table.end.toLowerCase();
  const tabbed = text.includes("\t");
  const report = (token: Token, problem: Omit<Problem, "start" | "end">) =>
    problems.push({ ...problem, start: token.start, end: token.end });

  const counts = new Map(values.map(({ name }) => [name, 0]));
  let records = 0;
  let lastType = "";
  let pending = null as { name: string; type: ValueType } | null;
  let record = null as { seen: Map<string, number>; begin: Token; reported: boolean } | null;
  let unknownValue = null as Token | null;
  const unknown = new Set<string>();
  let stopped = false;

  const check = (token: Token) => {
    const wrong = values.filter(({ name }) => counts.get(name) !== records);
    if (!wrong.length)
      return;
    if (!record?.reported) {
      const seen = record?.seen;
      const missing = wrong.filter(({ name }) => !seen?.get(name)).map(({ name }) => name);
      const repeated = wrong.filter(({ name }) => (seen?.get(name) ?? 0) > 1).map(({ name }) => name);
      const [code, details]: [DiagnosticCode, string] = missing.length
        ? ["missing-field", `missing ${missing.join(", ")}`]
        : repeated.length
          ? ["repeated-field", `repeated ${repeated.join(", ")}`]
          : ["field-count", `${wrong.map(({ name }) => name).join(", ")} don't have one value per record`];
      report(token, {
        code,
        severity: Error,
        message: `The file is only read up to here, the rest is skipped: ${details}`,
        field: (missing[0] ?? repeated[0] ?? wrong[0].name),
      });
    }
    if (!stopped) {
      stopped = true;
      problems.push({ code: "skipped-rest", severity: Hint, message: "Skipped", start: token.end, end: text.length, skipped: true });
    }
    for (const { name } of values)
      counts.set(name, records);
  };

  for (const token of tokenize(text, problems)) {
    if (token.skipped) {
      if (pending)
        report(token, {
          code: "empty-braces",
          severity: Warning,
          message: `Empty {} is skipped: ${pending.name} takes the next token as its value`,
          skipped: true,
          field: pending.name,
        });
      continue;
    }
    const key = token.quoted ? "" : token.text.toLowerCase();
    if (pending) {
      if (fields.has(key) || key === begin || key === end)
        report(token, {
          code: "no-value",
          severity: Warning,
          message: `${pending.name} has no value; "${token.text}" is read as its value`,
          field: pending.name,
        });
      else
        checkValue(pending.name, pending.type, token, text, problems);
      counts.set(pending.name, (counts.get(pending.name) ?? 0) + 1);
      pending = null;
      continue;
    }
    const field = fields.get(key);
    const value = unknownValue;
    unknownValue = null;
    if (key === begin) {
      if (record)
        report(token, { code: "missing-end", severity: Warning, message: `${table.end} is missing before this record` });
      records++;
      lastType = "c";
      record = { seen: new Map(), begin: token, reported: false };
    } else if (key === end) {
      lastType = "e";
      check(token);
      record = null;
    } else if (field && field.type !== "n") {
      lastType = field.type;
      pending = { name: field.name, type: field.type };
      if (record) {
        record.seen.set(field.name, (record.seen.get(field.name) ?? 0) + 1);
        if (tabbed && separatedBySpace(text, token))
          report(token, {
            code: "space-separator",
            severity: Information,
            message: `Space instead of a tab before ${field.name}; tab-separated tools may misread it`,
            field: field.name,
          });
      } else
        report(token, {
          code: "outside-record",
          severity: Warning,
          message: `${field.name} outside a record still counts: the file is only read up to the next ${table.end}`,
          field: field.name,
        });
    } else {
      const name = visible(text.slice(token.start, token.end));
      if (lastType === "c") {
        records++;
        if (record && !record.reported && !value) {
          record.reported = true;
          report(token, {
            code: "extra-record",
            severity: Error,
            message: `${name} right after ${table.begin} counts as another record: the file is only read up to ${table.end}`,
          });
        }
      } else if (lastType === "e")
        check(token);
      else if (value)
        problems.push({ code: "unknown-field", severity: Hint, message: "Skipped", start: token.start, end: token.end, skipped: true });
      else if (record) {
        report(token, {
          code: "unknown-field",
          severity: unknown.has(key) ? Hint : Warning,
          message: `Unknown field ${name}: skipped with its value`,
          skipped: true,
        });
        unknown.add(key);
      }
      if (!value && /^[ \t　]*=/.test(text.slice(token.end, token.end + 8)))
        unknownValue = token;
      continue;
    }
  }
  if (record)
    report(
      record.begin,
      values.some(({ name }) => counts.get(name) !== records)
        ? { code: "unclosed-record", severity: Error, message: "Record is not closed and is incomplete: the file may fail to load" }
        : { code: "missing-end", severity: Warning, message: `${table.end} is missing` },
    );
  return problems;
}

function positions(text: string) {
  const lines = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1))
    lines.push(i + 1);
  return (offset: number): Position => {
    let low = 0;
    let high = lines.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lines[middle] <= offset)
        low = middle;
      else
        high = middle - 1;
    }
    return { line: low, character: offset - lines[low] };
  };
}

export function check(text: string, table: Table): Diagnostic[] {
  const position = positions(text);
  return problemsOf(text, table)
    .sort((a, b) => a.severity - b.severity || a.start - b.start)
    .slice(0, MAX_DIAGNOSTICS)
    .map(({ code, severity, message, start, end, skipped, field }) => ({
      range: { start: position(start), end: position(end) },
      severity,
      code,
      source: "l2txt",
      message,
      ...(skipped && { tags: [DiagnosticTag.Unnecessary] }),
      ...(field && { data: { field } }),
    }));
}

const errors = (diagnostics: Diagnostic[]) => diagnostics.filter(({ severity }) => severity === Error).length;

export function validate(text: string, fileName: string, options: { client?: Client } = {}):
  { client: Client; diagnostics: Diagnostic[] } | null {
  let best: { client: Client; diagnostics: Diagnostic[] } | null = null;
  for (const [client, table] of tablesFor(fileName)) {
    if (options.client && client !== options.client)
      continue;
    const diagnostics = check(text, table);
    if (!best || errors(diagnostics) < errors(best.diagnostics))
      best = { client, diagnostics };
  }
  return best;
}
