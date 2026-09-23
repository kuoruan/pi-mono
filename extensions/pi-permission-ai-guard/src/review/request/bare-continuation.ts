/**
 * Bare-continuation detection: user messages that carry no authorization content
 * ("go on", "继续"). The stripper drops them before the quota check, so a bare
 * continuation never evicts a real task sentence from the window.
 *
 * What counts: CONTINUE verbs only — words that tell the agent to keep doing
 * what it is already doing. Confirmations ("ok", "好的"), praise ("perfect",
 * "漂亮"), thanks ("thanks", "谢谢"), and agreements ("agreed", "同意") are
 * DELIBERATELY excluded: a lone "ok" reads as approval of the pending action,
 * which IS an authorization signal. Dropping it would discard the very grant
 * the reviewer needs to see. When in doubt the word stays out — an unlisted
 * message costs quota but is always judged; a wrongly listed one silently
 * erases authorization.
 *
 * Sources: instar's BARE_CONTINUATION_PHRASES, VTCode's is_follow_up_prompt_like,
 * newt-core's BARE_CONTINUATION_PHRASES, AgentBigBrain's CONTINUE_WORK_PATTERNS
 * cores, plus hand-written Simplified and Traditional Chinese sets (no
 * community list exists). Where the sources disagree this file sides with
 * newt-core's conservative cut ("ok"/"thanks" are fresh prompts there) over
 * instar's broad cut, because this gate protects authorization, not
 * commitment bookkeeping. Narrowing signals ("stop", "wait", "no") are
 * excluded for the same reason — they constrain authorization and must keep
 * the anchor slot.
 *
 * The list is plain data: native speakers, please extend it via issue or PR.
 */

/** Bare-continuation phrases: normalized form (lowercase, no punctuation). */
const BARE_CONTINUATION_PHRASES = new Set([
  // English: CONTINUE verbs only. AgentBigBrain's prefix patterns ("continue
  // working on X") are real requests, so only their bare cores are listed.
  "continue",
  "please continue",
  "continue please",
  "yes continue",
  "keep going",
  "keep going with it",
  "keep going with that",
  "keep going with this",
  "continue with recommendation",
  "continue with your recommendation",
  "go on",
  "carry on",
  "resume",
  "proceed",
  "please proceed",
  "go ahead",
  "go for it",
  "do it",
  "do that",
  "please do",
  "please do that",
  "take it from here",
  "finish it",
  "finish that",
  "finish",
  "finish up",
  "next",
  "go",
  "yes go",
  "yes go ahead",
  "keep at it",
  "don't stop",
  "don t stop",
  "dont stop",
  "do not stop",
  "onward",
  "onwards",
  "please",
  // Simplified Chinese: CONTINUE verbs only.
  "继续",
  "继续吧",
  "请继续",
  "继续说",
  "继续讲",
  "还有呢",
  "然后呢",
  "然后",
  "接着说",
  "接着讲",
  "接着来",
  "说下去",
  "讲下去",
  "接下来",
  "下一步",
  "再来",
  // "继续下一步"-style composites are real requests, not bare nudges: they
  // name WHAT comes next, so they stay in the window for the reviewer to judge.
  // Traditional Chinese: Taiwan/Hong Kong CONTINUE verbs.
  "繼續",
  "請繼續",
  "還有呢",
  "然後呢",
  "然後咧",
  "然後",
  "再來",
  "接著說",
  "接下來",
]);

/**
 * Normalize a message for continuation matching: trim, strip punctuation, collapse
 * whitespace, lowercase ASCII. CJK characters are preserved (unlike instar's
 * ASCII strip, which would erase the entire Chinese set).
 *
 * @param text - The raw message text.
 * @returns The normalized form, possibly empty.
 */
function normalizeContinuation(text: string): string {
  return text
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * True when the message is a bare continuation carrying no authorization content.
 * Empty or punctuation-only input counts as one (nothing to authorize with).
 *
 * @param text - The message text.
 * @returns Whether the message is a bare continuation.
 */
export function isBareContinuation(text: string): boolean {
  const norm = normalizeContinuation(text);
  if (!norm) return true;
  // A lone emoji ("👍") normalizes to empty and is dropped with it. That is
  // accepted collateral: an emoji carries no named action, so the reviewer
  // would have nothing to authorize it against — unlike a lone "ok", which
  // reads as approval of the pending action.
  // Long or multi-part input always carries content beyond a bare nudge
  // (newt-core's 48-char rule, kept as-is: the longest listed phrase is 33
  // chars, so 48 leaves headroom without admitting real sentences).
  // "proceed to delete the production database" must never match on its
  // leading verb.
  if (norm.length > 48) return false;
  // Strip one leading decision ordinal ("1: proceed", "2. continue") so
  // decision-surface replies match.
  const bare = norm.replace(/^\d+\s+/, "");
  return BARE_CONTINUATION_PHRASES.has(bare);
}
