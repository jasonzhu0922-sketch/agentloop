import assert from "node:assert/strict";
import test from "node:test";
import { createClientId } from "../web/client/ui/client-id.js";

test("client IDs remain RFC 4122 v4 when randomUUID is unavailable on an HTTP origin", () => {
  const id = createClientId({ getRandomValues: (bytes: Uint8Array) => bytes.fill(0) });
  assert.equal(id, "00000000-0000-4000-8000-000000000000");
});

test("client IDs prefer the browser native UUID implementation", () => {
  assert.equal(createClientId({ randomUUID: () => "native-id" }), "native-id");
});
