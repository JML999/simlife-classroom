const major = Number(process.versions.node.split(".")[0]);

if (major < 22) {
  console.error(`\nSimLife requires Node 22 or newer. Current runtime: ${process.version}.`);
  console.error("Run `nvm use` (the project includes .nvmrc), then retry.\n");
  process.exit(1);
}
