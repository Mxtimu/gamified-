// Fails loudly and usefully on an old Node, instead of crashing with an
// unexplained "Cannot find module 'node:sqlite'". Imported first by server.mjs.
const [major, minor] = process.versions.node.split('.').map(Number);

if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`
  ✖ This laptop is running Node ${process.versions.node}.
    Grid Guardians needs Node 22.5 or newer — it uses Node's built-in SQLite
    (node:sqlite), which is what lets the whole app run with zero packages.

    Install the current LTS once, then run this again:

      Windows   winget install OpenJS.NodeJS.LTS
      macOS     brew install node
      any OS    https://nodejs.org  (download the LTS installer)

    Nothing else to install — there are no dependencies and no build step.
`);
  process.exit(1);
}
