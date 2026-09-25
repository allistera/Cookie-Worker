// The cycle guard shared by every self-nesting table in this Worker.
//
// A row may not become its own descendant: re-parenting onto your own child
// severs the subtree from the root, leaving it invisible in the sidebar but
// still in the table. The walk climbs from the PROPOSED PARENT upward, so it
// terminates on the tree's depth rather than its size. UNION (not UNION ALL)
// drops rows already visited, so a cycle already in the table still ends the
// walk instead of recursing forever.
//
// The check only holds if nothing reparents between it and the UPDATE, so
// callers run both inside one transaction under a per-owner advisory lock.
//
// The table arrives as an escaped identifier through postgres.js's sql()
// helper — never string interpolation — so no caller can inject one.

/**
 * @param {import('postgres').Sql} sql
 * @param {{table: string, userId: string, id: string, candidateParentId: string}} target
 * @returns {Promise<boolean>}
 */
export async function isAncestorOf(sql, { table, userId, id, candidateParentId }) {
  const rows = await sql`
    WITH RECURSIVE ancestry AS (
      SELECT t.id, t.parent_id FROM ${sql(table)} t
      WHERE t.id = ${candidateParentId} AND t.user_id = ${userId}
      UNION
      SELECT p.id, p.parent_id FROM ${sql(table)} p
      JOIN ancestry a ON p.id = a.parent_id AND p.user_id = ${userId}
    )
    SELECT 1 FROM ancestry WHERE id = ${id} LIMIT 1
  `;
  return rows.length > 0;
}
