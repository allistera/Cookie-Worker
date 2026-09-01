import { describe, expect, it } from 'vitest';

import { TASKS_INDEX } from '../meili/tasks.js';

describe('task-items index descriptor', () => {
  it('searches content, description and sub-task titles', () => {
    expect(TASKS_INDEX.searchable).toEqual(['content', 'description', 'subtasks']);
  });

  // user_id is the only thing separating one person's tasks from another's
  // once retrieval leaves Postgres. completed is filterable so search can
  // exclude finished tasks without deleting them from the index.
  it('can filter by user, completed and updated_at', () => {
    expect(TASKS_INDEX.filterable).toEqual(['user_id', 'completed', 'updated_at']);
  });

  it('sorts by updated_at', () => {
    expect(TASKS_INDEX.sortable).toEqual(['updated_at']);
  });

  it('embeds content and description but not sub-task titles', () => {
    expect(TASKS_INDEX.embedder.documentTemplate).toContain('doc.content');
    expect(TASKS_INDEX.embedder.documentTemplate).toContain('doc.description');
    expect(TASKS_INDEX.embedder.documentTemplate).not.toContain('doc.subtasks');
  });

  it('maps a row to a document', () => {
    const doc = TASKS_INDEX.toDocument({
      id: 't1',
      user_id: 'u1',
      content: 'Plan the trip',
      description: 'Flights and hotels',
      subtasks: ['Book flights', 'Reserve hotel'],
      completed_at: null,
      updated_at: '2026-08-31T10:00:00Z',
    });

    expect(doc).toEqual({
      id: 't1',
      user_id: 'u1',
      content: 'Plan the trip',
      description: 'Flights and hotels',
      subtasks: ['Book flights', 'Reserve hotel'],
      completed: false,
      updated_at: new Date('2026-08-31T10:00:00Z').getTime(),
    });
  });

  // A completed task keeps its document (completed: true) rather than being
  // deleted — query-time filtering owns the exclusion.
  it('marks a completed task, not removes it', () => {
    const doc = TASKS_INDEX.toDocument({ id: 't1', completed_at: '2026-08-31T10:00:00Z' });
    expect(doc.completed).toBe(true);
  });

  // Meilisearch sorts and filters numbers, not ISO strings.
  it('stores updated_at as a number', () => {
    const doc = TASKS_INDEX.toDocument({ id: 't1', updated_at: '2026-08-31T10:00:00Z' });
    expect(typeof doc.updated_at).toBe('number');
  });

  it('tolerates a task with no description or sub-tasks', () => {
    const doc = TASKS_INDEX.toDocument({ id: 't1', user_id: 'u1', content: 'Solo task' });
    expect(doc).toMatchObject({ description: '', subtasks: [], completed: false, updated_at: 0 });
  });
});
