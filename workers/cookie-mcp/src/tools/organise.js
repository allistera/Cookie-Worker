import * as z from 'zod';
import { ToolInputError } from '../results.js';

const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const labelRow = z.object({ id: z.string() }).passthrough();

/**
 * Builds a body from `entries`, keeping only the keys whose value was provided.
 * @param {Record<string, unknown>} entries
 */
function provided(entries) {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));
}

/** @type {import('./types.js').ToolDefinition[]} */
export const tools = [
  {
    name: 'cookie_update_message',
    title: 'Update an email',
    description:
      'Changes an email’s state and labels: done = archive out of the inbox; trashed = move to trash; ' +
      'spam records the owner’s verdict; snoozeUntil (ISO datetime) hides it until then, null clears the snooze. ' +
      'Label ids come from cookie_list_labels (user labels only).',
    inputSchema: z.object({
      id: z.string().uuid().describe('Message id'),
      unread: z.boolean().optional(),
      starred: z.boolean().optional(),
      done: z.boolean().optional(),
      trashed: z.boolean().optional(),
      spam: z.boolean().optional(),
      snoozeUntil: z.string().datetime({ offset: true }).nullable().optional(),
      addLabelIds: z.array(z.string().uuid()).max(20).optional(),
      removeLabelIds: z.array(z.string().uuid()).max(20).optional(),
    }),
    outputSchema: z.object({
      message: z.object({ id: z.string() }).passthrough(),
      labels: z.array(z.record(z.string(), z.unknown())).optional(),
    }),
    annotations: { ...WRITE, idempotentHint: true },
    async run(args, api) {
      const { id, addLabelIds = [], removeLabelIds = [] } = args;
      const flags = provided({
        is_unread: args.unread,
        is_starred: args.starred,
        is_archived: args.done,
        is_deleted: args.trashed,
        is_spam: args.spam,
        scheduled_for: args.snoozeUntil,
      });
      const hasFlags = Object.keys(flags).length > 0;
      if (!hasFlags && addLabelIds.length === 0 && removeLabelIds.length === 0) {
        throw new ToolInputError('Give at least one change');
      }

      const patchResult = hasFlags ? await api.messages.patch('/messages', { id, ...flags }) : null;

      // Sequential on purpose: each label action rewrites the message's search
      // document, so concurrent calls could index a stale label set.
      /** @type {any} */
      let labelResult = null;
      for (const [action, ids] of [
        ['add_label', addLabelIds],
        ['remove_label', removeLabelIds],
      ]) {
        for (const labelId of ids) {
          labelResult = await api.messages.post('/messages', {
            id,
            action,
            label_id: labelId,
          });
        }
      }

      return {
        message: patchResult?.message ?? { id },
        ...(labelResult ? { labels: labelResult.labels } : {}),
      };
    },
  },
  {
    name: 'cookie_list_labels',
    title: 'List labels',
    description: 'Lists the owner’s labels with their ids, colours and message counts.',
    inputSchema: z.object({}),
    outputSchema: z.object({ labels: z.array(z.record(z.string(), z.unknown())) }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async run(_args, api) {
      const body = await api.labels.get('/labels');
      return {
        labels: (body.labels ?? []).map((/** @type {any} */ l) => ({
          id: l.id,
          name: l.name,
          color: l.color,
          kind: l.kind,
          description: l.description,
          autoApply: l.auto_apply,
          messageCount: l.message_count,
        })),
      };
    },
  },
  {
    name: 'cookie_create_label',
    title: 'Create a label',
    description:
      'Creates a user label. Fails if the name already exists or the label limit is reached.',
    inputSchema: z.object({
      name: z.string().min(1).max(50),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .default('#6b7280')
        .describe('Hex colour such as #6b7280'),
      description: z.string().max(200).optional(),
    }),
    outputSchema: z.object({ label: labelRow }),
    annotations: { ...WRITE, idempotentHint: false },
    async run({ name, color, description }, api) {
      const body = await api.labels.post('/labels', { name, color, description });
      return { label: body.label };
    },
  },
  {
    name: 'cookie_update_label',
    title: 'Update a label',
    description:
      'Renames or recolours a user label, edits its description, or toggles auto-apply for new mail.',
    inputSchema: z.object({
      id: z.string().uuid().describe('Label id'),
      name: z.string().min(1).max(50).optional(),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional(),
      description: z.string().max(200).optional(),
      autoApply: z.boolean().optional(),
    }),
    outputSchema: z.object({ label: labelRow }),
    annotations: { ...WRITE, idempotentHint: true },
    async run({ id, name, color, description, autoApply }, api) {
      const changes = provided({ name, color, description, auto_apply: autoApply });
      if (Object.keys(changes).length === 0) throw new ToolInputError('Give at least one change');
      const body = await api.labels.patch('/labels', { id, ...changes });
      return { label: body.label };
    },
  },
  {
    name: 'cookie_delete_label',
    title: 'Delete a label',
    description: 'Permanently deletes a user label and removes it from every email that has it.',
    inputSchema: z.object({ id: z.string().uuid().describe('Label id') }),
    outputSchema: z.object({ deleted: z.literal(true), id: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    async run({ id }, api) {
      await api.labels.delete('/labels', { id });
      return { deleted: true, id };
    },
  },
];
