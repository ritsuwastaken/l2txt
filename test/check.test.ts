import assert from "node:assert/strict";
import { test } from "node:test";
import { check, DiagnosticSeverity, tables, tablesFor, validate, type Diagnostic } from "../src/index.ts";

const record = (fields: string) => `skill_begin\t${fields}\tskill_end`;
const ok = "skill_id=1\tskill_level=1\tname=[A]\tdesc=[B]";
const table = tables.C1.skillname;
const names = Object.fromEntries(Object.entries(DiagnosticSeverity).map(([name, value]) => [value, name]));

const codes = (text: string) => check(text, table).map(({ code, severity }) => `${code}:${names[severity]}`);

test("valid records, however they are laid out", () => {
  assert.deepEqual(check(record(ok), table), []);
  assert.deepEqual(check("SKILL_BEGIN skill_id = 1\r\n skill_level=1$name=[A];\u3000desc=[B]\nskill_end", table), []);
  assert.deepEqual(check(`junk ${record(ok)}\n${record(ok)}`, table), []);
  assert.deepEqual(check(`\ufeff${record(ok)}`, table), []);
  assert.deepEqual(check(record("skill_id=1\tskill_level=1\tname=[A]\tdesc=[]"), table), []);
  assert.deepEqual(check(`skill_begin\t${ok}\tskill_{end}`, table), []);
  assert.deepEqual(check(`skill_id=1 ${record("skill_level=1\tname=[A]\tdesc=[B]")}`, table).map(({ code }) => code), ["outside-record"]);
});

test("the first error stops the file being read", () => {
  assert.deepEqual(codes(record("skill_id=1\tskill_level=1\tname=[A]")), ["missing-field:Error", "skipped-rest:Hint"]);
  assert.deepEqual(codes(record(`${ok}\tname=[C]`)), ["repeated-field:Error", "skipped-rest:Hint"]);
  assert.deepEqual(codes(record(`foo=2\t${ok}`)), ["extra-record:Error", "skipped-rest:Hint"]);
  assert.deepEqual(codes(`${record("skill_id=1")}\n${record("skill_id=1")}`), ["missing-field:Error", "skipped-rest:Hint"]);
  assert.deepEqual(codes(`${record(ok)}\nskill_begin\tskill_id=1`), ["unclosed-record:Error"]);
  assert.deepEqual(codes(record("skill_id=1\tskill_level=1\tname=[A\tdesc=[B]")), ["missing-field:Error", "skipped-rest:Hint"]);
  assert.deepEqual(codes(`skill_begin\t${ok.replace("[B]", "[B")}`), ["unclosed-bracket:Error", "missing-end:Warning", "skipped-rest:Hint"]);
});

test("warnings, information and hints", () => {
  assert.deepEqual(codes(`${record(`${ok}\tfoo=2`)}\n${record(`${ok}\tfoo=3`)}`), ["unknown-field:Warning", "unknown-field:Hint", "unknown-field:Hint", "unknown-field:Hint"]);
  assert.deepEqual(check(record(`${ok}\t]`), table).map(({ message }) => message), ["Unknown name ] is skipped"]);
  assert.deepEqual(codes(record("skill_id=abc\tskill_level=1.5\tname=[A]\tdesc=[B]")), ["not-a-number:Warning", "not-an-integer:Hint"]);
  assert.deepEqual(check(record("skill_id=0x10\tskill_level=1e5\tname=[A]\tdesc=[B]"), table).map(({ message }) => message), [
    "skill_id is an integer field; read as 0",
    "skill_level is an integer field; read as 1",
  ]);
  assert.deepEqual(codes(record("skill_id=[ 5]\tskill_level=1\tname=[A]\tdesc=[B]")), []);
  assert.deepEqual(codes(record("skill_id=1 skill_level=1\tname=[A]\tdesc=[B]")), ["space-separator:Information"]);
  assert.deepEqual(codes(`skill_begin\t${ok}`), ["missing-end:Warning"]);
  assert.deepEqual(codes(record("skill_id=\tskill_level=1\tname=[A]\tdesc=[B]")).slice(0, 2), ["missing-field:Error", "no-value:Warning"]);
  assert.deepEqual(codes(record("skill_id=1\tskill_level=1\tname=[A]\tdesc=")), ["missing-end:Warning", "no-value:Warning"]);
  assert.deepEqual(codes(record("skill_id={}\tskill_level=1\tname=[A]\tdesc=[B]")).slice(0, 3), ["missing-field:Error", "empty-braces:Warning", "no-value:Warning"]);
  const list = tables.C1.etcitemgrp;
  assert.ok(check("item_begin\tdrop_mesh={{a};b}\titem_end", list).some(({ code }) => code === "broken-list"));
});

test("diagnostics are LSP diagnostics, most severe first and capped", () => {
  const line = record(`${ok}\tfoo=2`);
  const [diagnostic] = check(`${record(ok)}\r\n${line}`, table);
  const at = line.indexOf("foo");
  assert.deepEqual(diagnostic, {
    range: { start: { line: 1, character: at }, end: { line: 1, character: at + 3 } },
    severity: 2,
    code: "unknown-field",
    source: "l2txt",
    message: "Unknown field foo: skipped with its value",
    tags: [1],
  } satisfies Diagnostic);
  const many = Array.from({ length: 2100 }, () => record("skill_id=1\tskill_level=1.5\tname=[A]\tdesc=[B]")).join("\n");
  assert.equal(check(`${many}\nskill_begin\tskill_id=1`, table).length, 2000);
  assert.equal(check(`${many}\nskill_begin\tskill_id=1`, table)[0].code, "unclosed-record");
  assert.deepEqual(check(`${record(ok)}\r${record("skill_id=1")}`, table)[0].range.start, { line: 1, character: 23 });
});

test("tables by file name and client version", () => {
  assert.deepEqual(tablesFor("C:\\L2\\system\\Skillname-e.txt").map(([client]) => client), ["C1", "C2"]);
  assert.deepEqual(tablesFor("Logongrp.txt"), []);
  assert.equal(validate("", "notes.txt"), null);
  assert.equal(validate(record(ok), "Skillname-e.txt")?.client, "C1");
  assert.equal(validate(record(ok), "henna.txt", { client: "C1" }), null);
  const skillgrp = "skill_begin\tskill_id=1\tskill_level=1\ticon=[a]\toperate_type=0\tis_magic=0\tmp_consume=1\tcast_range=1\thit_time=1\tanimation=[a]\tcast_style=1\tskill_end";
  assert.equal(validate(skillgrp, "skillgrp.txt")?.client, "C2");
  assert.equal(validate(skillgrp, "skillgrp.txt", { client: "C1" })?.client, "C1");
});
