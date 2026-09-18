# Security

Airlock exists to stop a person being shown a false picture of what an agent is
about to do. So the bugs that matter most here are not crashes. They are cases
where the consent screen says less than the truth.

## What counts as a vulnerability

Please report it if you can make any of these happen:

- **A milder description than the facts.** A tool call whose consent text
  understates what it touches, how many things, whether it can be undone, or
  where data goes. This is the main promise of the project, so it is the main
  thing worth breaking.
- **A narrator that gets past the verifier.** Wording proposed by the model that
  is accepted even though it sounds milder than the facts derived in code.
- **A boundary that does not hold.** A path, host or recipient that escapes the
  confinement it was given, for example through a symlink, a `..` segment, or a
  value hidden inside a nested argument.
- **A hint that lowers the danger.** An MCP annotation or tool description that
  makes a call look safer. Server-supplied hints are meant to be able to raise
  the level of concern and never lower it.
- **A call that is not recognised and is let through quietly.** Unfamiliar tool
  names are meant to be treated with suspicion, not waved past.

Ordinary bugs, wording you would phrase differently, or tools the vocabulary does
not recognise yet are welcome as normal issues. `npm run unrecognised` already
lists the known gaps.

## How to report

Use GitHub's private report: open the **Security** tab of this repository and
choose **Report a vulnerability**. Please do not open a public issue for a bypass
until it is fixed.

A good report has the tool definition, the arguments, what Airlock showed, and
what it should have shown. A failing test in the style of `test/attack-report.ts`
is the fastest possible way to make the point.

## What to expect

This is a one-person project, so there is no formal response time. A report that
comes with a reproduction gets read promptly. A confirmed bypass is fixed with a
regression test that fails before the fix, and the fix is credited to whoever
found it unless they would rather it were not.

## Supported versions

Only the latest commit on `main` is supported. There are no tagged releases.
