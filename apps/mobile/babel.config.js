/**
 * babel-preset-expo covers expo-router, the JSX runtime, and the reanimated
 * plugin ordering. Nothing else belongs here — a stray plugin in this file is
 * the usual cause of a release build behaving differently from a dev one.
 */

module.exports = function babelConfig(api) {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};
