import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
export async function prepare(_config, context) {
  const pkg=JSON.parse(readFileSync('package.json','utf8'));
  if (pkg.version !== context.nextRelease.version) throw new Error('npm version preparation must run before rebuilding');
  execFileSync(process.execPath,['scripts/build.mjs'],{stdio:'inherit'});
  execFileSync(process.execPath,['scripts/check-package.mjs'],{stdio:'inherit'});
}
