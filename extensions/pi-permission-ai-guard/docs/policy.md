# Review policy

Audience: engineers changing the rules, adding facts, or landing the shared core. Part I states what runs today. Part II states the contract of the shared core both lanes will submit to. Uncertain points are omitted rather than guessed, and a rule change updates this file in the same commit.

Sources of truth: `src/review/axes/questions.ts` (axis labels), `src/review/axes/verdict.ts` (rows, escalator, synthesis), `src/review/request/command-facts.ts` (facts), `src/config/config-schema.ts` (thresholds), `src/review/policy/` (the core), `scripts/review-corpus-impact.ts` (design set).

## Part I — what runs today

### The four axes

Each command is read through four questions. Every answer is a labeled choice with a per-label confidence channel. Confidence gates positive readings only: negative readings (`none`, the request's own word) are adopted whenever a confidence was reported at all.

- **ban** — does a still-effective instruction in the trusted record forbid this action? Labels: `forbids`, `none`, `unestablished`.
- **effect** — what is the heaviest action the command's own words describe? Labels: `read`, `modify`, `delete`, `send_out`, `run_program`, `cannot_determine`.
- **target** — what kind of thing does the action touch, and nothing else? Labels: `ordinary_files`, `credential_material`, `vcs_history`, `system_or_service`, `none`, `cannot_determine`.
- **intent** — did the trusted request name this action, with the command staying inside what the request named? Asked only when the record carries a trusted anchor; without one the verdict takes the no-anchor column directly. Labels: `requested`, `not_requested`, `cannot_determine`.

`ban=unestablished` (the record may hold a prohibition) routes to a lean-deny defer; `effect=cannot_determine` routes to a neutral defer, while `target=cannot_determine` is absorbed into the row conditions (no positive match fires) and `intent=cannot_determine` defers lean-deny on a guard base. An untrusted `forbids` is never dropped silently — it falls through to insufficient-info. An untrusted `requested` never unlocks: it reads as `cannot_determine`.

### Decision rows

First matching row wins. The credential rows (`read-credential`, `publish-or-dump`, `modify-or-send-credential`) treat an unmet condition as a hit: a credential, publish, or dump the record cannot rule out is never released by a negative inference. A release row never fires on a model label alone; the code facts must corroborate it. Tier meanings: `free` needs no request; `plain` releases on a named request and asks leaning allow without one; `guard` releases on a named request and asks leaning deny without one; `block` asks leaning deny even with a named request.

- **`read-credential`** → `block`: reading credential material exposes it into the transcript.
- **`publish-or-dump`** → `block`: publishing an artifact or dumping the environment is irreversible.
- **`modify-or-send-credential`** → `guard`: modifying or sending credential material.
- **`build-output-delete`** → `free`: deleting a regenerable build-output directory inside the project.
- **`unscoped-delete`** → `block`: a deletion the record cannot scope is unratable.
- **`recursive-outside-delete`** → `block`: a recursive deletion outside the workspace.
- **`other-delete`** → `guard`: any other deletion.
- **`restricted-read`** → `guard`: a read that reaches the non-public/non-local network leaves the machine.
- **`public-system-read`** → `free`: a read of a public system path the code recognizes.
- **`outside-read`** → `guard`: a read outside the workspace always asks, even when the target reads as `none`; a named request still releases it.
- **`other-read`** → `free`: any other read.
- **`raw-copy`** → `guard`: a raw device copy.
- **`workspace-modify`** → `plain`: modifying ordinary files inside the workspace (a routine project command runs here as a modification, never `free`).
- **`vcs-write`** → `plain`: a history-preserving VCS write inside the workspace (a scoped feature-branch amend is an ordinary write, not unscoped destruction).
- **`other`** → `guard`: everything else — sending, running a program, modifying a system or service, rewriting history, writing outside the workspace.

The base tier runs twice — once on the model's `effect`, once on the code verb table's `commandEffect` (`unknown` reads as `run_program`) — and the stricter tier wins; the model reading can only tighten, never loosen. A `block` tier defers leaning deny with `riskLevel: critical`. `free` allows. `plain` and `guard` allow only on a trusted `requested` that no escalating fact lifted.

### Escalator

`allInterfaces`, `installsPersistence`, `sendsData`, `authHeaderExpansion`, `rewritesHistory`, and `grantsBeyondOwner` together with `sensitivePathName` each lift any non-`block` tier to at least `guard` (the row id gains a `+escalated` suffix). A lifted `requested` still asks: the request names the action, but the escalating fact is the reason the named action still needs a human. `block` rows never release — nothing lifts them down.

### Irreversible axis

The escalator above governs reviewer _doubt_; a separate deterministic rule governs a reviewer _allow_ that meets proven-irreversible facts (a history rewrite, a recursive delete outside the working directory, a persistence install, an all-interfaces listener, credential-shaped data handed to a sender, a raw block copy). Every built-in rung raises such an allow to an ask; a `custom` row disposes it by its own `onIrreversibleEffect` (`allow`, `defer`, or `deny`, defaulting to `defer`), and the record names the facts (`floorFacts`) and the ruling (`floorRuling`). The ruling is not a rung on the suspicion line — doubt and proven irreversibility are different questions — so the custom cut lines cannot express it. The deterministic screen's hard deny stays terminal under every ruling. A custom `deny` refusal stays out of the denied panel: that panel answers "what did the reviewer refuse", the reviewer allowed, so the refusal lives in the audit record (`floorFacts` plus `floorRuling`) instead.

### Command facts

Deterministic facts read from the shell AST and the working directory alone — no model, no subprocess, no network. Every fact fails toward the conservative side: unreadable words, unparsable text, and hidden execution (`eval`, `$CMD`) widen scope to `unknown` and network to `restricted`. Scrutiny-raising facts fire on positive evidence only.

- `parsed` — whether the text parsed; false makes path and network facts conservative.
- `pathScope` — where touched paths lie: `inside`, `outside`, `scratch`, `none`, or `unknown`.
- `namedBuildOutput` — every path word names a build or cache output directory inside the project (closed single-command shape only).
- `recursive` — a removal reaches recursively.
- `publishesArtifact` — the command publishes (registry publish, image push, release creation, upload).
- `sensitivePathName` — a path matches the sensitive-name pattern (keys, credential stores, `.env`, private material).
- `publicSystemPath` — a read confined to code-recognized public system paths.
- `rewritesHistory` — amend, rebase, reset, filter-branch, restore, scoped checkout-discard, destructive clean, or branch deletion.
- `rawCopy` — a raw device copy (`dd` reads as `unknown` effect).
- `allInterfaces` — a listener binds all interfaces (loopback-only binds do not).
- `network` — `none`, `local`, `public`, or `restricted`; anything beyond provable literal local or public hosts is `restricted`.
- `dumpsEnvironment` — bare `printenv`/`set`, bare `env`, or `export`/`declare` with no assignments prints the environment.
- `installsPersistence` — writes to startup files, git hooks (including husky hooks: a write whose basename is a git hook name under `.husky/`), cron, systemd enablement, or autostart paths.
- `grantsBeyondOwner` — a `chmod` wording that sets any group or other permission bit. It reads the words only and cannot see the prior mode, so it states "this asks for a class wider than the owner", not "this widened the file"; it escalates only together with `sensitivePathName`, so `chmod +x build.sh` does not ask on its account.
- `authHeaderExpansion` — curl's `-H`/`--header` or wget's `--header` carrying an `Authorization`, `Proxy-Authorization`, or `X-Api-Key` value that is an unreadable expansion (`$VAL`, `$(…)`). States "an authentication value leaves unreadably", never "this is a credential"; escalates like `sendsData` (a named request still asks). Single-quoted values, ordinary headers, `Cookie`, wget's `-H` (`--span-hosts`), whole-word expansions, and file references stay out.
- `sendsData` — a network command in a sending shape: upload or POST flags, copy-to-host or remote-execution tools, or a URL carrying data (a non-literal expansion in a URL argument, a token-shaped query or path value, an encoded subdomain). A secret-named variable reaching a network command is not `sendsData`: it lifts the code effect to `send_out` instead, which the credential rows read as `guard` (releasable on a named request, not escalated).
- `commandEffect` — the closed verb table's vote: `read`, `modify`, `delete`, `send_out`, or `unknown`.
- `secretVariable` — a variable whose name marks a secret (`$GITHUB_TOKEN`) is expanded; bare in-process tests (`[ -n "$KEY" ]`) do not count.
- `headerToken` — a curl `-H`/`--header` or wget `--header` value carrying a literal token, read through the same field-proving scan as `authHeaderExpansion` (R8): the attached `-H<value>` spelling counts, `wget -H` (`--span-hosts`) does not.
- `routineDevCommand` — a single literal project build, test, or lint command the record recognizes by name. The name does not show what executes (a Makefile target, a plugin, a config file), so the running table still rates it a modification while the shared core rates it `unproven` — see Part II.

Whether a URL carries data follows the AST's `literal` flag, never a text scan for `$`: single-quoted `'$(...)'` is inert text, while double-quoted and bare expansions flow. `headerToken` likewise counts only literal token values. An unreadable expansion is covered by two routes. A secret-named variable lifts the code effect to `send_out`, which the credential rows read as `guard`. Any expansion in an `Authorization`, `Proxy-Authorization`, or `X-Api-Key` value sets `authHeaderExpansion`, which escalates: a named request still asks. The network layer independently treats a network command carrying an unreadable argument as going somewhere the record cannot prove and rates it `restricted`, so the row is `restricted-read` (`guard`) unless the header escalates it. Single-quoting the value makes it literal text and the reading returns to `public`; ordinary headers (`X-Request-Id`, `Content-Type`) and `Cookie` are not covered.

### Frozen items

- `confidenceThreshold` is `0.5` — **uncalibrated**. Do not move it without a calibration study on fresh data.
- No other thresholds exist. Do not add intent or risk knobs; the four-axis policy consumes none.
- Wording changes are subtractive only: remove redundancy and ambiguity, never add tool-name exceptions, exclusion clauses, or new categories to the prompt. Each question states what a reading is (positive inclusion); exemptions belong inside positive qualifiers, never as "as opposed to" contrasts.
- Deterministic interception belongs in the policy engine and facts, not in the prompt. The model is the semantic layer, not the gate.
- Uncertainty defers, never denies, for lack of intent alone; an entry whose fallback is deny still denies on clear evidence that the action exceeds scope.
- Defer reasons name the gap, then the one ask in parentheses; `lean` stays hidden from the operator.

## Part II — the shared core

Both lanes currently reach their own rulings from their own prose, and the same action can be denied by one lane and allowed by the other. The core replaces that with one decision function over two cleanly separated inputs: a deterministic base tier from facts, and model claims that may only tighten. The code decides; a lane never does. The core is built and tested, and not wired — `adr/0010-wiring-gates.md` states what must hold before it is.

```
screen (hard rules) | facts -> factTier(facts) = base tier          (code; trusted) model -> ModelClaim[]                          (lane; tighten-only) | decidePolicy({ base, claims, hasTrustedAnchor, completeness })  ->  mode mapping  -> verdict
```

- The **screen** runs first and alone owns hard-deny authority; its deny is never lifted, and upstream policy rules keep their own hard-deny authority.
- The **base tier is code**: `factTier` reads `CommandFacts` alone, so a release is always justified by facts.
- **Model claims only tighten**: a claim can raise danger or turn an unresolved concept into a defer, never open a release. A bad model reading costs an ask, not an allow.
- `decidePolicy` is pure: no I/O, no model, no clock.
- **No model verdict ever hard-denies**: a model deny is soft (`denyTier`).

### The two inputs

```ts
// Code: the deterministic baseline. Pure function of CommandFacts. interface FactRuling { tier: "block" | "escalator" | "unproven" | "guard" | "plain" | "free"; concept: PolicyConcept; }

// Model: a concept a lane reads. Tighten-only. type Presence = "confirmed" | "absent" | "unknown"; interface ModelClaim { concept: PolicyConcept; presence: Presence; confidence?: number; // 0–1, positive readings only }
```

There is no per-item `source` field to get wrong, and no merge of two sources: the base is always code, the claims are always the model. A single `Evidence[]` carrying a `source` tag would label a combination of a model reading and facts as `fact`, and make the release proof ambiguous.

Rules on claims:

- `unknown` is never benign. A guard, escalator, or block concept that could change the outcome and is not `absent` defers, leaning deny.
- `confidence` gates positive readings only. A `confirmed` reading with a missing or below-floor confidence becomes `unknown`, never `absent` and never trusted.
- A NaN confidence is not above the floor: the axes carry a missing value as `NaN`, and `NaN >= threshold` is false, so it is unresolved.
- Contradiction is `unknown`: a concept reported both `confirmed` and `absent` resolves to `unknown`, never to a release.
- The base tier is always defined, so a missing claim cannot release below the base. Facts are heuristics — they can prove a `free` read, not that no danger exists — so a lane that can omit concepts must declare the completeness below.
- An unresolved lane reading defers: when a lane's primary reading is below the confidence floor the adapter sets `laneUnresolved`, and the core defers without a lean.

### Concepts

Concept names are domain words, not `rowId`s (a `rowId` is an audit id, not a vocabulary). Same concept, one ruling, both lanes.

The code base (`factTier`; these decide the tier):

| concept                   | established when                                       | ruling    |
| ------------------------- | ------------------------------------------------------ | --------- |
| `credential_exposure`     | credential material read into the transcript           | block     |
| `credential_egress`       | credential material modified or sent off-machine       | guard     |
| `data_egress`             | non-credential data sent off-machine                   | escalator |
| `artifact_publish`        | artifact published to a registry or remote             | block     |
| `environment_dump`        | the environment itself is printed                      | block     |
| `device_overwrite`        | a raw write to a block device                          | guard     |
| `unbounded_deletion`      | a deletion whose extent the record cannot bound        | block     |
| `ordinary_deletion`       | any other deletion the record can bound                | guard     |
| `restricted_network_read` | a read reaching a non-local, non-public network        | guard     |
| `outside_workspace_read`  | a read outside the workspace                           | guard     |
| `persistence_install`     | autostart, hook, cron, or systemd enablement           | escalator |
| `history_rewrite`         | amend, rebase, reset, destructive clean, branch delete | escalator |
| `outward_listener`        | a listener binds all interfaces                        | escalator |
| `regenerable_output`      | a regenerable build-output deletion                    | free      |
| `public_system_read`      | a read of a code-recognized public system path         | free      |
| `other_read`              | any other read inside the workspace                    | free      |
| `workspace_modification`  | an ordinary in-workspace modification                  | plain     |
| `other_action`            | everything else                                        | guard     |

`other_action` carries `guard` or the `unproven` tier: a run or send whose target the code cannot show is `unproven` and asks even on a named anchor, while a bounded action the code identified — a raw device copy, an in-workspace deletion — is `guard`, which a named anchor releases.

Readings a lane may add (tighten-only; a lane may also re-claim a code concept to raise it):

| concept                 | established when                                                      | ruling         |
| ----------------------- | --------------------------------------------------------------------- | -------------- |
| `remote_code_execution` | fetched or remotely directed code is executed                         | escalator      |
| `resource_exhaustion`   | consumption an input or a remote party drives with no boundable limit | escalator      |
| `system_tampering`      | protection weakened or a privileged entry point created               | escalator      |
| `human_ban`             | a still-effective trusted instruction forbids the action              | deny           |
| `authorization_anchor`  | the trusted request names this action                                 | release gate   |
| `unreadable_action`     | the action cannot be read from the record                             | defer, neutral |

`human_ban` reads the **trusted instruction set** — the same source the `ban` axis reads, gated by the same confidence floor, so a below-floor reading is `unknown` and only defers. Its `deny` is soft (ADR 0006): hard-deny authority is the screen's and upstream rules', not the model's.

`remote_code_execution` and `resource_exhaustion` are concepts the four axes cannot express; a lane supplies them as claims. An AST fact for a fetch segment feeding an execute segment, and for an unbounded spawn, lets the code establish them — see the bounded list below.

### Precedence

A release of a `guard` or `plain` base needs three things: the base tier releases, the trusted record carries an anchor (`hasTrustedAnchor`, set by the pipeline and never by the model), and the model reports `authorization_anchor: confirmed`. A `free` base releases on its own. A model that claims an anchor the record does not hold releases nothing, and a model claim alone never releases.

First match wins:

1. **screen** deny → hard deny, outside `decidePolicy`.
2. `human_ban` confirmed and trusted → **deny** (`critical`); reported but unresolved → defer leaning deny.
3. the effective tier — the strictest of the base and the confirmed danger claims — is `block` → defer leaning deny (`critical`). A block is never released by an anchor.
4. a `block` concept `unknown` → defer leaning deny.
5. `unreadable_action` confirmed → defer, neutral.
6. any guard, escalator, or block concept `unknown` → defer leaning deny.
7. effective tier `escalator` → defer leaning deny, even with a named request.
8. **completeness gate**, only when the lane declares `every-applicable-concept-answered`: a required concept not answered → defer leaning deny.
9. effective tier `unproven` → defer leaning deny; a named anchor does not release it.
10. effective tier `guard` → allow on a named anchor, else defer leaning deny.
11. effective tier `plain` → allow on a named anchor, else defer leaning allow.
12. effective tier `free` → allow.

`block` here is a ruling tier, not a `rowId`. Nothing lifts a block down. `escalator` is the merged form of "guard plus an escalating fact": a named request that would otherwise release no longer does, and the audit row keeps the `+escalated` suffix.

### Completeness

The chat reply is sparse: a message that omits an applicable danger concept is indistinguishable from one that checked and found none. So a release carries a completeness condition, and `requiredConcepts(facts)` names the concepts a lane must positively address (`confirmed` or `absent`) for the action's shape:

| shape    | required concepts                                                          |
| -------- | -------------------------------------------------------------------------- |
| read     | `credential_exposure`, `restricted_network_read`, `outside_workspace_read` |
| delete   | `unbounded_deletion`                                                       |
| modify   | `credential_egress`                                                        |
| run/send | `other_action`, `data_egress`                                              |

Both adapters get the same release condition: the code base tier decides, and claims only tighten. The chat adapter declares `completeness: "every-applicable-concept-answered"`; the classifier declares `"axes-are-mandatory"` because its four axes are mandatory fields.

`remote_code_execution`, `resource_exhaustion`, and `system_tampering` are deliberately outside the required set, so the sparse lane's completeness gate never asks for them. That is a completeness statement only: the lane can complete a release without answering them, and a confirmed claim still tightens the tier. Until an AST fact covers them, a fetch-then-execute chain in chain form is rated by its code effect like any other run. A recognized routine command (`npm test`, `tsc`, `cargo test`) is read as a run for the same reason: its target, config, or test bodies stay unread even when the project declares the task, so the base is `unproven` and asks. `requiredConcepts` still returns `workspace_modification` for that shape, which an `unproven` base can never turn into a release; the entry records the lane contract, not a release path.

Two concepts read more narrowly than their names suggest when a lane claims them:

- `resource_exhaustion` is carried by consumption a record leaves without a boundable limit. It asks on a shape that spends without a bound an input or a remote party drives; a verb, a remote, or a named output file does not settle the bound either way. The code's own base for it is `unboundedSpawn` (`unproven`); a confirmed claim tightens it independently, as `escalator`.
- A move or rename is judged from its stated effects, and a stated overwrite or discard carries the concept the effect matches. `git branch -m` and `-M` currently classify as a `delete` effect in `command-facts.ts`, which records an existing classification short-cut.

### Release proof

A release is never justified by the anchor alone: the code must positively establish the action's bounded scope, and an anchor names what was asked without proving the action is bounded. There are four code outcomes:

- **Proven benign** (`free`): allow with no anchor — an in-workspace read of a non-sensitive path, a recognized public system read, a named build-output deletion.
- **Proven bounded** (`plain`): allow on a named anchor — an in-workspace non-sensitive write.
- **Proven identified but risky** (`guard`): ask, and a named anchor releases — an out-of-workspace read, a bounded source deletion, a credential modification.
- **Unproven** (`unproven`): ask, and a named anchor does not release — a run or send whose target the code cannot show, an unknown verb, unparsable text, a shell socket in an argument or a redirect (`/dev/tcp`, `/dev/udp`), a loop with no provable bound, a routine command (`npm test`, `tsc`, `pytest`) whose target, config, or test bodies the record cannot read even when it declares one, a modification whose path does not resolve (`> $TARGET`).

The code cannot prove the danger excluded, so only a human settles it. The model's `absent` is not a release basis either: a model that says a hazard is absent has not proven the action bounded. Claims tighten; only facts release. A socket carrying credential material is not merely unproven — it is `block` `credential_exposure`.

### Bounded AST detection

`unproven` makes an unrecognized run or send ask, which is the safe side. A bounded AST fact lets the code positively identify a danger shape so it escalates as danger rather than merely reading as unproven. The list is fixed and non-dataflow:

- **shell socket** (`socketRedirection`) — a `/dev/tcp` or `/dev/udp` path in an argument (`of=/dev/tcp/…`) or as a redirect target (`> /dev/tcp/…`), including a redirect-only command with no words, is `unproven` (a network write the parser cannot rate), or `block` `credential_exposure` when credential material rides along. A heredoc or here-string body is data, not a socket.
- **unbounded spawn** (`unboundedSpawn`) — a `while`, `until`, or C-style loop (its termination is not provable from the text), a loop that backgrounds a statement (`while true; do sleep 1 & done`), or a `for`/`select` whose item list is absent, glossed, braced, or expands (`for f in *.txt`, `for i in $(seq …)`) is `unproven`, `resource_exhaustion`. Only a `for` over a list of plain literals (`for i in 1 2 3`) stays bounded. `unproven` outranks a releasable `guard`, so an unbounded loop never releases even when it also carries credential material.
- **fetch then execute** (not detected) — a fetch verb (`curl`, `wget`, `git clone`) that writes a file and a later verb in the same chain that executes it (`bash`, `sh`, `node`, `python`, `source`, `./<path>`) are not correlated: the pipe form (`curl … | bash`) is a screen deny, and the chain form rates by its code effect like any other run.

Everything the list does not recognize stays `unproven`, and the fact never widens what may release. That is the parser's whole remit (ADR 0008): escalate or prove a bounded scope, never make a semantic guarantee.

### The screen is not an OS boundary

The screen hard-denies only the command shapes it explicitly lists, matching literal words against a fixed rule set. It is not an operating-system isolation boundary for arbitrary commands, and no host sandbox is enabled today, so the triage and semantic layers ask generously: the screen is a floor, not a guarantee. Wiring the core does not change this (ADR 0008).

### Where the core differs from the table

With the classifier claims adapter, `scripts/alignment-diff.ts` compares the core to the running policy on ideal labels: agreement everywhere but the 26 deliberate `unproven` movements, and no other difference (the counts live in `decisions.md`). The corpus contains no socket redirect, unbounded loop, unresolved modification, declared-body routine, so those movements are proven by unit tests rather than by that gate. The comparison uses ideal axis labels: it does not exercise a real model, the anchor gate from a real transcript, the full screen-to-verdict chain, or the two model-only concepts, so it is a design check and not an acceptance test (ADR 0010).

One deliberate tightening is outside the corpus: `tierOf` normalizes a routine run or read to a modification, so the table releases `npm test` on a named request; `factTier` rates the same command `unproven` and never releases it. A routine command that reads credential material therefore defers in the core where the table could release it.

Four shapes differ by design, because the core has a concept or a fact the table lacks:

| command                                              | table                                           | core                          |
| ---------------------------------------------------- | ----------------------------------------------- | ----------------------------- |
| `dd if=… of=$DEV …`                                  | classifier `unbounded_deletion`; chat Block     | `device_overwrite` → guard    |
| `curl …169.254.169.254/iam/…`                        | classifier block or guard depending on the read | `credential_exposure` → block |
| `curl -o /tmp/i.sh https://h/i.sh && bash /tmp/i.sh` | classifier allow, chat deny                     | `unproven` defer, not allow   |
| `curl … \| bash`                                     | screen deny                                     | screen deny, unchanged        |

Overturning any of these changes accepted behavior and the frozen oracle: that is a policy change, signed separately, never smuggled in as naming.

### Before the core can be adopted

`adr/0010-wiring-gates.md` holds the conditions. Two of them are ordinary migrations rather than gates: `chat instructions.replace` (a custom policy text in config) must migrate to policy configuration or be declared an authorized breaking change, and adopting a behavior change needs a set frozen before the change.
