import { readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
await writeFile(
  'src/version.ts',
  `// Generated from package.json by scripts/build.mjs.\nexport const version = ${JSON.stringify(version)};\n`,
);
await rm('dist', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc'], {
  stdio: 'inherit',
});
