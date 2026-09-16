// env FIRST: importing @prisma/client runs its own dotenv loader, and whichever
// runs first decides which database this process talks to (see config/env.ts).
import { env } from '../config/env.js';
import { PrismaClient } from '@prisma/client';

/**
 * One PrismaClient for the whole process. Never `new PrismaClient()` inside a
 * service — on Neon that exhausts the connection allowance fast.
 */
export const prisma = new PrismaClient({
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  // Pinned explicitly rather than left to Prisma's own env lookup.
  datasources: { db: { url: env.DATABASE_URL } },
  /**
   * Prisma's defaults for an interactive transaction are a 5s timeout and a 2s
   * wait for a connection. Both are tuned for a database on the same machine.
   * Every statement here is a round trip to Neon, and the business transactions
   * are long by design — publishing a tender reserves a number, moves the state
   * machine, writes a hash-chained audit row and notifies every invited vendor,
   * all of which must commit together. The defaults abort that under load.
   */
  transactionOptions: { maxWait: 15_000, timeout: 30_000 },
});

/** Transaction client type — what every service method accepts as its `tx`. */
export type Tx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;
