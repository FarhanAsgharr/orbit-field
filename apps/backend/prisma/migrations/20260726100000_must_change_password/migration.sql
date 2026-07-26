-- An admin-created account starts with a password its owner did not choose and
-- which travelled out of band. Flag it so clients can force a change on first
-- sign-in rather than leaving a shared credential in place indefinitely.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
