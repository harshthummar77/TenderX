/**
 * @tb/shared — the contract both apps import.
 *
 * Nothing runtime-specific belongs here: no Express, no DOM, no Prisma client.
 * Run `npm run build:shared` after changing anything in this package; that is
 * the fix for every stale-types error.
 */

export * from './enums.js';
export * from './constants.js';
export * from './types.js';
export * from './utils.js';
export * from './schemas/index.js';

/** Imported by both apps in plan 01 to prove the workspace link works. */
export const SHARED_PACKAGE_VERSION = '1.0.0';
