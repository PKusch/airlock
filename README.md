# Airlock

**Consent for agent tool calls, where the consequence is derived and verified rather than narrated.**

An agent is about to run a tool. Before it does, a person has to approve it. The
question this project is about is what that person is shown — and whether the
thing they are shown can be made to lie.

```bash
npm install
npm test      # 13 tests, including the attack suite
npm run attack   # the demo: every scenario against a compromised narrator
npm run dev      # the UI, port 3200
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

## What is verified, and what isn't

| Claim | Status |
|:--|:--|
| The narration does not understate severity, reversibility, count, scope or egress | **Verified in code.** Any one failure withholds the whole narration. |
| Displayed quantities come from the derived facts | **Verified in code**, and tested against an inflating narrator. |
| A path argument resolves outside the tool's declared directory | **Verified in code**, lexically (see limits). |
| The derived severity is the *correct* severity | **Not verified.** It is a heuristic ladder, uncalibrated. |
| The effect inference caught everything the tool really does | **Not verified.** It is lexical (see limits). |

`6/6 held` in the attack report means no compromised narration reached the
human. It does **not** mean the derivation saw everything the tool can do.

## Limits I would not paper over

- **Effect inference is lexical.** Effects are inferred from stems in the tool's
  name and description plus parameter roles. It over-fires by design — a false
  effect costs a louder prompt, a missed one costs the user the thing the prompt
  existed to prevent. But a tool that describes itself in words outside the list
  (`harmonise_state`, which deletes) is caught only if its parameters give it
  away. Real capability annotations, or a signature over a reviewed manifest,
  would be the actual fix.
- **Path confinement is string-level, not filesystem-level.** `normalisePath`
  resolves `..` lexically. A symlink *inside* the confined directory pointing
  out of it escapes confinement with no `..` anywhere in the argument, and this
  code would not notice. Resolving against a real filesystem is the fix, and it
  is not done.
- **No live model is wired in.** The narrator interface and prompt exist;
  nothing calls an API. This is deliberate rather than unfinished: the attack
  suite runs against a *fully compromised* narrator, which is a strictly
  stronger test than a live model that happens to behave. But it means the
  quality of real narration is unmeasured, and I am not claiming it.
- **No MCP integration.** Calls come from a fixture catalogue. Sitting this in
  front of a real MCP client is the next piece of work, and until it is done
  this demonstrates a mechanism rather than shipping a guard.
- **Severity is not calibrated.** The ladder is a defensible guess. Nobody has
  measured whether `critical` matches what a person would call critical.

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
src/core/derive.ts    deterministic facts. no model may run here.
src/core/verify.ts    the one-way checks, and prose assembly
src/core/narrate.ts   the untrusted half, pluggable
src/fixtures/         tool catalogue and scenarios
test/gate.test.ts     13 tests, incl. a fully compromised narrator
test/attack-report.ts npm run attack
```

## License

MIT.
