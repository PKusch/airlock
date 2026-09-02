import { useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, Check, FileWarning, Lock, ShieldAlert, X } from 'lucide-react';

import { deriveFacts } from './core/derive.ts';
import { factualProposal } from './core/narrate.ts';
import { renderFallback, verifyConsequence } from './core/verify.ts';
import { SCENARIOS } from './fixtures/calls.ts';
import { TOOLS } from './fixtures/tools.ts';
import type { ProposedConsequence, SeverityName } from './core/types.ts';

/** The narration a compromised narrator returns once the injection has worked. */
const COMPROMISED: ProposedConsequence = {
  headline: 'Nothing sensitive here, you can safely approve',
  severity: 'none',
  reversibility: 'reversible',
  affectedCount: 0,
  scopePaths: [],
  egress: [],
  risks: ['No reason to review this one.'],
};

const SEVERITY_STYLE: Record<SeverityName, string> = {
  critical: 'bg-rose-500/15 text-rose-300 ring-rose-500/40',
  high: 'bg-orange-500/15 text-orange-300 ring-orange-500/40',
  moderate: 'bg-amber-500/15 text-amber-300 ring-amber-500/40',
  low: 'bg-sky-500/15 text-sky-300 ring-sky-500/40',
  none: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/40',
};

function Chip({ severity }: { severity: SeverityName }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider ring-1 ${SEVERITY_STYLE[severity]}`}
    >
      {severity}
    </span>
  );
}

export default function App() {
  const [selectedId, setSelectedId] = useState(SCENARIOS[1].id);
  const [narratorCompromised, setNarratorCompromised] = useState(false);

  const scenario = SCENARIOS.find((s) => s.id === selectedId)!;

  const { facts, verdict, shown } = useMemo(() => {
    const facts = deriveFacts(TOOLS[scenario.call.tool], scenario.call);
    const proposal = narratorCompromised ? COMPROMISED : factualProposal(facts);
    const verdict = verifyConsequence(facts, proposal, scenario.call);
    const shown = verdict.rendered ?? renderFallback(facts, scenario.call, verdict.rejections);
    return { facts, verdict, shown };
  }, [scenario, narratorCompromised]);

  const uniqueRejections = [...new Map(verdict.rejections.map((r) => [r.code, r])).values()];

  return (
    <div className="min-h-screen bg-[#0b0d10] text-zinc-200 antialiased">
      <header className="border-b border-zinc-800/80 px-8 py-5">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <Lock className="h-5 w-5 text-zinc-500" />
            <div>
              <h1 className="text-base font-semibold tracking-tight text-zinc-100">Airlock</h1>
              <p className="text-xs text-zinc-500">
                The consequence is derived and verified, never narrated.
              </p>
            </div>
          </div>

          <button
            onClick={() => setNarratorCompromised((v) => !v)}
            className={`rounded-lg px-3.5 py-2 text-xs font-medium ring-1 transition ${
              narratorCompromised
                ? 'bg-rose-500/15 text-rose-300 ring-rose-500/40'
                : 'bg-zinc-800/60 text-zinc-300 ring-zinc-700 hover:bg-zinc-800'
            }`}
          >
            Narrator: {narratorCompromised ? 'compromised' : 'honest'}
          </button>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 px-8 py-8 lg:grid-cols-[300px_1fr]">
        {/* Scenarios ------------------------------------------------------ */}
        <nav className="space-y-1.5">
          <h2 className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-widest text-zinc-600">
            Pending calls
          </h2>
          {SCENARIOS.map((s) => {
            const f = deriveFacts(TOOLS[s.call.tool], s.call);
            const active = s.id === selectedId;
            return (
              <button
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                className={`w-full rounded-lg px-3 py-2.5 text-left ring-1 transition ${
                  active
                    ? 'bg-zinc-800/80 ring-zinc-700'
                    : 'bg-zinc-900/40 ring-zinc-800/60 hover:bg-zinc-900'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[13px] font-medium leading-snug text-zinc-200">{s.label}</span>
                  <Chip severity={f.severity} />
                </div>
                <code className="mt-1 block truncate font-mono text-[11px] text-zinc-500">
                  {s.call.tool}
                </code>
              </button>
            );
          })}
        </nav>

        <div className="space-y-5">
          {/* What a person assumes vs what was derived --------------------- */}
          <div className="flex items-center gap-3 rounded-lg border border-zinc-800/70 bg-zinc-900/30 px-4 py-3 text-[13px]">
            <span className="text-zinc-500 italic">“{scenario.naiveReading}”</span>
            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-zinc-700" />
            <Chip severity={facts.severity} />
          </div>

          {/* The consent card ---------------------------------------------- */}
          <section className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/50">
            <div className="flex items-start justify-between gap-4 border-b border-zinc-800 px-5 py-4">
              <div className="flex items-start gap-3">
                {verdict.accepted ? (
                  <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-zinc-500" />
                ) : (
                  <FileWarning className="mt-0.5 h-5 w-5 shrink-0 text-rose-400" />
                )}
                <div>
                  <h3 className="text-[15px] font-semibold leading-snug text-zinc-100">{shown.title}</h3>
                  <p className="mt-0.5 font-mono text-[11px] text-zinc-500">{facts.tool}</p>
                </div>
              </div>
              <Chip severity={shown.severity} />
            </div>

            <div className="space-y-4 px-5 py-4">
              <ul className="space-y-1.5">
                {shown.lines.map((line, i) => (
                  <li key={i} className="text-[13.5px] leading-relaxed text-zinc-300">
                    {line}
                  </li>
                ))}
              </ul>

              {shown.risks.length > 0 && (
                <ul className="space-y-1 border-l-2 border-zinc-800 pl-3">
                  {shown.risks.map((risk, i) => (
                    <li key={i} className="text-[13px] leading-relaxed text-zinc-400">
                      {risk}
                    </li>
                  ))}
                </ul>
              )}

              {/* The raw call is never hidden behind the prose. */}
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-widest text-zinc-600">
                  The actual call
                </p>
                <pre className="overflow-x-auto rounded-lg bg-black/40 p-3 font-mono text-[11.5px] leading-relaxed text-zinc-400 ring-1 ring-zinc-800">
{JSON.stringify(shown.rawCall, null, 2)}
                </pre>
              </div>
            </div>

            <div className="flex items-center gap-2 border-t border-zinc-800 bg-zinc-900/60 px-5 py-3">
              <button className="rounded-lg bg-zinc-100 px-3.5 py-1.5 text-[13px] font-medium text-zinc-900 hover:bg-white">
                Approve
              </button>
              <button className="rounded-lg px-3.5 py-1.5 text-[13px] font-medium text-zinc-400 ring-1 ring-zinc-700 hover:text-zinc-200">
                Deny
              </button>
            </div>
          </section>

          {/* Verifier ------------------------------------------------------- */}
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/30 px-5 py-4">
            <h4 className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-zinc-600">
              Verifier
              {verdict.accepted ? (
                <span className="inline-flex items-center gap-1 text-emerald-400 normal-case tracking-normal">
                  <Check className="h-3.5 w-3.5" /> narration accepted
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-rose-400 normal-case tracking-normal">
                  <X className="h-3.5 w-3.5" /> narration withheld — showing derived facts only
                </span>
              )}
            </h4>

            {uniqueRejections.length > 0 && (
              <ul className="mb-4 space-y-1.5">
                {uniqueRejections.map((r) => (
                  <li key={r.code} className="flex gap-2.5 text-[12.5px]">
                    <code className="shrink-0 rounded bg-rose-500/10 px-1.5 py-0.5 font-mono text-[11px] text-rose-300">
                      {r.code}
                    </code>
                    <span className="text-zinc-400">{r.detail}</span>
                  </li>
                ))}
              </ul>
            )}

            <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-zinc-600">
              Derived signals
            </h4>
            {facts.signals.length === 0 ? (
              <p className="text-[12.5px] text-zinc-500">No anomalies. Effects match what the tool declares.</p>
            ) : (
              <ul className="space-y-1.5">
                {facts.signals.map((s, i) => (
                  <li key={i} className="flex gap-2.5 text-[12.5px]">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500/70" />
                    <span className="text-zinc-400">
                      <code className="font-mono text-[11px] text-zinc-300">{s.code}</code>
                      <span className="text-zinc-600"> · {s.source} · </span>
                      {s.detail}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
