import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

/**
 * One PrismaClient for the whole process. Never `new PrismaClient()` inside a
 * service — on Neon that exhausts the connection allowance fast.
 */
export const prisma = new PrismaClient({
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

/** Transaction client type — what every service method accepts as its `tx`. */
export type Tx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;
