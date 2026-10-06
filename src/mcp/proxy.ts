import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { gate, formatConsent, thresholdRank, type GateOptions } from './gate.ts';
import type { McpToolDefinition } from './adapt.ts';
import { manifestCoverage, unmatchedManifestTools } from './manifest.ts';
import { duplicateKeys, rawId } from './json.ts';

/**
 * A stdio MCP proxy. It sits between a client and a real MCP server, learns the
 * tool definitions from `tools/list`, and gates every `tools/call`.
 *
 * Deliberately not a policy engine: the default is to refuse anything at or
 * above the threshold and return the consent card as the error, so the person
 * on the other side sees what was about to happen and why it stopped. A host
 * with a real approval channel supplies `approve`.
 */

interface JsonRpc {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ProxyOptions extends GateOptions {
  /** Ask a human. Returning false refuses the call. */
  approve?: (card: string) => Promise<boolean>;
}

export function startProxy(command: string, args: string[], options: ProxyOptions = {}) {
  // A threshold that is not a severity is refused before the server is even
  // spawned, rather than on every call: see thresholdRank.
  thresholdRank(options.threshold);

  // stderr is inherited so the wrapped server's own diagnostics still reach
  // the operator rather than being swallowed by the proxy.
  const server = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  // A command that does not exist is the commonest first mistake. Without this
  // it surfaces as an unhandled 'error' event and a stack trace.
  server.on('error', (e) => {
    console.error(`airlock: could not start '${command}': ${e.message}`);
    process.exit(127);
  });

  /** Tool definitions learned from the server's own `tools/list` response. */
  const tools = new Map<string, McpToolDefinition>();
  /** Which of our in-flight requests were `tools/list`, so we can read the reply. */
  const listRequests = new Set<number | string>();
  /**
   * Clients pipeline. A `tools/call` can reach us before the `tools/list`
   * *response* that would tell us what the tool is, and gating on an empty
   * catalogue would refuse perfectly ordinary calls. So a call for an unknown
   * tool waits for any list already in flight before it is judged.
   */
  /** The manifest-names warning is said once, not on every tools/list. */
  let warnedUnmatched = false;
  let reportedCoverage = false;
  const listWaiters: Array<() => void> = [];
  const releaseListWaiters = () => {
    while (listWaiters.length > 0) listWaiters.shift()!();
  };
  /** Client messages are handled in the order they arrived, not as they resolve. */
  let queue: Promise<void> = Promise.resolve();

  /**
   * An error reply to the client, with the request's id written exactly as the client
   * wrote it. Going through JSON.stringify would round a 64-bit integer id, and the
   * client could not then match the reply to its request. `idText` is the raw text, or
   * undefined for a message with none.
   */
  const reply = (idText: string | undefined, error: { code: number; message: string; data?: unknown }) => {
    process.stdout.write(`{"jsonrpc":"2.0","id":${idText ?? 'null'},"error":${JSON.stringify(error)}}\n`);
  };

  // --- server → client: learn tool definitions on the way past ---------------
  createInterface({ input: server.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    let message: JsonRpc;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(line + '\n');
      return;
    }

    if (message.id !== undefined && listRequests.has(message.id)) {
      listRequests.delete(message.id);
      const result = message.result as { tools?: McpToolDefinition[] } | undefined;
      // The list is the server's output, and a malformed entry — a null, or one
      // with no name — must not throw here: this handler also forwards the reply
      // below, so a throw would drop the whole tools/list and leave the client
      // (and any call waiting on it) hanging. A nameless definition is nothing we
      // can gate a call against, so it is skipped, not learned.
      for (const def of result?.tools ?? []) {
        if (def && typeof def === 'object' && typeof def.name === 'string') tools.set(def.name, def);
      }
      if (listRequests.size === 0) {
        const unmatched = unmatchedManifestTools(options.declaredEffects, tools.keys());
        if (unmatched.length > 0 && !warnedUnmatched) {
          warnedUnmatched = true;
          console.error(`airlock: the manifest declares effects for ${unmatched.map((t) => `'${t}'`).join(', ')}, which the server does not offer; check the spelling.`);
        }
        if (!reportedCoverage && Object.keys(options.declaredEffects ?? {}).length > 0) {
          reportedCoverage = true;
          const { reviewed, unreviewed } = manifestCoverage(options.declaredEffects, tools.keys());
          console.error(`airlock: manifest covers ${reviewed.length} of ${tools.size} tool(s)` + (unreviewed.length > 0 ? `; judged by name and schema alone: ${unreviewed.join(', ')}` : '.'));
        }
        releaseListWaiters();
      }
    }

    // The server's own line, untouched: re-serialising it would round any integer
    // above 2^53 in a result, or in an id the client is waiting on.
    process.stdout.write(line + '\n');
  });

  // --- client → server: gate tools/call --------------------------------------
  createInterface({ input: process.stdin }).on('line', (line) => {
    queue = queue.then(() => handleClientLine(line)).catch(() => {});
  });

  async function handleClientLine(line: string): Promise<void> {
    if (!line.trim()) return;
    // Whatever reaches the server has to have been read here first. A line this
    // parser rejects used to be forwarded as it was, but a server whose parser is
    // more forgiving (a trailing comma, a comment) would accept it and run a
    // tools/call the gate never saw. An unreadable line is a protocol error, so it
    // is answered as one and goes no further.
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      reply(undefined, { code: -32700, message: 'Airlock: that line is not valid JSON, so it was not forwarded.' });
      return;
    }
    // A JSON-RPC batch is an array of requests. It has no `method` of its own, so
    // it used to fall through as "not a tools/call" and be forwarded whole, with
    // any tools/call inside it ungated. Judging each member would mean answering
    // with a batch of our own; the current MCP spec dropped batching, so it is
    // refused instead.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      reply(undefined, { code: -32600, message: 'Airlock: only a single JSON-RPC request per line is forwarded (a batch is refused, because its calls cannot each be judged).' });
      return;
    }
    const message = parsed as JsonRpc;
    const idText = rawId(line);

    // The client's line is forwarded exactly as written (below), so the server's own
    // parser decides what it means. JSON.parse keeps the last of two identical keys and
    // some parsers keep the first, so a repeated key could be read here as one request
    // and there as another. Nothing legitimate repeats a key; ambiguous text is refused.
    const repeated = duplicateKeys(line);
    if (repeated.length > 0) {
      reply(idText, { code: -32600, message: `Airlock: the request repeats the key ${repeated.map((k) => JSON.stringify(k)).join(', ')}; parsers disagree about which one wins, so it was not forwarded.` });
      return;
    }

    if (message.method === 'tools/list' && message.id !== undefined) {
      listRequests.add(message.id);
    }

    // Forwarded as written, not re-serialised: JSON.stringify(JSON.parse(x)) rounds an
    // integer above 2^53, so the server used to be handed a different message_id than
    // the agent sent, and acted on a different record than the one the person approved.
    const forward = () => server.stdin.write(line + '\n');

    if (message.method !== 'tools/call') {
      forward();
      return;
    }

    const name = String(message.params?.name ?? '');
    const args = (message.params?.arguments ?? {}) as Record<string, unknown>;

    if (!tools.has(name) && listRequests.size > 0) {
      await new Promise<void>((resolve) => listWaiters.push(resolve));
    }
    const def = tools.get(name);

    if (!def) {
      // A call to a tool we never saw declared. Refusing is the only safe move:
      // nothing can be derived about a tool whose schema was never seen.
      reply(idText, { code: -32602, message: `Airlock: refusing '${name}' — no tool definition was seen for it.` });
      return;
    }

    // Judging a call must never let it through by failing. The gate's default
    // is refusal; an internal error — a thrown narrator, a resolver that raised
    // — is no exception. Without this, such a throw reached the queue's catch
    // and the call was dropped: neither forwarded nor refused, the client left
    // waiting forever with no card and no error. Fail closed, and say why.
    let decision;
    try {
      decision = await gate(def, { id: String(message.id ?? name), tool: name, args }, options);
    } catch (e) {
      reply(idText, { code: -32000, message: `Airlock refused '${name}': the call could not be judged (${(e as Error).message}).` });
      return;
    }

    if (!decision.requiresApproval) {
      forward();
      return;
    }

    const card = formatConsent(decision);
    // A host approval callback that throws is treated as no approval, not as a
    // reason to drop the call.
    let approved = false;
    try {
      approved = options.approve ? await options.approve(card) : false;
    } catch {
      approved = false;
    }

    if (approved) {
      forward();
      return;
    }

    reply(idText, {
      code: -32000,
      message: `Airlock withheld this call pending approval.\n\n${card}`,
      data: { severity: decision.facts.severity, signals: decision.facts.signals },
    });
  }

  return { server, tools };
}
