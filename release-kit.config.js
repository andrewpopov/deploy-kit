const { defineConfig, stableSemver, npmPackage, changelogTarget } = require('@andrewpopov/release-kit');

module.exports = defineConfig({
  productName: '@andrewpopov/deploy-kit',
  stage: 'stable',
  rootDir: __dirname,
  // changelogTarget writes CHANGELOG.md; indexPath is unused by it but required by the type.
  paths: { notesDir: '.changes', indexPath: '.changes/INDEX.md' },
  // groupByKind is false (below), so these headings don't render; kinds set bullet ORDER and are the valid `--kind` values.
  kinds: [
    { id: 'breaking', heading: 'Breaking' },
    { id: 'added', heading: 'Added' },
    { id: 'changed', heading: 'Changed' },
    { id: 'fixed', heading: 'Fixed' },
    { id: 'security', heading: 'Security' },
  ],
  versionStrategy: stableSemver(),
  manifest: npmPackage(),
  notesTarget: changelogTarget(), // flat CHANGELOG.md, groupByKind defaults to false
  hygiene: {
    baseRef: 'origin/master',
    relevantPrefixes: ['src/'],
    relevantFiles: ['package.json'],
    relevantScriptPrefixes: ['scripts/'],
    relevantDocFiles: ['CHANGELOG.md'],
    noteCommandHelp: 'npm run release:note -- --kind fixed --slug short-slug --summary "User-facing summary"',
    publishCommandHelp: 'npm run release:cut',
  },
  titleTemplate: '# {productName} {version}',
  versionLabel: 'Package version',
  currentVersionLabel: 'Current package version',
  fragmentBodyPlaceholder: 'Describe the user-facing change in one short paragraph before releasing.',
  releaseNoteIntroTemplate: '',
  indexIntroTemplate: '',
});
