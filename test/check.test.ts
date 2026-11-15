import assert from "node:assert/strict";
import { test } from "node:test";
import { check, tables, tablesFor, validate, type Diagnostic } from "../src/index.ts";

const record = (fields: string) => `skill_begin\t${fields}\tskill_end`;
const ok = "skill_id=1\tskill_level=1\tname=[A]\tdesc=[B]";
const table = tables.C1.skillname;

const codes = (text: string) =>
  check(text, table).map(({ code, severity }) => `${code}:${severity}`);

test("valid records, however they are laid out", () => {
  assert.deepEqual(check(record(ok), table), []);
  assert.deepEqual(check("SKILL_BEGIN skill_id = 1\n skill_level=1 name=[A]\n desc=[B]\nskill_end", table), []);
  assert.deepEqual(check(`junk ${record(ok)}\n${record(ok)}`, table), []);
});

test("errors where the file stops being read", () => {
  assert.deepEqual(codes(record("skill_id=1\tskill_level=1\tname=[A]")), ["missing-field:1", "skipped-rest:4"]);
  assert.deepEqual(codes(record(`${ok}\tname=[C]`)), ["repeated-field:1", "skipped-rest:4"]);
  assert.deepEqual(codes(record(`foo=2\t${ok}`)), ["extra-record:1", "skipped-rest:4"]);
  assert.deepEqual(codes(`${record(ok)}\nskill_begin\tskill_id=1`), ["unclosed-record:1"]);
  assert.deepEqual(codes(record("skill_id=1\tskill_level=1\tname=[A\tdesc=[B]")), ["missing-field:1", "skipped-rest:4"]);
  assert.deepEqual(codes("skill_begin\tskill_id=1\tskill_level=1\tname=[A\tdesc=[B\tskill_end"), ["unclosed-record:1", "unclosed-bracket:1", "skipped-rest:4"]);
});

test("warnings, information and hints", () => {
  assert.deepEqual(codes(record(`${ok}\tfoo=2`)), ["unknown-field:2", "unknown-field:4"]);
  assert.deepEqual(codes(record(`${ok}\t]`)), ["unknown-field:2"]);
  assert.deepEqual(codes(record("skill_id=abc\tskill_level=1.5\tname=[A]\tdesc=[B]")), ["not-a-number:2", "not-an-integer:4"]);
  assert.deepEqual(codes(record("skill_id=1 skill_level=1\tname=[A]\tdesc=[B]")), ["space-separator:3"]);
  assert.deepEqual(codes(`skill_begin\t${ok}`), ["missing-end:2"]);
  const novalue = codes(record("skill_id=\tskill_level=1\tname=[A]\tdesc=[B]"));
  assert.ok(novalue.includes("no-value:2") && novalue.includes("missing-field:1"));
  assert.ok(codes(record("skill_id={}\tskill_level=1\tname=[A]\tdesc=[B]")).includes("empty-braces:2"));
});

test("diagnostics are LSP diagnostics", () => {
  const line = record(`${ok}\tfoo=2`);
  const [diagnostic] = check(`${record(ok)}\n${line}`, table);
  const at = line.indexOf("foo");
  assert.deepEqual(diagnostic, {
    range: { start: { line: 1, character: at }, end: { line: 1, character: at + 3 } },
    severity: 2,
    code: "unknown-field",
    source: "l2txt",
    message: "Unknown field foo: skipped with its value",
    tags: [1],
  } satisfies Diagnostic);
});

test("tables by file name and client version", () => {
  assert.deepEqual(tablesFor("C:\\L2\\system\\Skillname-e.txt").map(([client]) => client), ["C1", "C2"]);
  assert.deepEqual(tablesFor("Logongrp.txt"), []);
  assert.equal(validate("", "notes.txt"), null);
  const skillgrp = "skill_begin\tskill_id=1\tskill_level=1\ticon=[a]\toperate_type=0\tis_magic=0\tmp_consume=1\tcast_range=1\thit_time=1\tanimation=[a]\tcast_style=1\tskill_end";
  assert.equal(validate(skillgrp, "skillgrp.txt")?.client, "C2");
  assert.equal(validate(skillgrp, "skillgrp.txt", { client: "C1" })?.client, "C1");
});
