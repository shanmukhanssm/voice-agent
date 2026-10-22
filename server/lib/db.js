/**
 * db.js - the ONLY PrismaClient in the app (H-B6 posture: DB access lives
 * in the main Bun server process; nothing under public/ and neither the
 * voice-service ever opens the database).
 *
 * Pattern per library-docs.md ss Prisma (globalThis caching), with the
 * datasource URL taken from config (the only env-reading module) instead of
 * a direct Bun.env read. When DATABASE_URL is absent (zero-keys boot) the
 * canonical sandbox SQLite file is used: file:../db/custom.db resolved from
 * prisma/ - the same path `bun run db:push` writes to.
 */
import { PrismaClient } from "@prisma/client";
import { config } from "./config.js";

/** Fallback when DATABASE_URL is missing - schema-relative canonical path. */
const DEFAULT_SQLITE_URL = "file:../db/custom.db";

function databaseUrl() {
  return config.env.DATABASE_URL ?? DEFAULT_SQLITE_URL;
}

const globalForPrisma = globalThis;

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({ datasources: { db: { url: databaseUrl() } } });

if (config.isDev) globalForPrisma.prisma = db;
