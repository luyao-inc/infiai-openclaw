import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { plainMarkdownText } from "./plainMarkdownText";
import { buildReplyPlan, effectiveReplyDelivery } from "./reply-plan";

const cases = JSON.parse(
  readFileSync(
    new URL("./plainMarkdownText.cases.json", import.meta.url),
    "utf8"
  )
) as Array<{ name: string; raw: string; expected: string }>;
for (const row of cases) {
  test(`plain chat prose: ${row.name}`, () => {
    assert.equal(plainMarkdownText(row.raw), row.expected);
    assert.equal(
      plainMarkdownText(row.expected),
      row.expected,
      "normalization is idempotent"
    );
  });
}
test("normalize complete emphasis without inventing message boundaries", () => {
  const body = "这是详细说明。".repeat(80);
  const parts = buildReplyPlan(`**${body}**`, effectiveReplyDelivery());
  assert.deepEqual(parts, [body]);
  assert.equal(parts.join("").replace(/\s/g, ""), body);
  assert.ok(parts.every((part) => !part.includes("**")));
  assert.deepEqual(
    buildReplyPlan(
      "**第一段。\n<<<LINGXIE_MESSAGE>>>\n第二段。**",
      effectiveReplyDelivery()
    ),
    ["第一段。", "第二段。"]
  );
});

test("long inline and indented code remain intact through reply planning", () => {
  const code = '`const text = "' + "代码。**".repeat(80) + '"`';
  const indented = "    const text = '" + "代码。**".repeat(80) + "';";
  for (const raw of [code, indented]) {
    assert.deepEqual(buildReplyPlan(raw, effectiveReplyDelivery()), [raw]);
  }
});
