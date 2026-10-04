# Contributing

The most useful thing you can send is a real tool definition the deriver reads
wrong: one whose effect it misses, or one it flags when nothing dangerous is
there. Open an issue with the tool's name, its JSON schema, and what the call
actually does — a definition nobody here wrote is worth more than a crafted one,
because that is where the defects the home-made tests cannot see come from.

## How it works

- `src/core/derive.ts` works out the facts of a call — what it touches, how many,
  whether it leaves the machine and where to, whether it can be undone — from the
  tool schema and the arguments. No model runs here.
- `src/core/verify.ts` holds the one-way checks: a narration may overstate the
  danger and may never understate it.
- `src/mcp/adapt.ts` turns an MCP tool definition into something derivable, and
  reports what it could not learn (`adaptationGaps`). It never trusts a definition
  to be well formed — the server is the party the gate does not trust.

## Running it

```bash
npm test     # the full suite (TypeScript runs directly, Node 22+)
npm run lint # tsc --noEmit
```

`npm run audit` scores the deriver against 36 real tool definitions. The effect
vocabulary is deliberately finite and English: please do **not** add a verb just
because `npm run unrecognised` lists it — that corpus is held out to measure the
gap, and tuning on it would make the number meaningless. If a tool the vocabulary
cannot read matters to you, write it into a manifest (`examples/manifest.json`)
instead: that covers your tool without touching the measurement.

## In plain words

Write anything a person reads — the consent card, messages, docs — so it says
what a call does and why, not how. One idea per sentence. Put the plain meaning
next to any number.
