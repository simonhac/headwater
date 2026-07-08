/**
 * Pure decision graph for one kept mention — the branch logic of the pipeline, lifted out of the
 * I/O in process.ts so it can be tested exhaustively.
 *
 * Precedence (first match wins):
 *   1. already handled (brief-scoped dedupe)      → "duplicate"
 *   2. posting disabled                           → "preview"
 *   3. a fresh existing story to fold into        → "merge"   (same-title syndication OR near-dup)
 *   4. otherwise                                  → "post"
 *
 * The "post" outcome (posted vs. slack-error) depends on the Slack response and is decided by the
 * caller — `decide` only chooses the branch.
 */
export type DecisionAction = "duplicate" | "preview" | "merge" | "post";

export interface DecisionState {
  seen: boolean;
  postingEnabled: boolean;
  existing: boolean;
}

export function decide(s: DecisionState): DecisionAction {
  if (s.seen) return "duplicate";
  if (!s.postingEnabled) return "preview";
  if (s.existing) return "merge";
  return "post";
}
