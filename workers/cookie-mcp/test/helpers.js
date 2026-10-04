import { vi } from 'vitest';

export function fakeApi() {
  const service = () => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() });
  return {
    emails: service(),
    messages: service(),
    labels: service(),
    search: service(),
    drafts: service(),
    send: service(),
    calendar: service(),
    tasks: service(),
  };
}

/** @param {any[]} tools @param {string} name */
export const byName = (tools, name) => tools.find((tool) => tool.name === name);
