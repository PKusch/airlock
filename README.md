# Airlock

**Consent for agent tool calls, where the consequence is derived and verified rather than narrated.**

An agent is about to run a tool. Before it does, a person has to approve it. The
question this project is about is what that person is shown — and whether the
thing they are shown can be made to lie.

```bash
npm install
npm test          # 45 tests: constraints, attacks, calibration, symlinks, MCP, real corpus
npm run attack    # the demo: every scenario against a compromised narrator
npm run calibrate # how loud the gate is on ordinary work
npm run audit     # against 36 real MCP tool definitions
npm run introspect # re-pull those definitions from the reference servers
npm run dev       # the UI, port 3200

# wrap a real MCP server
AIRLOCK_CONFINE='*.path=/Users/me/projects' \
  node --experimental-strip-types src/mcp/cli.ts -- npx @modelcontextprotocol/server-filesystem /Users/me/projects
```

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
MCP tools declare neither — the protocol has no field for either. Same corpus,
adapted through `src/mcp/adapt.ts`:

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

## What is verified, and what isn't

| Claim | Status |
|:--|:--|
| The narration does not understate severity, reversibility, count, scope or egress | **Verified in code.** Any one failure withholds the whole narration. |
| Displayed quantities come from the derived facts | **Verified in code**, and tested against an inflating narrator. |
| A path argument resolves outside the tool's declared directory | **Verified in code**, lexically (see limits). |
| A symlink inside a confined directory pointing out of it | **Verified against a real filesystem** when a resolver is supplied; string-only otherwise, and the human is told which. |
| The derived severity is the *correct* severity | **Not verified.** The ladder is measured for alarm rate, not for whether `critical` means what a person would mean by it. |
| The effect inference caught everything the tool really does | **Not verified.** It is lexical (see limits). |

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
  (`harmonise_state`, which deletes) is caught only if its parameters give it
  away. Real capability annotations, or a signature over a reviewed manifest,
  would be the actual fix.
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
- **Only 37% of real parameters get a role.** Measured across the 36-tool
  corpus: 18 of 49. The rest — `edit_file.edits`, `add_observations.observations`,
  `write_file.content` — are treated as opaque data, so nothing about them is
  checked. `adaptationGaps()` reports every one rather than letting it pass
  quietly, but the gate is blind to what is inside them.
- **Effects are inferred from a verb vocabulary.** A tool whose leading verb is
  not in `VERB_EFFECTS` and whose description avoids the tell patterns is scored
  on its parameters alone. The vocabulary is finite and English.
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
test/gate.test.ts        attack suite + calibration
test/symlink.test.ts     real symlinks on a real filesystem
test/mcp.test.ts         end to end through a child process over stdio
```

## License

MIT.
