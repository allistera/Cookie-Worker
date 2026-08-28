import { describe, expect, it } from 'vitest';
import { createProject, getProjects } from '../src/projects.js';
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
