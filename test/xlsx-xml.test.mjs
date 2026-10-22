import assert from "node:assert/strict";
import test from "node:test";
import { parseWorksheetXml } from "../src/xlsx.mjs";

test("可读取带命名空间、空列和 XML 实体的工作表", () => {
  const xml = '<?xml version="1.0"?><x:worksheet xmlns:x="urn:test"><x:sheetData>'
    + '<x:row r="1"><x:c r="A1" t="str"><x:v>名称</x:v></x:c><x:c r="C1" t="str"><x:v>状态</x:v></x:c></x:row>'
    + '<x:row r="2"><x:c r="A2" t="str"><x:v>A&amp;B</x:v></x:c><x:c r="C2" t="str"><x:v>保护中</x:v></x:c></x:row>'
    + '</x:sheetData></x:worksheet>';
  const rows = parseWorksheetXml(xml);
  assert.equal(rows[0][1], "名称");
  assert.equal(rows[0][2], undefined);
  assert.equal(rows[1][1], "A&B");
  assert.equal(rows[1][3], "保护中");
});
