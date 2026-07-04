import test from "node:test";
import assert from "node:assert/strict";

import { isInfiaiMemoryToolsEnabled } from "./memoryTools";
import { registerOpenIMTools } from "./tools";

test("memory tools are disabled by default", () => {
  assert.equal(isInfiaiMemoryToolsEnabled({}), false);
  assert.equal(
    isInfiaiMemoryToolsEnabled({ INFIAI_MEMORY_TOOLS_ENABLED: "0" }),
    false,
  );
});

test("memory tools enable only with explicit gray switch", () => {
  assert.equal(
    isInfiaiMemoryToolsEnabled({ INFIAI_MEMORY_TOOLS_ENABLED: "1" }),
    true,
  );
  assert.equal(
    isInfiaiMemoryToolsEnabled({ OPENCLAW_MEMORY_TOOLS_ENABLED: "true" }),
    true,
  );
});

test("registerOpenIMTools does not register active-memory tools until enabled", () => {
  const original = process.env.INFIAI_MEMORY_TOOLS_ENABLED;
  delete process.env.INFIAI_MEMORY_TOOLS_ENABLED;
  const names: string[] = [];
  registerOpenIMTools({
    registerTool(tool: { name: string }) {
      names.push(tool.name);
    },
    logger: { warn() {}, info() {} },
  });
  assert.equal(
    names.some((name) => name.startsWith("infiai_memory_")),
    false,
  );

  process.env.INFIAI_MEMORY_TOOLS_ENABLED = "1";
  const enabledNames: string[] = [];
  registerOpenIMTools({
    registerTool(tool: { name: string }) {
      enabledNames.push(tool.name);
    },
    logger: { warn() {}, info() {} },
  });
  assert.deepEqual(
    enabledNames.filter((name) => name.startsWith("infiai_memory_")),
    [
      "infiai_memory_search",
      "infiai_memory_get",
      "infiai_memory_store",
      "infiai_memory_update",
      "infiai_memory_archive",
    ],
  );

  if (original === undefined) delete process.env.INFIAI_MEMORY_TOOLS_ENABLED;
  else process.env.INFIAI_MEMORY_TOOLS_ENABLED = original;
});
