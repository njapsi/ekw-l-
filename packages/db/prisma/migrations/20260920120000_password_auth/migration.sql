-- Adds real email+password sign-in alongside the existing magic-link-only
-- auth. Nullable and additive: every existing magic-link/Google user simply
-- has no password set until they add one (via signup-with-an-existing-email
-- or the set-password page). No DROP, no backfill needed.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "passwordHash" TEXT;
