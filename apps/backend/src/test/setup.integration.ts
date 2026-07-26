/**
 * Runs once per test file, before the file itself is imported.
 *
 * That ordering is the whole reason this file exists: `config/env.ts` validates
 * and freezes `process.env` at first import, and every module in the app pulls
 * it in transitively. Setting variables inside a test — even in `beforeAll` —
 * is too late, because importing the test module has already imported the app.
 */

import { configureTestEnvironment, migrateTestDatabase } from './harness.js';

configureTestEnvironment();

// Migrations are applied once per file rather than once per run. `migrate
// deploy` is a no-op when the schema is current, so the cost after the first
// file is a process spawn, and the alternative — assuming some other file went
// first — makes running a single file impossible.
migrateTestDatabase();
