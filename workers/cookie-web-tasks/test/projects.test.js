import { describe, expect, it } from 'vitest';
import { createProject, deleteProject, getProjects, updateProject } from '../src/projects.js';
import { createMockSql } from './helpers.js';

const USER_ID = '99999999-9999-9999-9999-999999999999';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const PARENT_ID = '22222222-2222-4222-8222-222222222222';

describe('GET /projects', () => {
  it('returns the caller rows as a flat list', async () => {
    const sql = createMockSql([
      [{ id: PROJECT_ID, parentId: null, name: 'Work', createdAt: 't0' }],
    ]);

    const response = await getProjects(sql, USER_ID);

    expect(response.status).toBe(200);
    expect((await response.json()).projects).toHaveLength(1);
    expect(sql.calls[0].text).toContain('FROM task_projects');
    expect(sql.calls[0].values).toContain(USER_ID);
  });
});

describe('POST /projects', () => {
  it('creates a root project', async () => {
    const sql = createMockSql([
      [{ id: PROJECT_ID, parentId: null, name: 'Work', createdAt: 't0' }],
    ]);

    const response = await createProject(sql, USER_ID, { name: 'Work' });

    expect(response.status).toBe(201);
    expect((await response.json()).project.name).toBe('Work');
  });

  it('rejects a blank name', async () => {
    const sql = createMockSql([]);
    const response = await createProject(sql, USER_ID, { name: '   ' });
    expect(response.status).toBe(400);
  });

  // An unknown parent means the tree would gain an unreachable node.
  it('404s a parentId the caller does not own', async () => {
    const sql = createMockSql([[]]);
    const response = await createProject(sql, USER_ID, { name: 'Sub', parentId: PARENT_ID });
    expect(response.status).toBe(404);
  });
});

describe('PATCH /projects', () => {
  it('renames a project', async () => {
    const sql = createMockSql([
      [{ id: PROJECT_ID }],
      [{ id: PROJECT_ID, parentId: null, name: 'Renamed', createdAt: 't0' }],
    ]);

    const response = await updateProject(sql, USER_ID, { id: PROJECT_ID, name: 'Renamed' });

    expect(response.status).toBe(200);
    expect((await response.json()).project.name).toBe('Renamed');
  });

  it('404s an id the caller does not own', async () => {
    const sql = createMockSql([[]]);
    const response = await updateProject(sql, USER_ID, { id: PROJECT_ID, name: 'Stolen' });
    expect(response.status).toBe(404);
  });

  // Re-parenting onto your own descendant severs the subtree from the root:
  // invisible in the sidebar, still in the table.
  it('rejects a move that would make a project its own descendant', async () => {
    const sql = createMockSql([
      [{ id: PROJECT_ID }], // the project being moved exists
      [{ id: PARENT_ID }], // the proposed parent exists
      [{ ok: 1 }], // ancestry walk finds the project above the parent
    ]);

    const response = await updateProject(sql, USER_ID, {
      id: PROJECT_ID,
      parentId: PARENT_ID,
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('own descendant');
    // The guard must run before any write.
    expect(sql.calls.some((call) => call.text.includes('UPDATE task_projects'))).toBe(false);
  });

  it('allows a move to the root with parentId null', async () => {
    const sql = createMockSql([
      [{ id: PROJECT_ID }],
      [{ id: PROJECT_ID, parentId: null, name: 'Work', createdAt: 't0' }],
    ]);

    const response = await updateProject(sql, USER_ID, { id: PROJECT_ID, parentId: null });

    expect(response.status).toBe(200);
    expect((await response.json()).project.parentId).toBeNull();
  });
});

describe('DELETE /projects', () => {
  it('deletes an owned project', async () => {
    const sql = createMockSql([[{ id: PROJECT_ID }]]);
    const response = await deleteProject(sql, USER_ID, { id: PROJECT_ID });

    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
    expect(sql.calls[0].text).toContain('DELETE FROM task_projects');
  });

  it('404s an id the caller does not own', async () => {
    const sql = createMockSql([[]]);
    const response = await deleteProject(sql, USER_ID, { id: PROJECT_ID });
    expect(response.status).toBe(404);
  });

  it('400s a malformed id', async () => {
    const sql = createMockSql([]);
    const response = await deleteProject(sql, USER_ID, { id: 'not-a-uuid' });
    expect(response.status).toBe(400);
  });
});
