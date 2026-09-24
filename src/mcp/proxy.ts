import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { gate, formatConsent, type GateOptions } from './gate.ts';
import type { McpToolDefinition } from './adapt.ts';

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
  const listWaiters: Array<() => void> = [];
  const releaseListWaiters = () => {
    while (listWaiters.length > 0) listWaiters.shift()!();
  };
  /** Client messages are handled in the order they arrived, not as they resolve. */
  let queue: Promise<void> = Promise.resolve();

  const send = (stream: NodeJS.WritableStream, message: JsonRpc) => {
    stream.write(JSON.stringify(message) + '\n');
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
      for (const def of result?.tools ?? []) tools.set(def.name, def);
      if (listRequests.size === 0) releaseListWaiters();
    }

    send(process.stdout, message);
  });

  // --- client → server: gate tools/call --------------------------------------
  createInterface({ input: process.stdin }).on('line', (line) => {
    queue = queue.then(() => handleClientLine(line)).catch(() => {});
  });

  async function handleClientLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let message: JsonRpc;
    try {
      message = JSON.parse(line);
    } catch {
      server.stdin.write(line + '\n');
      return;
    }

    if (message.method === 'tools/list' && message.id !== undefined) {
      listRequests.add(message.id);
    }

    if (message.method !== 'tools/call') {
      send(server.stdin, message);
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
      send(process.stdout, {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32602,
          message: `Airlock: refusing '${name}' — no tool definition was seen for it.`,
        },
      });
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
      send(process.stdout, {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32000,
          message: `Airlock refused '${name}': the call could not be judged (${(e as Error).message}).`,
        },
      });
      return;
    }

    if (!decision.requiresApproval) {
      send(server.stdin, message);
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
      send(server.stdin, message);
      return;
    }

    send(process.stdout, {
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: -32000,
        message: `Airlock withheld this call pending approval.\n\n${card}`,
        data: { severity: decision.facts.severity, signals: decision.facts.signals },
      },
    });
  }

  return { server, tools };
}
