if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('Can Node.js 22 tro len. Cai Node.js LTS tu https://nodejs.org/');
  process.exitCode = 1;
}
