/**
 * Command table vocabulary tests: the name derivations completion, menu,
 * and dispatch all share. One tokenizer, two faces — the typed verb and
 * the display phrase can never drift apart.
 */

import { describe, expect, it } from "vitest";

import { displayPhrase, verbWord } from "#src/session/command/table.ts";

describe("command table vocabulary", () => {
  it("verbWord kebabizes any word shape — camelCase, snake, and kebab alike", () => {
    // Derived, not declared: a future multi-word field name gets its verb
    // automatically, in the ecosystem's uniform command shape.
    expect(verbWord("notifyLevel")).toBe("notify-level");
    expect(verbWord("notify-level")).toBe("notify-level");
    expect(verbWord("risk_mode")).toBe("risk-mode");
    expect(verbWord("api2Key")).toBe("api2-key");
    expect(verbWord("mode")).toBe("mode");
  });

  it("displayPhrase tokenizes any word shape — kebab, camelCase, and snake alike", () => {
    // The tokenizer owns the shape, not the convention: a hypothetical
    // multi-word field name displays as a phrase whatever its casing.
    // (EnumSettingSpec.name is compile-checked against real config
    // fields, so the exotic shapes ride the pure function directly.)
    expect(displayPhrase("notifyLevel")).toBe("notify level");
    expect(displayPhrase("notify-level")).toBe("notify level");
    expect(displayPhrase("risk_mode")).toBe("risk mode");
    expect(displayPhrase("api2Key")).toBe("api2 key");
    expect(displayPhrase("mode")).toBe("mode");
  });
});
