import test from "node:test";
import assert from "node:assert/strict";

import { normalizeRuntimeAgentIDToBusinessAgentID } from "./managedManagedPredicate";

test("normalizes managed runtime agent ids to business agent ids", () => {
  assert.equal(
    normalizeRuntimeAgentIDToBusinessAgentID("mg_default__4839235718__default", "4839235718"),
    "default",
  );
  assert.equal(
    normalizeRuntimeAgentIDToBusinessAgentID("mg_default__4839235718__custom", "4839235718"),
    "custom",
  );
});

test("keeps non-managed agent ids unchanged", () => {
  assert.equal(normalizeRuntimeAgentIDToBusinessAgentID("default", "4839235718"), "default");
  assert.equal(normalizeRuntimeAgentIDToBusinessAgentID("custom", "4839235718"), "custom");
});
