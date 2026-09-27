import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(
  fileURLToPath(new URL("../styles.css", import.meta.url)),
  "utf8",
);

describe("sidebar identity actions layout", () => {
  it("keeps the identity and its action group on one horizontal row", () => {
    expect(stylesheet).toMatch(/\.sidebar-foot\{[^}]*display:flex[^}]*align-items:center[^}]*\}/);
    expect(stylesheet).toMatch(/\.identity\{[^}]*min-width:0[^}]*flex:1[^}]*margin:0[^}]*\}/);
    expect(stylesheet).toMatch(/\.foot-actions\{[^}]*display:flex[^}]*flex:none[^}]*\}/);
  });
});
