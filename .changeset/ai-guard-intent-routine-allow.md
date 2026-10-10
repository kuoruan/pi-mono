---
"pi-permission-ai-guard": patch
---

The classifier's `intent_match` criteria now grade the authorization link alone — the action is the anchor's direct object or a step toward it, and a read-only inspection is authorized without an anchor while anything else needs one. An approval grants only the scope it names. Danger and risk still gate the verdict, so the question carries no danger or risk predicates of its own ("harmless", "low-risk", "discard no work"): the verdict composes the three axes, and a question that re-checks another one answers its own worse.

The classifier's `irreversible_destruction` is scoped to catastrophic, unrecoverable destruction — wiping the filesystem root or a whole system tree, overwriting a device, wiping history, or discarding a whole worktree's uncommitted work — rather than to any deletion outside the repository. A bounded or regenerable out-of-repo deletion (a cache, a temp dir, a file the request names) now falls to the risk lane instead of the always-deny tier, while whole-tree, device, and uncommitted-work destruction still deny. The chat lane's `Irreversible Destruction` is scoped the same way, so a failover cannot flip the verdict on one command.
