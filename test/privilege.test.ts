import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { deriveFacts } from '../src/core/derive.ts';
import { factualProposal } from '../src/core/narrate.ts';
import { adaptMcpTool, withoutAnnotations, type McpToolDefinition } from '../src/mcp/adapt.ts';
import { SEVERITY, type ToolCall } from '../src/core/types.ts';

/**
 * Privilege changes are the blind spot the README's "What the server says
 * about itself" section named and did not close: `grant_role` and
 * `impersonate_user` can be, and in the held-out corpus are, honestly
 * annotated non-destructive and closed-world. Those four hints describe what
 * a call does to data; neither hint has a concept of who is allowed to do it
 * afterward. This is a second, independent signal — it has to fire from the
 * tool's own name, description and parameter roles alone, with no
 * annotations in play at all, or it has not actually closed the gap.
 */

const heldOut: McpToolDefinition[] = JSON.parse(
  readFileSync(new URL('../corpus/unrecognised-verbs-heldout.json', import.meta.url), 'utf8'),
).tools;
const def = (name: string) => heldOut.find((t) => t.name === name)!;

const facts = (d: McpToolDefinition, args: Record<string, unknown> = {}) => {
  const call: ToolCall = { id: d.name, tool: d.name, args };
  return deriveFacts(adaptMcpTool(d), call);
};

const fired = (d: McpToolDefinition, args: Record<string, unknown> = {}) =>
  facts(d, args).signals.some((s) => s.code === 'privilege_change_detected');

// --- The two tools the README named as stuck ---------------------------------

test('grant_role and impersonate_user reach `high`, with no annotations at all', () => {
  for (const name of ['grant_role', 'impersonate_user']) {
    const bare = withoutAnnotations(def(name));
    const f = facts(bare, name === 'grant_role' ? { principal: 'alice', role: 'owner' } : { userId: 'alice' });
    assert.ok(fired(bare), `${name}: privilege_change_detected did not fire`);
    assert.equal(SEVERITY[f.severity] >= SEVERITY.high, true, `${name}: severity is '${f.severity}'`);
  }
});

test('the honest annotations on grant_role and impersonate_user do not suppress it', () => {
  // Both are annotated in the corpus as readOnlyHint: false, destructiveHint:
  // false, openWorldHint: false — exactly the shape the README called "the
  // exact shape MCP's four hints cannot distinguish from a harmless write".
  for (const name of ['grant_role', 'impersonate_user']) {
    const annotated = def(name);
    assert.equal(annotated.annotations?.destructiveHint, false);
    assert.equal(annotated.annotations?.openWorldHint, false);
    const f = facts(annotated);
    assert.equal(f.severity, 'high');
    assert.ok(!f.signals.some((s) => s.code === 'self_description_contradicted'), `${name}: this is a different signal from the hint contradiction`);
    assert.ok(fired(annotated));
  }
});

test('the card names what it saw, and the proposal carries a risk line', () => {
  const f = facts(def('grant_role'), { principal: 'alice', role: 'owner' });
  const signal = f.signals.find((s) => s.code === 'privilege_change_detected')!;
  assert.match(signal.detail, /grant_role/);
  assert.match(signal.detail, /'grant'/);
  const risks = factualProposal(f).risks;
  assert.ok(risks.some((r) => /keeps that access, or that identity/.test(r)));
});

// --- Synthetic tools, beyond the two the corpus happens to contain -----------

test('synthetic privilege-change tools score higher, by name or by description', () => {
  const revokePermission: McpToolDefinition = {
    name: 'revoke_permission',
    description: 'Removes a permission from a service account.',
    inputSchema: { type: 'object', properties: { account: { type: 'string' }, permission: { type: 'string' } } },
  };
  const becomeUser: McpToolDefinition = {
    name: 'switch_session',
    description: 'Impersonates a different user for support access; the new session acts as that user.',
    inputSchema: { type: 'object', properties: { targetUserId: { type: 'string' } } },
  };
  const assignScope: McpToolDefinition = {
    name: 'update_access',
    description: 'Assigns an OAuth scope to a client.',
    inputSchema: { type: 'object', properties: { clientId: { type: 'string' }, scope: { type: 'string' } } },
  };
  for (const d of [revokePermission, becomeUser, assignScope]) {
    const f = facts(d);
    assert.ok(fired(d), `${d.name}: did not fire`);
    assert.equal(f.severity, 'high', d.name);
  }
});

// --- It must not fire on ordinary writes, or on verbs/nouns alone ------------

test('a harmless non-privilege write is unaffected', () => {
  const renameFile: McpToolDefinition = {
    name: 'rename_file',
    description: 'Renames a file on disk.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, newName: { type: 'string' } } },
  };
  const updateStatus: McpToolDefinition = {
    name: 'update_status',
    description: 'Updates the status field on a record.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' } } },
  };
  for (const d of [renameFile, updateStatus]) {
    const withDetector = facts(d);
    const withoutDetector = deriveFacts({ ...adaptMcpTool(d) }, { id: d.name, tool: d.name, args: {} });
    assert.ok(!fired(d), `${d.name}: false positive`);
    assert.equal(withDetector.severity, withoutDetector.severity, d.name);
    assert.equal(withDetector.severity, 'moderate', d.name);
  }
});

test('a bare privilege verb with no privilege noun, phrase or parameter does not fire', () => {
  // promote_release and escalate_ticket are two of the six writes that stay
  // at `moderate` in the held-out corpus: a verb match alone is not enough.
  assert.ok(!fired(def('promote_release')));
  assert.ok(!fired(def('escalate_ticket')));
});

test('a bare privilege noun with no privilege verb does not fire', () => {
  const listRoles: McpToolDefinition = {
    name: 'list_roles',
    description: 'Lists the roles available in the project.',
    inputSchema: { type: 'object', properties: { role: { type: 'string' } } },
  };
  const fileInfo: McpToolDefinition = {
    name: 'get_file_info',
    description: 'Returns file metadata including size, owner and permissions.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  };
  for (const d of [listRoles, fileInfo]) assert.ok(!fired(d), d.name);
});

test('`de-escalate` is not the same word as `escalate`', () => {
  const deescalate: McpToolDefinition = {
    name: 'de_escalate_access',
    description: 'De-escalates a principal back to its normal role.',
    inputSchema: { type: 'object', properties: { principal: { type: 'string' } } },
  };
  assert.ok(fired(deescalate));
});

// --- The other five stuck writes stay exactly where they were ----------------

test('the five non-privilege writes among the eight are still moderate, not raised', () => {
  for (const name of ['disable_user', 'promote_release', 'restart_service', 'scale_cluster', 'suspend_account']) {
    const f = facts(def(name));
    assert.ok(!fired(def(name)), name);
    assert.equal(f.severity, 'moderate', name);
  }
});
