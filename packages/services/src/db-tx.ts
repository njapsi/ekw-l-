/**
 * Run a unit of work in a transaction when handed a real `PrismaClient`, or
 * inline when handed a `TransactionClient` (we are already inside one). Lets
 * a service function be both a standalone transactional operation and a
 * composable step of a larger transaction.
 */
import type { Db } from '@growth-agent/db';

type InteractiveTransaction = (fn: (tx: Db) => Promise<unknown>) => Promise<unknown>;

export function runInTransaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  const maybe = (db as { $transaction?: unknown }).$transaction;
  if (typeof maybe === 'function') {
    return (maybe as InteractiveTransaction).call(db, (tx) => fn(tx)) as Promise<T>;
  }
  return fn(db);
}
