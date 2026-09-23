import { describe, expect, it } from "vitest";

import { isBareContinuation } from "#src/review/request/bare-continuation.ts";

describe("isBareContinuation", () => {
  it("matches CONTINUE verbs with punctuation and case variants", () => {
    expect(isBareContinuation("go on")).toBe(true);
    expect(isBareContinuation("Go on...")).toBe(true);
    expect(isBareContinuation("CONTINUE")).toBe(true);
    expect(isBareContinuation("please continue!")).toBe(true);
    expect(isBareContinuation("keep going with it")).toBe(true);
    expect(isBareContinuation("take it from here")).toBe(true);
    expect(isBareContinuation("Don't stop!")).toBe(true);
    expect(isBareContinuation("do not stop")).toBe(true);
  });

  it("matches Chinese CONTINUE verbs with full-width punctuation", () => {
    expect(isBareContinuation("继续")).toBe(true);
    expect(isBareContinuation("继续！！")).toBe(true);
    expect(isBareContinuation("还有呢？")).toBe(true);
    expect(isBareContinuation("下一步")).toBe(true);
  });

  it("matches Traditional Chinese CONTINUE verbs", () => {
    expect(isBareContinuation("繼續")).toBe(true);
    expect(isBareContinuation("然後咧")).toBe(true);
    expect(isBareContinuation("再來")).toBe(true);
  });

  it("strips a leading decision ordinal", () => {
    expect(isBareContinuation("1: proceed")).toBe(true);
    expect(isBareContinuation("2. continue")).toBe(true);
  });

  it("rejects confirmations, praise, and thanks — they are authorization signals", () => {
    expect(isBareContinuation("ok")).toBe(false);
    expect(isBareContinuation("okay")).toBe(false);
    expect(isBareContinuation("好的")).toBe(false);
    expect(isBareContinuation("可以")).toBe(false);
    expect(isBareContinuation("perfect")).toBe(false);
    expect(isBareContinuation("漂亮")).toBe(false);
    expect(isBareContinuation("thanks")).toBe(false);
    expect(isBareContinuation("谢谢")).toBe(false);
    expect(isBareContinuation("sounds good")).toBe(false);
    expect(isBareContinuation("lgtm")).toBe(false);
    expect(isBareContinuation("agreed")).toBe(false);
    expect(isBareContinuation("同意")).toBe(false);
    expect(isBareContinuation("嗯嗯")).toBe(false);
    expect(isBareContinuation("對啊")).toBe(false);
  });

  it("rejects real requests and narrowing signals", () => {
    expect(isBareContinuation("continue working on the auth module")).toBe(false);
    expect(isBareContinuation("继续下一步")).toBe(false);
    expect(isBareContinuation("proceed to delete the production database")).toBe(false);
    expect(isBareContinuation("go deploy to staging")).toBe(false);
    expect(isBareContinuation("stop")).toBe(false);
    expect(isBareContinuation("wait")).toBe(false);
    expect(isBareContinuation("no")).toBe(false);
    expect(isBareContinuation("only /tmp, not /")).toBe(false);
    expect(isBareContinuation("把表格组件修好")).toBe(false);
  });

  it("treats empty input as a bare continuation", () => {
    expect(isBareContinuation("")).toBe(true);
    // A lone emoji normalizes to empty: dropped, documented in isBareContinuation.
    expect(isBareContinuation("👍")).toBe(true);
  });

  it("exercises the 48-char cap directly", () => {
    expect(isBareContinuation("continue " + "a".repeat(40))).toBe(false);
    expect(isBareContinuation("go on " + "ok".repeat(10))).toBe(false);
  });
});
