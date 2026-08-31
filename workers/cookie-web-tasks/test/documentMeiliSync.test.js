import { describe, expect, it, vi } from 'vitest'

import { createMockSql } from './helpers.js'
import { removeDocumentFromMeili, syncDocumentToMeili } from '../src/documentMeiliSync.js'

const ENV = { MEILISEARCH_URL: 'https://meili.test', MEILISEARCH_API_KEY: 'key' }
const DOC_ID = '11111111-1111-4111-8111-111111111111'

describe('syncDocumentToMeili', () => {
  it('does nothing when Meilisearch is not configured', async () => {
    const sql = createMockSql([])

    await syncDocumentToMeili(sql, {}, DOC_ID)

    expect(sql.calls).toHaveLength(0)
  })

  it('reads the row and pushes it', async () => {
    const sql = createMockSql([[{ id: DOC_ID, user_id: 'u1', title: 'Roof' }]])
    const push = vi.fn(async () => ({ taskUid: 1 }))

    await syncDocumentToMeili(sql, ENV, DOC_ID, { addDocuments: push })

    expect(sql.calls[0].text).toContain('FROM documents')
    expect(push).toHaveBeenCalledTimes(1)
    expect(/** @type {any} */ (push).mock.calls[0][2][0]).toMatchObject({ id: DOC_ID })
  })

  it('does nothing when the document has gone', async () => {
    const sql = createMockSql([[]])
    const push = vi.fn()

    await syncDocumentToMeili(sql, ENV, DOC_ID, { addDocuments: push })

    expect(push).not.toHaveBeenCalled()
  })

  // A save must not fail because search indexing did.
  it('swallows a Meilisearch failure', async () => {
    const sql = createMockSql([[{ id: DOC_ID, user_id: 'u1' }]])
    const push = vi.fn(async () => {
      throw new Error('meili down')
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(
      syncDocumentToMeili(sql, ENV, DOC_ID, { addDocuments: push }),
    ).resolves.toBeUndefined()
  })
})

describe('removeDocumentFromMeili', () => {
  it('deletes by id', async () => {
    const remove = vi.fn(async () => ({ taskUid: 1 }))

    await removeDocumentFromMeili(ENV, DOC_ID, { deleteDocuments: remove })

    expect(/** @type {any} */ (remove).mock.calls[0][2]).toEqual([DOC_ID])
  })

  it('swallows a Meilisearch failure', async () => {
    const remove = vi.fn(async () => {
      throw new Error('meili down')
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(
      removeDocumentFromMeili(ENV, DOC_ID, { deleteDocuments: remove }),
    ).resolves.toBeUndefined()
  })
})
