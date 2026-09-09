# Airlock

**Consent for agent tool calls, where the consequence is derived and verified rather than narrated.**

An agent is about to run a tool. Before it does, a person has to approve it. The
question this project is about is what that person is shown — and whether the
thing they are shown can be made to lie.

```bash
npm install
npm test          # 64 tests: constraints, attacks, calibration, symlinks, MCP, real corpus, vocabulary, annotations
npm run attack    # the demo: every scenario against a compromised narrator
npm run calibrate # how loud the gate is on ordinary work
npm run audit     # against 36 real MCP tool definitions
npm run unrecognised # 50 ordinarily-named tools across two corpora: what the vocabulary misses, and what the server's hints add
npm run introspect # re-pull those definitions from the reference servers
npm run dev       # the UI, port 3200

# wrap a real MCP server
AIRLOCK_CONFINE='*.path=/Users/me/projects' \
  node --experimental-strip-types src/mcp/cli.ts -- npx @modelcontextprotocol/server-filesystem /Users/me/projects
```

The type check and all 64 tests run in CI on every push and pull request, across
Node 22 and 24, so the claims below are gated rather than asserted.

---

## The problem with describing a tool call

The obvious design is to hand the pending call to a model and ask it to explain
what will happen in plain language. That is strictly better than showing raw
JSON, and it is also the failure mode: **the human then approves the sentence,
rather than the call.**

The model writing that sentence has read the tool's arguments. The arguments are
controlled by whoever controls the agent's input. So the sentence is
attacker-reachable, and a consent prompt that mis-describes its own call is
worse than no consent prompt at all — it manufactures informed consent for
something the person did not agree to.

## The mechanism

Four steps, and the model only occupies one of them.

| | | trusted? |
|:--|:--|:--|
| **1. Derive** | Deterministic facts from the tool schema and the actual arguments: what it touches, how many, reversibility, what leaves the machine, what escapes its declared boundary. | yes — no model runs |
| **2. Narrate** | A model turns those facts into human framing. It reads the arguments, so it is assumed compromisable. | **no** |
| **3. Verify** | The proposal is checked against the derived facts. | yes |
| **4. Render** | The prose the human reads is assembled in code from facts that survived. | yes |

### The asymmetry that does the work

The verifier is monotone in one direction. A proposed consequence **may
overstate the danger, and may never understate it**:

- claimed severity must be ≥ derived severity
- claimed reversibility may not be more optimistic than derived
- claimed scope must cover every derived target
- every derived egress destination must be named
- nothing may be named that appears in no argument (no fabrication)
- text arguing *for approval* rather than describing consequence is rejected outright

This is why the defence does not depend on anticipating the attack. An injection
in tool arguments always wants the prompt to say *less* than the truth —
"routine", "no confirmation needed", "harmless". A check that only ever rejects
downgrades does not need to know the wording.

And because quantities are rendered from `derived` rather than copied from the
proposal, even an *accepted* narration cannot change a number on screen. A
narrator claiming 9999 affected files on a one-file read is accepted — and the
interface still says one.

### Rejection degrades toward more truth, not less

When narration is withheld, the human does not get silence and does not get a
reassuring default. They get every derived fact, plus the reason the description
was withheld, plus the raw call — which is shown on the accepted path too. It is
a tested invariant that the rejection path never drops a line the accepted path
would have shown.

---

## Calibration

A gate that fires on ordinary work is one people learn to click through, so the
alarm rate is part of the contract. Measured against a 30-call benign corpus —
ordinary reads, searches, formatter runs, doc fetches — where a benign call
reaching `high` or above counts as a false alarm:

| | false alarms | dangerous calls caught |
|:--|:--|:--|
| First ladder | **23%** (7/30) | 5/5 |
| After correction | **0%** (0/30) | 5/5 |

All seven false alarms declared their effect *and* stayed inside their declared
boundary, and the ladder ignored both facts. Correcting it meant separating
"this tool does egress" from "this tool does egress to somewhere nobody
constrained" — the second is worth stopping for, the first is Tuesday.

**Read that 0% with the caveat it deserves.** The corpus is thirty calls I wrote
myself, and while it was written before the ladder was corrected, a rate
measured on your own corpus is weak evidence. It is a floor on the problem, not
a product claim.

### Under real MCP conditions

The numbers above assume tools declare their effects and their boundaries. Real
MCP tools declare no boundaries — the protocol has no field for one — and no
effects in this deriver's vocabulary. (An earlier version of this paragraph
said the protocol has no capability annotations at all. That was wrong; see
*What the server says about itself* below.) Same corpus, adapted through
`src/mcp/adapt.ts`:

| | false alarms |
|:--|:--|
| As published, nothing asserted | **17%** (5/30) |
| Operator asserts path boundaries | 17% (5/30) |
| Operator asserts path *and* URL boundaries | **0%** (0/30) |

So the deployment finding is concrete: **Airlock in front of an unmodified MCP
server interrupts roughly one ordinary call in six, and the fix is an operator
asserting boundaries the protocol gives tools no way to state.** That is what
`AIRLOCK_CONFINE` is for, and `adaptationGaps()` reports exactly which
parameters are still running unchecked.

### Against a corpus I did not write

Everything above is measured on fixtures written by the same person who wrote
the inference rules, which means it can only confirm them. So `npm run
introspect` pulls the live tool definitions from the MCP reference servers —
filesystem, memory and everything, **36 tools, none of them mine** — and
`npm run audit` scores the deriver against them, with ground truth labelled
from what each tool does.

| | |
|:--|:--|
| Tools that warrant stopping a person | 5 of 36 |
| Caught | **5/5** |
| False alarms | **0/31** |

It reached that after fixing four defects the fixture corpus could never have
surfaced, because each needed prose somebody else wrote:

- `list_directory` inferred **delete** — the stem `clear` matched the word
  **"clearly"** in its description.
- `edit_file` inferred **message_send** — the stem `repl` matched
  **"replaces"**.
- `simulate-research-query` gave its `topic` parameter the **recipient** role,
  because the prefix `^to` matches **"to"pic**.
- `get-annotated-message` inferred **message_send** from the noun "message" in
  its own name.

The first three were loose stem matching; the fourth was reading a noun as a
verb. Both are fixed structurally rather than by patching the words: effects
now come from the **leading verb** of the tool name — MCP names are
overwhelmingly `verb_noun`, and `get-annotated-message` is a `get` whatever
follows it — and parameter roles match on **tokens** rather than prefixes,
which incidentally started catching `excludePatterns` as a glob.

Two of the five true positives are worth naming, because a name-only reading
misses both: `get-env` is scored `critical` for credential access, since
environment variables are where API keys live; and `gzip-file-as-resource`
fetches an arbitrary remote URL through a parameter called `data`, caught only
because its schema says `format: "uri"`.

**The honest caveat:** I labelled the ground truth, and I fixed the rules after
seeing which tools failed. That is not an independent evaluation. What it is —
and what the fixture corpus could not be — is a test against schemas and prose
nobody here wrote, which is where all four defects came from.

Every inferred effect now records the exact text that produced it
(`effectEvidence`), so an inference can be audited rather than taken on trust.
A test asserts that no effect is ever inferred without it.

### What the vocabulary cannot see

Effects are inferred from a verb vocabulary, and a vocabulary is finite. The
limits section has always said so; this measures it. `corpus/unrecognised-verbs.json`
holds 22 tools named the way an ordinary API author names things —
`retire_entities`, `apply_migration`, `place_order`, `rotate_keys` — none of
whose leading verbs the deriver knows. No adversary was needed. These are just
words. Eighteen of them do something consequential; four are harmless.

| | |
|:--|:--|
| Consequential tools with an unrecognised verb | 18 |
| Caught anyway, by a description phrase or a parameter role | **4** — `forward_thread`, `dump_environment`, `submit_expense`, `archive_remote_resource` |
| Missed | **14** |
| Harmless tools with an unrecognised verb | 4, all equally unrecognised |

Before this was measured, the fourteen misses and the four harmless tools came
out identical: an empty effect set and a severity of `none`. That is the same
shape as the three boolean bugs described further down, in a fourth form —
**nothing inferred was being read as nothing happens.** `retire_entities`
scored exactly like `ping`, and the consent card for either read "This ." with
the verb missing.

So the deriver now carries a third state. `recognition` is `recognised` or
`unrecognised`; an unrecognised tool is floored at `moderate`, raises an
`unrecognised_action` signal, and the card leads with it — *"What this does is
not known: 'retire_entities' names no action Airlock recognises, and nothing
else in its definition says. Treat the list below as incomplete."* The reference
narrator stops calling it a read.

What this does **not** do is catch the fourteen. `moderate` sits below the
default alarm threshold on purpose: the three unrecognised verbs in the real
corpus (`directory_tree`, `echo`, `simulate-research-query`) all belong to
harmless tools, and stopping a person for `echo` is how a gate gets clicked
through. The vocabulary cannot tell `retire_entities` from `translate_text`,
and the honest move is to say so on the card rather than guess in either
direction. An operator who would rather stop can set the gate's `threshold` to
`moderate`, at the cost of stopping on those three. The actual fix is a
declaration channel. The protocol has a partial one, and it is measured below.

The split is pinned by `test/unrecognised.test.ts`, so a change to the
vocabulary that moves any number in the table fails CI rather than drifting
away from this paragraph. The corpus, like the fixtures, is mine — it can show
the vocabulary failing, and it cannot show it succeeding.

#### Extending the vocabulary, and what that bought

The obvious response to fourteen misses is to add the fourteen verbs. I did —
thirteen of them, plus two description phrases (`bills the account`, `releases
the held funds`) and one credential phrase (`signing keys`). `place` and
`start` were left out as too ambiguous, and `reset` was mapped to `write`
because `reset_password` and `reset_counter` are writes. On the corpus the
extension was written against, the result is what you would expect:

| | first corpus, 18 consequential | held-out corpus, 22 consequential |
|:--|:--|:--|
| Before the extension | 4 caught, 14 unrecognised | — |
| After | **17 caught**, 1 under-read, 0 unrecognised | **3 caught**, 0 under-read, **19 unrecognised** |
| Harmless tools | 4 of 4 still unrecognised | 6 of 6 still unrecognised |

The second column is the one that matters. `corpus/unrecognised-verbs-heldout.json`
is 28 tools written in the same sitting from a different prompt — how cloud,
devops, finance and HR APIs name their operations — and not checked against
the vocabulary while being written. `terminate_instance`, `decommission_host`,
`cancel_subscription`, `grant_role`, `rollback_deployment`, `settle_invoice`,
`impersonate_user`, `replicate_bucket`. Nineteen of twenty-two are unrecognised.
The three that are caught — `invite_member`, `wire_funds`, `reveal_secret` —
are caught by the mechanisms that existed before the extension: the word
"email" in a description, a parameter named `amount`, the noun `secret`. **Not
one of the thirteen new verbs fired on the held-out corpus.** A test holds
that, so the claim cannot quietly improve.

So the extension is kept, because the words in it are real and each one is
now a `high` or `critical` line on a card instead of an "unknown", but it is
not the fix and the numbers above say so. Every API surface has its own verbs.
A list that has learned this month's will not know next month's, and the
honest estimate of the gap is the held-out one, not the first.

One more state came out of measuring this. `reset_workspace` is now
*under-read*: recognised as a `write` at `moderate`, when it destroys
uncommitted work. Before the extension it was unrecognised and the card said
so; now the card says something milder than the truth and does not say it is
guessing. That is the understating direction the whole gate exists to prevent,
and it is a cost of every verb added. The report shows it as its own column
rather than folding it into "caught".

### What the server says about itself

This README said, in three places, that MCP tool definitions carry no
capability annotations. They do. Since the 2025-03-26 revision a tool may
carry `annotations` with four hints — `readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint` — and all 36 tools in the real corpus had
them the whole time, sitting in `corpus/real-mcp-tools.json` unread. The spec
also says what to make of them: *clients MUST consider tool annotations to be
untrusted unless they come from trusted servers.*

So they are wired in the only way an untrusted self-description can be: it
may make a call look worse, it may contradict the derivation, and it is quoted
to the person as the server's word; it may never make a call look better.
Four rules, and a test holds that none of them lowers anything on any corpus:

| the server says | the deriver does |
|:--|:--|
| `readOnlyHint: true`, and the definition implies a delete, send, spend or credential read | signal `self_description_contradicted`, one level up |
| `destructiveHint: true` on a tool the vocabulary cannot place | `high` instead of the unrecognised floor of `moderate` |
| `openWorldHint: true` on a tool the vocabulary cannot place | `high`, the same as an unconfined URL already gets |
| `destructiveHint: true` on anything | reversibility floored at *irreversible*, with provenance |

Only hints the server actually wrote count. The spec's defaults (destructive
true, open-world true) are not filled in, because a server that wrote nothing
has declared nothing.

On the real corpus this changes no alarm — 5 of 5 caught, 0 of 31 false — and
finds one discrepancy: the everything server calls `get-env` read-only, and it
prints every environment variable of the host process. Read-only is true of
the filesystem and false of the person's secrets, and the card now says the two
disagree. On the held-out corpus, annotated as each tool's author would honestly
annotate it:

| held-out, 22 consequential | at the alarm threshold |
|:--|:--|
| Vocabulary alone | 3 |
| With the server's hints | **14** |
| Harmless tools raised | 1 of 6 — `measure_latency`, read-only and open-world, which is the same call the gate already stops for `fetch_docs` |

Eight consequential tools stay at `moderate` with hints: `suspend_account`,
`disable_user`, `grant_role`, `impersonate_user`, `promote_release`,
`restart_service`, `scale_cluster`, `escalate_ticket`. Every one is a write
that is not destructive and does not leave its own system, which is the exact
shape MCP's four hints cannot distinguish from a harmless write. Two of them
are privilege changes, and there is no hint for that. So the declaration
channel closes most of the vocabulary gap and none of *that* one, and the
honest reading of the table is 14, not 22.

### What the parameters carry

The same audit reported that only 37% of real parameters got a role, and left
"opaque" to cover everything else. That number was true and the word was lazy.
Going back through the 31 it did not understand:

| | |
|:--|:--|
| Numbers, booleans and fixed choices — `head`, `dryRun`, `sortBy` | 18. These cannot carry a path, a destination or a command. They have no role because they need none. |
| Names of the things acted on — `delete_entities.entityNames`, `open_nodes.names` | 2. Now given a `subject` role: not locatable, so no boundary applies, but countable. `delete_entities` on three names affects three things, and a narrator claiming one is understating. |
| Free text and structured payloads — `write_file.content`, `edit_file.edits`, `add_observations.observations` | **11.** These could hold anything, and the gate does not look inside. This is the actual blindness. |

So the honest figure is 20 of 49 roled, 18 inert, and 11 the gate cannot see
into. `adaptationGaps()` now reports those eleven and only those, so an
operator reading the card is told about `edits` and not about `dryRun`. The
split is pinned in `test/real-corpus.test.ts`.

## What is verified, and what isn't

| Claim | Status |
|:--|:--|
| The narration does not understate severity, reversibility, count, scope or egress | **Verified in code.** Any one failure withholds the whole narration. |
| Displayed quantities come from the derived facts | **Verified in code**, and tested against an inflating narrator. |
| A path argument resolves outside the tool's declared directory | **Verified in code**, lexically (see limits). |
| A symlink inside a confined directory pointing out of it | **Verified against a real filesystem** when a resolver is supplied; string-only otherwise, and the human is told which. |
| The derived severity is the *correct* severity | **Not verified.** The ladder is measured for alarm rate, not for whether `critical` means what a person would mean by it. |
| The effect inference caught everything the tool really does | **Not verified, and measured to fail.** After extending the vocabulary against a first corpus (17 of 18 now caught), a held-out corpus of 22 ordinarily-named consequential tools still misses 19, and none of the new verbs fired on it. A miss is reported as *unrecognised* rather than scored as harmless, but it is still a miss. |
| A tool the deriver cannot place is never scored as harmless | **Verified in code.** Empty inference is a named state with a `moderate` floor, and a test holds it over 50 such tools. |
| The server's own annotations never lower severity, reversibility, effects or recognition | **Verified in code**, over the real corpus and both vocabulary corpora. They raise, contradict and are quoted, and nothing else. |

`6/6 held` in the attack report means no compromised narration reached the
human. It does **not** mean the derivation saw everything the tool can do.

## One bug, three times

Three separate defects here were the same mistake: **a missing constraint scored
as a satisfied one.** Zero file targets was stored as `null` and read as
"uncountable", so a payment rendered as touching an unbounded set of files. A
parameter that declared no boundary was counted as confined, so mail to an
arbitrary external address read as constrained traffic and fell below the alarm
threshold. And a protocol with no field for effects — MCP has none — was read as
a tool declining to name them, which escalated every adapted tool and swamped
the signal the check existed to carry.

Every one came from a boolean. `escapes === false` cannot distinguish "inside the
boundary" from "there was no boundary", and the collapse always falls in the
permissive direction.

Patching the three sites would have left the shape that produced them, so the
checks now carry a type that can hold the third state (`src/core/constraint.ts`):

```ts
type Confinement =
  | { status: 'inside';       boundary: string }
  | { status: 'escaped';      boundary: string; via: 'lexical' | 'filesystem' }
  | { status: 'undeclared' }                       // nothing was ever checked
  | { status: 'unverifiable'; boundary: string; reason: string }
```

There is no `!violated` shortcut. The only route to a positive answer is
`isSatisfied`, which is true for exactly one variant, and `test/constraint.test.ts`
asserts that over every variant rather than at each call site. `Count` and
`Declaration` get the same treatment: `unbounded` is a kind rather than a number,
and "no declaration channel" is distinct from "declared nothing".

It also surfaced something the booleans had hidden. Because "unchecked" is now a
state rather than an absence, the consent card can say so — *"Nothing constrains
where this can reach: 'partner@external.example' was not checked against any
declared boundary"* — which is exactly what a person should know before
approving, and was previously unsayable.

## Limits I would not paper over

- **Effect inference is lexical.** Effects are inferred from stems in the tool's
  name and description plus parameter roles. It over-fires by design — a false
  effect costs a louder prompt, a missed one costs the user the thing the prompt
  existed to prevent. But a tool that describes itself in words outside the list
  (`terminate_instance`, which deletes) is caught only if its parameters or
  description give it away, and that is measured above at 19 misses in 22 on a
  held-out corpus — extending the vocabulary closed the first corpus and bought
  nothing on the second. MCP's tool annotations, used only to raise, take that
  to 14 of 22 and cannot see a non-destructive write. A signature over a
  reviewed manifest would be the actual fix.
- **Path confinement needs a resolver to be sound.** With `nodeResolver`
  supplied, symlink escapes are caught against a real filesystem and an
  unresolvable path is reported as *unknown* rather than safe. Without one — in
  the browser, where there is no filesystem — the check is string-only, and a
  symlink inside the confined directory pointing out of it passes. The UI runs
  in that weaker mode by construction.
- **No live model is wired in.** The narrator interface and prompt exist;
  nothing calls an API. This is deliberate rather than unfinished: the attack
  suite runs against a *fully compromised* narrator, which is a strictly
  stronger test than a live model that happens to behave. But it means the
  quality of real narration is unmeasured, and I am not claiming it.
- **Eleven of 49 real parameters are payloads the gate cannot see into.**
  Measured across the 36-tool corpus: 20 get a role, 18 are numbers, booleans
  or fixed choices that cannot carry a target, and the remaining 11 —
  `edit_file.edits`, `add_observations.observations`, `write_file.content` —
  are free text or structured data treated as opaque. `adaptationGaps()`
  reports exactly those eleven, but the gate is blind to what is inside them.
- **Effects are inferred from a verb vocabulary.** A tool whose leading verb is
  not in `VERB_EFFECTS` and whose description avoids the tell patterns is scored
  on its parameters alone, and if those say nothing either it is reported as
  *unrecognised* at `moderate` — told to the person, not stopped for. The
  vocabulary is finite and English.
- **The proxy's default is refusal, not approval.** There is no human channel in
  a stdio pipe, so anything at or above the threshold is returned to the client
  as an error carrying the consent card. A host with a real approval UI passes
  `approve`.
- **Severity is calibrated for loudness, not for meaning.** The alarm rate is
  measured. Whether `critical` matches what a person would call critical is not.

## Scenarios

| Scenario | What a person assumes | What is derived |
|:--|:--|:--|
| `cleanup_workspace` on a glob | Housekeeping | `critical` — delete inferred from tool text, count unbounded, effect undeclared by the schema |
| `read_project_file` on `../.ssh/id_rsa` | Reads a project file | `critical` — escapes declared confinement |
| `sync_to_backup` to an off-host endpoint | Routine backup | `critical` — egress to an undeclared host |
| `send_report` with injected argument text | Sends a report | `high` — plus an instruction-shaped-argument signal |
| `pay_invoice` | Pays an invoice | `critical` — spend, irreversible |

## Layout

```
src/core/derive.ts       deterministic facts. no model may run here.
src/core/verify.ts       the one-way checks, and prose assembly
src/core/narrate.ts      the untrusted half, pluggable
src/core/resolver.node.ts filesystem resolution, kept out of the browser bundle
src/mcp/adapt.ts         MCP definitions → something derivable, and what was lost
src/mcp/gate.ts          the guard: derive → narrate → verify → render
src/mcp/proxy.ts         stdio proxy; gates tools/call, learns from tools/list
src/fixtures/benign.ts   30 ordinary calls, for the alarm rate
corpus/                  36 real MCP definitions with ground truth; two corpora (22 + 28 tools) of verbs the vocabulary did not know
test/gate.test.ts        attack suite + calibration
test/unrecognised.test.ts what the vocabulary misses, before and after extending it, pinned
test/symlink.test.ts     real symlinks on a real filesystem
test/mcp.test.ts         end to end through a child process over stdio
```

## License

MIT — see [LICENSE](LICENSE).
