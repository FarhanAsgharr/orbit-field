/**
 * Metro configuration for a monorepo.
 *
 * Without this the bundler resolves modules only from apps/mobile/node_modules,
 * and every `@orbit/shared` import fails at bundle time — a failure that neither
 * the typecheck nor `expo start` on a warm cache will show you.
 *
 * The workspace packages are consumed as built output (`dist/`), so
 * `npm run build:packages` has to have run before a bundle is produced. The EAS
 * build profiles do this in their prebuild hook.
 */

const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Source outside the app directory has to be watched explicitly.
config.watchFolders = [workspaceRoot];

// npm hoists shared dependencies to the root, so both locations are searched.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// Hierarchical lookup stays on: a hoisted dependency is the common case here,
// and disabling it turns every miss into a resolution error rather than a
// walk up to the root.
config.resolver.disableHierarchicalLookup = false;

module.exports = config;
