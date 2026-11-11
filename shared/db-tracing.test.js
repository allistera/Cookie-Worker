import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createTracingRecorder } from '../test/fixtures/tracing-recorder.js';

const recorder = vi.hoisted(() => ({ current: /** @type {any} */ (null) }));

vi.mock('cloudflare:workers', () => ({
  tracing: {
    getActiveSpan: () => recorder.current?.tracing.getActiveSpan(),
    /** @param {string} name */
    startSpan: (name) => recorder.current?.tracing.startSpan(name),
  },
}));

const { connectionAttributes, instrumentSql, operationName, statementFingerprint } =
  await import('./db-tracing.js');
const { runWithSqlMetrics } = await import('./sqlMetrics.js');

/**
 * The shape postgres.js gives a query: a Promise subclass that runs on the
 * first `handle()` and is settled by the connection through `resolve` or
 * `reject`. `outcome` stands in for the connection.
 *
 * @extends {Promise<any>}
 */
class FakeQuery extends Promise {
  /**
   * @param {readonly string[]} strings
   * @param {() => Promise<unknown>} outcome
   * @param {unknown[]} [args]
   */
  constructor(strings, outcome, args = []) {
    /** @type {(value: unknown) => void} */
    let resolve = () => undefined;
    /** @type {(reason: unknown) => void} */
    let reject = () => undefined;
    super((a, b) => {
      resolve = a;
      reject = b;
    });
    this.strings = strings;
    this.args = args;
    this.executed = false;
    this.outcome = outcome;
    this.resolve = resolve;
    this.reject = reject;
  }

  static get [Symbol.species]() {
    return Promise;
  }

  async handle() {
    if (this.executed) return;
    this.executed = true;
    await 1;
    this.outcome().then(
      (value) => this.resolve(value),
      (error) => this.reject(error),
    );
  }

  /** @param {any[]} args */
  then(...args) {
    this.handle();
    return super.then(...args);
  }
}

/**
 * A client with the surface the Workers use: tagged queries, `unsafe`,
 * `begin` with a scoped client, `json`, and `end`.
 *
 * @param {(strings: readonly string[]) => Promise<unknown>} run
 */
function fakeClient(run) {
  /** @type {any} */
  const sql = (
    /** @type {TemplateStringsArray | object} */ strings,
    /** @type {unknown[]} */ ...args
  ) =>
    Array.isArray(strings)
      ? new FakeQuery(strings, () => run(strings), args)
      : { fragment: strings, args };
  sql.unsafe = (/** @type {string} */ text) => new FakeQuery([text], () => run([text]));
  sql.begin = vi.fn(async (/** @type {(scoped: any) => Promise<unknown>} */ callback) =>
    callback(sql),
  );
  sql.json = (/** @type {unknown} */ value) => ({ json: value });
  sql.end = vi.fn(async () => undefined);
  return sql;
}

/** @param {TemplateStringsArray} strings @param {unknown[]} _values */
const tag = (strings, ..._values) => strings;

beforeEach(() => {
  recorder.current = createTracingRecorder();
});

afterEach(() => vi.useRealTimers());

describe('connectionAttributes', () => {
  test('reads host, port and database without the credentials', () => {
    expect(
      connectionAttributes('postgresql://user:secret@abc.hyperdrive.local:5433/cookie'),
    ).toEqual({
      'db.system.name': 'postgresql',
      'server.address': 'abc.hyperdrive.local',
      'server.port': 5433,
      'db.namespace': 'cookie',
    });
    expect(JSON.stringify(connectionAttributes('postgres://u:secret@h/db'))).not.toContain(
      'secret',
    );
  });

  test('defaults the port and survives an unparseable string', () => {
    expect(connectionAttributes('postgres://u:p@h/db')['server.port']).toBe(5432);
    expect(connectionAttributes('not a url')).toEqual({ 'db.system.name': 'postgresql' });
  });
});

describe('operationName', () => {
  test.each([
    [['SELECT 1'], 'SELECT'],
    [['\n  insert into messages'], 'INSERT'],
    [['-- note\n/* block */ WITH x AS (SELECT 1) UPDATE t'], 'WITH'],
    [['begin read write'], 'BEGIN'],
    [['', ' FROM t'], undefined],
    [[], undefined],
  ])('%j -> %s', (strings, expected) => {
    expect(operationName(strings)).toBe(expected);
  });
});

describe('statementFingerprint', () => {
  /** @param {TemplateStringsArray} strings @param {unknown[]} args */
  const fragment = (strings, ...args) => ({ strings, args });
  /** @param {TemplateStringsArray} strings @param {unknown[]} args */
  const fingerprint = (strings, ...args) => statementFingerprint(strings, args);

  test('is eight hex digits that say nothing about the statement', () => {
    expect(fingerprint`SELECT id FROM messages WHERE user_id = ${'u'}`).toMatch(/^[0-9a-f]{8}$/u);
  });

  test('ignores values, value-list lengths and layout', () => {
    const one = fingerprint`SELECT id FROM messages WHERE user_id = ${'alice'} AND id IN ${[1]}`;
    const other = fingerprint`
      SELECT id
      FROM messages
      WHERE user_id = ${'bob'} AND id IN ${[1, 2, 3]}
    `;
    expect(other).toBe(one);
  });

  test('tells different statements apart, including by their interpolated fragments', () => {
    const plain = fingerprint`SELECT id FROM messages WHERE true ${fragment``}`;
    const filtered = fingerprint`SELECT id FROM messages WHERE true ${fragment`AND starred = ${true}`}`;
    const several = fingerprint`SELECT id FROM messages WHERE true ${[
      fragment`AND starred = ${true}`,
      fragment`AND archived = ${false}`,
    ]}`;
    expect(new Set([plain, filtered, several]).size).toBe(3);
    expect(fingerprint`SELECT id FROM messages`).not.toBe(fingerprint`SELECT id FROM drafts`);
    expect(
      fingerprint`SELECT id FROM messages WHERE true ${fragment`AND starred = ${false}`}`,
    ).toBe(filtered);
  });

  test('copes with a statement that has no static text', () => {
    expect(statementFingerprint([])).toMatch(/^[0-9a-f]{8}$/u);
    expect(statementFingerprint(['', ''], [{ json: 1 }])).toMatch(/^[0-9a-f]{8}$/u);
  });
});

describe('instrumentSql', () => {
  const attributes = { 'db.system.name': 'postgresql', 'db.namespace': 'cookie' };

  test('returns the client itself when the invocation is neither traced nor measured', () => {
    recorder.current = null;
    const sql = fakeClient(async () => []);
    expect(instrumentSql(sql, attributes)).toBe(sql);
  });

  test('gives each awaited query a span with the database attributes and row count', async () => {
    const rows = Object.assign([{ id: 1 }, { id: 2 }], { count: 2 });
    const sql = instrumentSql(
      fakeClient(async () => rows),
      attributes,
    );

    await expect(sql(tag`SELECT id FROM messages WHERE user_id = ${'u'}`)).resolves.toBe(rows);
    const [, span] = recorder.current.spans;
    expect(span).toMatchObject({
      name: 'SELECT',
      ended: true,
      attributes: {
        'db.system.name': 'postgresql',
        'db.namespace': 'cookie',
        'db.operation.name': 'SELECT',
        'db.response.returned_rows': 2,
        'cookie.db.query.fingerprint': statementFingerprint(
          tag`SELECT id FROM messages WHERE user_id = ${'u'}`,
        ),
      },
    });
    expect(JSON.stringify(span.attributes)).not.toContain('messages');
  });

  test('records affected rows, errors, and leaves a never-awaited query alone', async () => {
    const written = Object.assign([], { count: 3 });
    const sql = instrumentSql(
      fakeClient(async (strings) => {
        if (strings[0].startsWith('DELETE'))
          throw Object.assign(new Error('no'), { code: '42501' });
        return written;
      }),
      attributes,
    );

    await sql(tag`UPDATE t SET a = 1`);
    await expect(sql(tag`DELETE FROM t`)).rejects.toThrow('no');
    sql(tag`SELECT never`);

    const [, update, remove] = recorder.current.spans;
    expect(update.attributes['db.response.returned_rows']).toBe(3);
    expect(remove).toMatchObject({
      name: 'DELETE',
      ended: true,
      status: { code: 'error', message: '42501' },
      attributes: { 'error.type': '42501' },
    });
    expect(recorder.current.spans).toHaveLength(3);
  });

  test('traces unsafe statements and the scoped client of a transaction', async () => {
    const sql = instrumentSql(
      fakeClient(async () => []),
      attributes,
    );
    await sql.unsafe('begin read write');
    await sql.begin(async (/** @type {any} */ tx) => {
      await tx(tag`INSERT INTO t VALUES (1)`);
      await tx(tag`${tx.json({ a: 1 })}`);
    });
    expect(recorder.current.spans.slice(1).map((/** @type {any} */ s) => s.name)).toEqual([
      'BEGIN',
      'INSERT',
      'postgresql',
    ]);
    expect(recorder.current.spans[3].attributes['db.operation.name']).toBeUndefined();
  });

  test('passes helpers and fragments straight through', async () => {
    const client = fakeClient(async () => []);
    const sql = instrumentSql(client, attributes);
    expect(sql.json({ a: 1 })).toEqual({ json: { a: 1 } });
    expect(sql({ a: 1 })).toEqual({ fragment: { a: 1 }, args: [] });
    await sql.end();
    expect(client.end).toHaveBeenCalledOnce();
    expect(recorder.current.spans).toHaveLength(1);
  });

  describe('query metrics', () => {
    /** @returns {any} */
    function metricsEnv() {
      return { SQL_METRICS: { writeDataPoint: vi.fn() } };
    }

    /**
     * @template T
     * @param {any} env
     * @param {() => T} callback
     */
    const inRequest = (env, callback) =>
      runWithSqlMetrics(env, 'cookie-web-messages', 'GET /messages/{id}', callback);

    test('writes one data point per awaited query without a trace', async () => {
      recorder.current = null;
      vi.useFakeTimers();
      const env = metricsEnv();
      const rows = Object.assign([{ id: 1 }, { id: 2 }], { count: 2 });

      await inRequest(env, async () => {
        const sql = instrumentSql(
          fakeClient(async () => {
            vi.advanceTimersByTime(25);
            return rows;
          }),
          attributes,
        );
        await expect(sql(tag`SELECT id FROM messages WHERE user_id = ${'u'}`, 'u')).resolves.toBe(
          rows,
        );
        sql(tag`SELECT never`);
      });

      expect(env.SQL_METRICS.writeDataPoint).toHaveBeenCalledExactlyOnceWith({
        indexes: ['cookie-web-messages'],
        blobs: [
          'cookie-web-messages',
          'GET /messages/{id}',
          'SELECT',
          statementFingerprint(tag`SELECT id FROM messages WHERE user_id = ${'u'}`, ['u']),
          'ok',
        ],
        doubles: [25, 2],
      });
      expect(JSON.stringify(env.SQL_METRICS.writeDataPoint.mock.calls)).not.toContain('user_id');
    });

    test('records a failure by its SQLSTATE and still rejects', async () => {
      recorder.current = null;
      const env = metricsEnv();

      await inRequest(env, async () => {
        const sql = instrumentSql(
          fakeClient(async () => {
            throw Object.assign(new Error('canceling statement due to statement timeout'), {
              code: '57014',
            });
          }),
          attributes,
        );
        await expect(sql(tag`UPDATE t SET a = 1`)).rejects.toThrow('statement timeout');
      });

      const [[point]] = env.SQL_METRICS.writeDataPoint.mock.calls;
      expect(point.blobs.slice(2)).toEqual([
        'UPDATE',
        statementFingerprint(tag`UPDATE t SET a = 1`),
        '57014',
      ]);
      expect(point.doubles[1]).toBe(0);
    });

    test('measures transactions, unsafe statements and statements without a keyword', async () => {
      recorder.current = null;
      const env = metricsEnv();

      await inRequest(env, async () => {
        const sql = instrumentSql(
          fakeClient(async () => []),
          attributes,
        );
        await sql.unsafe('begin read write');
        await sql.begin(async (/** @type {any} */ tx) => {
          await tx(tag`INSERT INTO t VALUES (1)`);
          await tx(tag`${tx.json({ a: 1 })}`, tx.json({ a: 1 }));
        });
      });

      expect(
        env.SQL_METRICS.writeDataPoint.mock.calls.map(
          (/** @type {any[]} */ [point]) => point.blobs[2],
        ),
      ).toEqual(['BEGIN', 'INSERT', 'postgresql']);
    });

    test('keeps the span and the data point of one query in step', async () => {
      const env = metricsEnv();

      await inRequest(env, async () => {
        const sql = instrumentSql(
          fakeClient(async () => Object.assign([], { count: 4 })),
          attributes,
        );
        await sql(tag`DELETE FROM t`);
      });

      const [, span] = recorder.current.spans;
      const [[point]] = env.SQL_METRICS.writeDataPoint.mock.calls;
      expect(span.attributes['cookie.db.query.fingerprint']).toBe(point.blobs[3]);
      expect(span.attributes['db.response.returned_rows']).toBe(point.doubles[1]);
      expect(span.ended).toBe(true);
    });

    test('records nothing for a query that runs outside any invocation', async () => {
      recorder.current = null;
      const env = metricsEnv();
      const sql = inRequest(env, () =>
        instrumentSql(
          fakeClient(async () => []),
          attributes,
        ),
      );

      // Outside any invocation there is nothing to attribute the query to.
      await sql(tag`SELECT 1`);

      expect(env.SQL_METRICS.writeDataPoint).not.toHaveBeenCalled();
    });
  });
});
