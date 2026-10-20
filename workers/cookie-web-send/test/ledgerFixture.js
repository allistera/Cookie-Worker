// The older provider/attachment/history suites isolate that behavior from
// ledger SQL. deliveryLedger.test.js exercises the real state machine.
export function ledgerFixture(actual) {
  return {
    ...actual,
    findDelivery: async () => null,
    createDelivery: async (_sql, userId, key, payload, copy) => ({
      id: 'delivery-fixture',
      user_id: userId,
      source_key: key,
      provider_payload: payload,
      copy_payload: copy,
      status: 'pending',
      attempts: 0,
    }),
    claimDelivery: async (_sql, row) => ({ row: { ...row, attempts: 1 }, send: true }),
    acceptDelivery: async (_sql, row, providerId) => ({
      ...row,
      provider_id: providerId,
      accepted_at: row.accepted_at ?? new Date().toISOString(),
      status: 'accepted',
    }),
    completeDelivery: async () => {},
    deferCopyRepair: async () => {},
    stopUnconfirmedDelivery: async () => {},
    deferDelivery: async (_sql, _row, status) => (status === 'rejected' ? 'rejected' : 'sending'),
  };
}
