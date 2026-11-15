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

interface Token {
  text: string;
  start: number;
  end: number;
  quoted: boolean;
  empty: boolean;
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

interface Tokens {
  tokens: Token[];
  problems: Problem[];
}

const Severity = DiagnosticSeverity;
const MAX_DIAGNOSTICS = 2000;
const BLANK = /^[ \t　]*/;
const INTEGER = /^\s*([+-]?\d+)/;
const FLOAT = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/;
const DECIMAL = /^\s*[+-]?\d+\.\d*\s*$/;

const isDelimiter = (c: number) =>
  c === 0x20 || c === 0x3000 || c === 0x0a || c === 0x09 || c === 0x0d || c === 0x3d || c === 0x24 || c === 0x3b;

const atoi = (text: string) => Number(INTEGER.exec(text)?.[1] ?? 0);
const atof = (text: string) => Number(FLOAT.exec(text)?.[0] ?? 0);

const clients = Object.keys(tables) as Client[];

export function tablesFor(fileName: string): [Client, Table][] {
  const base = fileName.replace(/^.*[/\\]/, "").toLowerCase().replace(/\.txt$/, "");
  return clients.flatMap((client): [Client, Table][] => {
    const byName: Record<string, Table> = tables[client];
    const table = byName[base] ?? byName[base.replace(/-[a-z]+$/, "")];
    return table && Object.keys(table.fields).length ? [[client, table]] : [];
  });
}

function tokenize(text: string, from = 0, to = text.length): Tokens {
  const tokens: Token[] = [];
  const problems: Problem[] = [];
  let i = from;
  while (i < to) {
    while (i < to && isDelimiter(text.charCodeAt(i)))
      i++;
    if (i >= to)
      break;
    const start = i;
    let token: Token | null = null;
    for (; i < to; i++) {
      const c = text.charCodeAt(i);
      if (c === 0x7b || c === 0x5b) {
        const close = text.indexOf(c === 0x7b ? "}" : "]", i + 1);
        if (close < 0 || close >= to) {
          problems.push(
            { code: "unclosed-bracket", severity: Severity.Error, message: `Unclosed '${text[i]}': the rest of the file is read as one value`, start: i, end: i + 1 },
            { code: "skipped-rest", severity: Severity.Hint, message: "Read as one value", start: i, end: to, skipped: true },
          );
          const value = text.slice(start, i) + text.slice(i + 1, to);
          if (value)
            tokens.push({ text: value, start, end: to, quoted: true, empty: false });
          return { tokens, problems };
        }
        const value = text.slice(start, i) + text.slice(i + 1, close);
        token = { text: value, start, end: close + 1, quoted: true, empty: !value && c === 0x7b };
        i = close + 1;
        break;
      }
      if (isDelimiter(c))
        break;
    }
    tokens.push(token ?? { text: text.slice(start, i), start, end: i, quoted: false, empty: false });
  }
  return { tokens, problems };
}

const visible = (name: string) =>
  name.replace(/[^\x21-\x7e]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);

function separatedBySpace(text: string, token: Token) {
  let i = token.start - 1;
  while (i >= 0 && (text[i] === " " || text[i] === "　"))
    i--;
  return i < token.start - 1 && i >= 0 && text[i] !== "\t" && text[i] !== "\n" && text[i] !== "=";
}

function checkValue(field: string, type: FieldType, value: Token, text: string, problems: Problem[]) {
  const at = { start: value.start, end: value.end, field };
  if (type === "d") {
    const read = atoi(value.text);
    if (read !== Number(value.text.trim()) || !value.text.trim())
      problems.push({
        ...at,
        code: DECIMAL.test(value.text) ? "not-an-integer" : "not-a-number",
        severity: DECIMAL.test(value.text) ? Severity.Hint : Severity.Warning,
        message: `${field} is an integer field; read as ${read}`,
      });
  } else if (type === "f") {
    const read = atof(value.text);
    if (read !== Number(value.text.trim()) || !value.text.trim())
      problems.push({ ...at, code: "not-a-number", severity: Severity.Warning, message: `${field} must be a number; read as ${read}` });
  } else if (type === "m" && text[value.end - 1] === "}") {
    const inner = text.slice(value.start, value.end - 1);
    const list = inner.slice(inner.indexOf("{") + 1);
    if (list.includes("{") || tokenize(list).problems.length)
      problems.push({ ...at, code: "broken-list", severity: Severity.Error, message: `${field}: broken list (nested '{' or unclosed '['); the rest of the file may be misread` });
  }
}

function problemsOf(text: string, { tokens, problems: found }: Tokens, table: Table): Problem[] {
  const problems = [...found];
  const fields = new Map(Object.entries(table.fields).map(([name, type]) => [name.toLowerCase(), { name, type }]));
  const begin = table.begin.toLowerCase();
  const end = table.end.toLowerCase();
  const tabbed = text.includes("\t");
  const report = (token: Token, problem: Omit<Problem, "start" | "end">) =>
    problems.push({ ...problem, start: token.start, end: token.end });

  const counts = new Map([...fields.values()].map(({ name }) => [name, 0]));
  const unknown = new Set<string>();
  let records = 0;
  let after: "begin" | "end" | "field" = "field";
  let pending: { name: string; type: FieldType } | null = null;
  let record: { begin: Token; seen: Map<string, number>; reported: boolean } | null = null;
  let valueOfUnknown = false;
  let stopped = false;

  const endRecord = (token: Token) => {
    const wrong = [...fields.values()].filter(({ name }) => counts.get(name) !== records);
    if (!wrong.length)
      return;
    stopped = true;
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
        severity: Severity.Error,
        message: `The file is only read up to here, the rest is skipped: ${details}`,
        field: missing[0] ?? repeated[0] ?? wrong[0].name,
      });
    }
    problems.push({ code: "skipped-rest", severity: Severity.Hint, message: "Skipped", start: token.end, end: text.length, skipped: true });
  };

  for (const token of tokens) {
    if (stopped)
      break;
    if (token.empty) {
      if (pending)
        report(token, {
          code: "empty-braces",
          severity: Severity.Warning,
          message: `Empty {} is skipped: ${pending.name} takes the next token as its value`,
          skipped: true,
          field: pending.name,
        });
      continue;
    }
    const key = token.text.toLowerCase();
    if (pending) {
      if (!token.quoted && (fields.has(key) || key === begin || key === end))
        report(token, {
          code: "no-value",
          severity: Severity.Warning,
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
    const isValue: boolean = valueOfUnknown;
    valueOfUnknown = false;
    if (key === begin) {
      if (record)
        report(token, { code: "missing-end", severity: Severity.Warning, message: `${table.end} is missing before this record` });
      records++;
      after = "begin";
      record = { begin: token, seen: new Map(), reported: false };
    } else if (key === end) {
      after = "end";
      endRecord(token);
      record = null;
    } else if (field) {
      after = "field";
      pending = field;
      if (record) {
        record.seen.set(field.name, (record.seen.get(field.name) ?? 0) + 1);
        if (tabbed && separatedBySpace(text, token))
          report(token, {
            code: "space-separator",
            severity: Severity.Information,
            message: `Space instead of a tab before ${field.name}; tab-separated tools may misread it`,
            field: field.name,
          });
      } else
        report(token, {
          code: "outside-record",
          severity: Severity.Warning,
          message: `${field.name} is outside a record; its value counts toward the next record`,
          field: field.name,
        });
    } else {
      const withValue: boolean = !isValue && /^[ \t　]*=/.test(text.slice(token.end, token.end + 8));
      if (after === "begin") {
        records++;
        if (record && !record.reported && !isValue) {
          record.reported = true;
          report(token, {
            code: "extra-record",
            severity: Severity.Error,
            message: `${visible(token.text)} right after ${table.begin} counts as another record: the file is only read up to ${table.end}`,
          });
        }
      } else if (after === "end")
        endRecord(token);
      else if (isValue)
        report(token, { code: "unknown-field", severity: Severity.Hint, message: "Skipped", skipped: true });
      else if (record) {
        report(token, {
          code: "unknown-field",
          severity: unknown.has(key) ? Severity.Hint : Severity.Warning,
          message: withValue ? `Unknown field ${visible(token.text)}: skipped with its value` : `Unknown name ${visible(token.text)} is skipped`,
          skipped: true,
        });
        unknown.add(key);
        valueOfUnknown = withValue;
      }
    }
  }
  if (record && !stopped)
    report(
      record.begin,
      [...fields.values()].some(({ name }) => counts.get(name) !== records)
        ? { code: "unclosed-record", severity: Severity.Error, message: "Record is not closed and is incomplete: the file may fail to load" }
        : { code: "missing-end", severity: Severity.Warning, message: `${table.end} is missing` },
    );
  return problems;
}

function positions(text: string) {
  const lines = [0];
  for (const match of text.matchAll(/\r\n?|\n/g))
    lines.push(match.index + match[0].length);
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

const bom = (text: string) => (text.charCodeAt(0) === 0xfeff ? 1 : 0);

function diagnosticsOf(problems: Problem[], position: (offset: number) => Position): Diagnostic[] {
  return problems
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

export function check(text: string, table: Table): Diagnostic[] {
  return diagnosticsOf(problemsOf(text, tokenize(text, bom(text)), table), positions(text));
}

function fit(problems: Problem[]) {
  const errors = problems.filter(({ severity }) => severity === Severity.Error);
  return {
    errors: errors.length,
    firstError: errors.length ? Math.min(...errors.map(({ start }) => start)) : Infinity,
    warnings: problems.filter(({ severity }) => severity === Severity.Warning).length,
  };
}

const better = (a: ReturnType<typeof fit>, b: ReturnType<typeof fit>) =>
  a.errors !== b.errors ? a.errors < b.errors : a.firstError !== b.firstError ? a.firstError > b.firstError : a.warnings < b.warnings;

export function validate(text: string, fileName: string, options: { client?: Client } = {}): { client: Client; diagnostics: Diagnostic[] } | null {
  const candidates = tablesFor(fileName).filter(([client]) => !options.client || client === options.client);
  if (!candidates.length)
    return null;
  const tokens = tokenize(text, bom(text));
  let best: { client: Client; problems: Problem[]; fit: ReturnType<typeof fit> } | null = null;
  for (const [client, table] of candidates) {
    const problems = problemsOf(text, tokens, table);
    const score = fit(problems);
    if (!best || better(score, best.fit))
      best = { client, problems, fit: score };
  }
  return best && { client: best.client, diagnostics: diagnosticsOf(best.problems, positions(text)) };
}
