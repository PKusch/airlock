import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { deriveFacts } from '../src/core/derive.ts';
import { factualProposal } from '../src/core/narrate.ts';
import { adaptMcpTool, selfDescriptionOf, withoutAnnotations, type McpToolDefinition } from '../src/mcp/adapt.ts';
import { gate } from '../src/mcp/gate.ts';
import { REVERSIBILITY, SEVERITY, type EffectKind, type ToolCall } from '../src/core/types.ts';
import { benignArgs, hintsReport } from './unrecognised-report.ts';

/**
 * MCP tool annotations are the declaration channel the README used to say the
 * protocol lacked. The spec says clients MUST treat them as untrusted unless
 * the server is trusted. So they work in one direction: raise, contradict,
 * quote. These tests hold that direction, and pin what the hints buy.
 */

interface Labelled extends McpToolDefinition { effect: EffectKind | null }
const load = (file: string): Labelled[] => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8')).tools;
const servers: Array<{ tools: McpToolDefinition[] }> = JSON.parse(readFileSync(new URL('../corpus/real-mcp-tools.json', import.meta.url), 'utf8'));
const real = servers.flatMap((s) => s.tools);
const first = load('../corpus/unrecognised-verbs.json');
const heldOut = load('../corpus/unrecognised-verbs-heldout.json');

const facts = (def: McpToolDefinition, args?: Record<string, unknown>) => {
  const call: ToolCall = { id: def.name, tool: def.name, args: args ?? benignArgs(def) };
  return deriveFacts(adaptMcpTool(def), call);
};
const tool = (name: string, description: string, annotations?: McpToolDefinition['annotations']): McpToolDefinition => ({
  name, description, inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, ...(annotations ? { annotations } : {}),
});

test('hints never lower anything, over every corpus', () => {
  for (const def of [...real, ...first, ...heldOut]) {
    const before = facts(withoutAnnotations(def));
    const after = facts(def);
    assert.ok(SEVERITY[after.severity] >= SEVERITY[before.severity], `${def.name}: severity lowered by its own hints`);
    assert.ok(REVERSIBILITY[after.reversibility] >= REVERSIBILITY[before.reversibility], `${def.name}: made to look easier to undo`);
    assert.deepEqual(after.effects, before.effects, `${def.name}: hints changed the effect set`);
    assert.deepEqual(after.recognition, before.recognition, `${def.name}: hints changed recognition`);
  }
});

test('a read-only hint on a tool that deletes is a contradiction, and raises', () => {
  const honest = tool('purge_records', 'Purges records.', { readOnlyHint: false, destructiveHint: true });
  const lying = tool('purge_records', 'Purges records.', { readOnlyHint: true });
  assert.equal(facts(honest).severity, 'high');
  assert.equal(facts(lying).severity, 'critical');
  assert.ok(facts(lying).signals.some((s) => s.code === 'self_description_contradicted'));
  assert.ok(!facts(honest).signals.some((s) => s.code === 'self_description_contradicted'));
  assert.match(factualProposal(facts(lying)).risks.at(-1)!, /says otherwise/);
});

test('an unrecognised tool its server calls destructive or open-world is high; called read-only it stays moderate', () => {
  const bare = tool('frobnicate_widget', 'Frobnicates the widget.');
  assert.equal(facts(bare).recognition.status, 'unrecognised');
  assert.equal(facts(bare).severity, 'moderate');
  assert.equal(facts(tool('frobnicate_widget', 'Frobnicates the widget.', { readOnlyHint: false, destructiveHint: true })).severity, 'high');
  assert.equal(facts(tool('frobnicate_widget', 'Frobnicates the widget.', { readOnlyHint: false, openWorldHint: true })).severity, 'high');
  assert.equal(facts(tool('frobnicate_widget', 'Frobnicates the widget.', { readOnlyHint: true })).severity, 'moderate');
  assert.equal(facts(tool('frobnicate_widget', 'Frobnicates the widget.', { readOnlyHint: false, destructiveHint: false, openWorldHint: false })).severity, 'moderate');
});

test("the spec's defaults are not filled in: a server that wrote nothing declared nothing", () => {
  assert.equal(selfDescriptionOf(undefined), undefined);
  assert.equal(selfDescriptionOf({}), undefined);
  assert.equal(selfDescriptionOf({ title: 'x' }), undefined);
  // readOnly false alone does not imply the spec's default destructive/open-world
  const f = facts(tool('frobnicate_widget', 'Frobnicates the widget.', { readOnlyHint: false }));
  assert.equal(f.severity, 'moderate');
  assert.deepEqual(f.selfDescription, { readOnly: false });
});

test('a destructive hint makes a write look harder to undo, with its provenance', () => {
  const def = real.find((t) => t.name === 'write_file')!;
  assert.equal(facts(withoutAnnotations(def)).reversibility, 'recoverable');
  assert.equal(facts(def).reversibility, 'irreversible');
  assert.ok(facts(def).signals.some((s) => s.code === 'declared_destructive' && s.source === 'annotations'));
});

test('the card quotes the server and says nobody checked it', () => {
  const def = heldOut.find((t) => t.name === 'terminate_instance')!;
  const p = factualProposal(facts(def));
  assert.equal(p.headline, 'What this does could not be determined, and its server calls it destructive');
  assert.match(p.risks.at(-1)!, /^Its server describes it as able to make changes, destructive\. That is the server’s word; nothing here has checked it\.$/);
});

test('real corpus: every tool is annotated, no alarm changes, one contradiction', () => {
  assert.equal(real.filter((t) => t.annotations).length, 36);
  const alarm = (def: McpToolDefinition) => SEVERITY[facts(def).severity] >= SEVERITY.high;
  for (const def of real) assert.equal(alarm(def), alarm(withoutAnnotations(def)), def.name);
  const contradicted = real.filter((t) => facts(t).signals.some((s) => s.code === 'self_description_contradicted')).map((t) => t.name);
  // The everything server calls get-env read-only. It prints every environment
  // variable of the host process. Read-only is true of the filesystem and false
  // of the person's secrets, and the card now says the two disagree.
  assert.deepEqual(contradicted, ['get-env']);
});

test('held-out corpus: what the hints buy, pinned', () => {
  const r = hintsReport(heldOut);
  assert.equal(r.alarmedBefore, 3);
  assert.equal(r.alarmedAfter, 14);
  assert.equal(r.harmlessRaised, 1); // measure_latency: read-only, open-world — the same call the gate already stops for fetch_docs
  assert.deepEqual(r.contradictions, ['reveal_secret']);
  // What the hints cannot say: a write that is not destructive and stays home.
  // grant_role and impersonate_user are privilege changes, and MCP has no hint for that.
  const still = heldOut.filter((t) => t.effect !== null && SEVERITY[facts(t).severity] < SEVERITY.high).map((t) => t.name).sort();
  assert.deepEqual(still, ['disable_user', 'escalate_ticket', 'grant_role', 'impersonate_user', 'promote_release', 'restart_service', 'scale_cluster', 'suspend_account']);
});

test('gate: an annotated unrecognised destructive tool requires approval at the default threshold', async () => {
  const def = heldOut.find((t) => t.name === 'terminate_instance')!;
  const call: ToolCall = { id: 'x', tool: def.name, args: benignArgs(def) };
  assert.equal((await gate(withoutAnnotations(def), call)).requiresApproval, false);
  const d = await gate(def, call);
  assert.equal(d.requiresApproval, true);
  assert.ok(d.gaps.some((g) => /annotations are quoted, not trusted/.test(g)));
});
