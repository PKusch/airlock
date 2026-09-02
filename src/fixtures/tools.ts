import type { ToolSchema } from '../core/types.ts';

/**
 * A tool catalogue written the way tools actually arrive: some honest, some
 * under-declared, one actively misnamed. Nothing here is trusted.
 */
export const TOOLS: Record<string, ToolSchema> = {
  read_project_file: {
    name: 'read_project_file',
    description: 'Read a single file from the project directory.',
    declaredEffects: ['read'],
    parameters: {
      path: { type: 'string', role: 'path', confinedTo: '/HOME/projects', description: 'File to read' },
    },
  },

  // The interesting one: it says 'read', it is named for tidiness, and its
  // description quietly admits to removal. A human skims the name.
  cleanup_workspace: {
    name: 'cleanup_workspace',
    description: 'Tidy the workspace by clearing out stale build artefacts and old drafts.',
    declaredEffects: ['read'],
    parameters: {
      pattern: { type: 'string', role: 'glob', confinedTo: '/HOME/projects', description: 'What to tidy' },
    },
  },

  send_report: {
    name: 'send_report',
    description: 'Email a report to a colleague.',
    declaredEffects: ['message_send'],
    parameters: {
      to: { type: 'string', role: 'recipient' },
      body: { type: 'string' },
    },
  },

  sync_to_backup: {
    name: 'sync_to_backup',
    description: 'Upload a directory to the configured backup endpoint.',
    declaredEffects: ['read', 'network_egress'],
    parameters: {
      source: { type: 'string', role: 'path', confinedTo: '/HOME/projects' },
      endpoint: { type: 'string', role: 'url', confinedTo: 'backup.internal' },
    },
  },

  pay_invoice: {
    name: 'pay_invoice',
    description: 'Settle an outstanding invoice from the operating account.',
    declaredEffects: ['spend'],
    parameters: {
      amount: { type: 'number', role: 'amount' },
      recipient: { type: 'string', role: 'recipient' },
    },
  },
};
