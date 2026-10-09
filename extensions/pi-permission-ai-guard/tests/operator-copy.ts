import { expect } from "vitest";

/**
 * The shape every operator-facing line keeps: the host renders its own level
 * separator before our text, so a structural colon of ours reads as two, and the
 * line joins clauses with parentheses, commas, or semicolons rather than a dash.
 *
 * Tests assert this shape plus the facts a line has to carry, never the full
 * wording: the copy belongs to the product, and a pinned sentence turns every
 * reword into a test edit.
 */
export const OPERATOR_COPY_SHAPE = /^(?![\s\S]*:\s)(?![\s\S]*[—–])[\s\S]+$/;

export type Notice = readonly [message: string, level: string | undefined];

/**
 * Assert the run emitted notices carrying the given facts, and that every line
 * keeps the operator-copy shape.
 *
 * @param notices - The notifications the run collected.
 * @param facts - How many, at which level, carrying which substrings. Wording is
 *   not asserted; only the information the operator has to be able to read.
 * @returns The messages, for a caller that wants to assert more on them.
 */
export function expectNotices(
  notices: readonly Notice[],
  facts: { count?: number; level?: string; contains?: readonly string[] },
): string[] {
  expect(notices).toHaveLength(facts.count ?? 1);
  for (const [message, level] of notices) {
    if (facts.level !== undefined) expect(level).toBe(facts.level);
    for (const fact of facts.contains ?? []) expect(message).toContain(fact);
    expect(message).toMatch(OPERATOR_COPY_SHAPE);
  }
  return notices.map(([message]) => message);
}

export interface NotifySpy {
  mock: { calls: unknown[][] };
}

/**
 * Assert a notice went out at the given level carrying the given facts.
 *
 * @param notify - The notify spy.
 * @param facts - The level, the substrings that must appear, and any that must not.
 */
export function expectNotified(
  notify: NotifySpy,
  facts: { level: string; contains?: readonly string[]; absent?: readonly string[] },
): void {
  const wanted = facts.contains ?? [];
  const found = notify.mock.calls.some(
    ([raw, level]) =>
      level === facts.level &&
      wanted.every((fact) => String(raw).includes(fact)) &&
      (facts.absent ?? []).every((fact) => !String(raw).includes(fact)) &&
      OPERATOR_COPY_SHAPE.test(String(raw)),
  );
  expect(found, `expected a ${facts.level} notice carrying ${JSON.stringify(wanted)}`).toBe(true);
}
