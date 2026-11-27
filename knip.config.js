// Two runs share this file (see the knip script in package.json):
// - default: tests count as importers, so an export nobody imports at all is
//   reported, including one used only inside its own file.
// - --production: only Worker entry points and scripts count, and exports
//   used inside their own file are allowed, so what is left is code that
//   only tests keep alive.
/** @param {{ production?: boolean }} options */
export default ({ production }) => ({
  entry: ['workers/*/src/index.js!', 'scripts/*.{js,mjs}!'],
  project: [
    'workers/*/src/**/*.js!',
    'shared/**/*.js!',
    'scripts/**/*.{js,mjs}!',
    'shared/test/**/*.js',
  ],
  ignoreExportsUsedInFile: Boolean(production),
  // A test reads import.meta.env through a vite/client type reference; vite
  // ships with vitest and is never imported at run time.
  ignoreDependencies: ['vite'],
});
