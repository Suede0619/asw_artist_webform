import { readFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { openDatabase } from './database.mjs';

export function createStore(config) {
  const postgres = Boolean(config.databaseUrl);
  const sqlite = postgres ? null : openDatabase(config.dataDir);
  if (sqlite && config.editorial) sqlite.exec(readFileSync(new URL('./schema/002-editorial.sql', import.meta.url), 'utf8'));
  const pool = postgres ? new pg.Pool({
    connectionString: verifiedPostgresUrl(config.databaseUrl),
    max: 5,
    enableChannelBinding: true,
    connectionTimeoutMillis: 10000,
    types: {
      getTypeParser: (oid, format) => oid === 20 ? Number : pg.types.getTypeParser(oid, format),
    },
  }) : null;
  pool?.on('error', () => console.error('An idle Postgres connection was closed.'));
  const transactionContext = new AsyncLocalStorage();
  let pending = Promise.resolve();

  function serialize(operation) {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  }

  function prepare(sql) {
    const statement = sqlite?.prepare(sql);
    let number = 0;
    const query = postgres ? sql.replace(/\?/g, () => '$' + ++number) : sql;
    async function execute(method, args) {
      const connection = transactionContext.getStore();
      if (sqlite) {
        const run = () => statement[method](...args);
        return connection ? run() : serialize(run);
      }
      const result = await (connection || pool).query(query, args);
      if (method === 'run') return { changes: result.rowCount };
      return method === 'get' ? result.rows[0] : result.rows;
    }
    return {
      get: (...args) => execute('get', args),
      all: (...args) => execute('all', args),
      run: (...args) => execute('run', args),
    };
  }

  async function transaction(operation) {
    if (sqlite) return serialize(async () => {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const result = await transactionContext.run(sqlite, operation);
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    });

    const client = await pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      // Preserve the single-writer semantics of the SQLite intake transactions.
      await client.query('SELECT pg_advisory_xact_lock(419204, 1)');
      const result = await transactionContext.run(client, operation);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { discard = true; }
      throw error;
    } finally {
      client.release(discard);
    }
  }

  return {
    postgres, prepare, transaction, sqlite,
    close: () => sqlite ? sqlite.close() : pool.end(),
  };
}

export function verifiedPostgresUrl(value) {
  const url = new URL(value);
  url.searchParams.set('sslmode', 'verify-full');
  return url.href;
}
