import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = process.cwd();
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const temp = await mkdtemp(path.join(tmpdir(), 'openshell-package-'));
const pnpm = process.env.npm_execpath;
const pm = (args, cwd = root) => {
  const isJs = pnpm?.includes('pnpm') && /\.(?:c?js|mjs)$/.test(pnpm);
  return execFileSync(
    isJs ? process.execPath : 'pnpm',
    isJs ? [pnpm, ...args] : args,
    { cwd, stdio: 'pipe', encoding: 'utf8' },
  );
};
try {
  pm(['pack', '--pack-destination', temp]);
  const tarball = path.join(
    temp,
    `everlastingcrown-paperclip-openshell-sandbox-${pkg.version}.tgz`,
  );
  const consumer = path.join(temp, 'consumer');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(consumer);
  await writeFile(
    path.join(consumer, 'package.json'),
    JSON.stringify({
      name: 'packed-consumer',
      private: true,
      type: 'module',
      dependencies: {
        [pkg.name]: `file:${tarball}`,
        '@paperclipai/plugin-sdk': '2026.1005.0',
        '@paperclipai/shared': '2026.1005.0',
      },
    }),
  );
  // A frozen-lockfile install can cache packages without caching registry metadata.
  // The fresh consumer has no lockfile, so allow fetching missing metadata.
  pm(
    [
      'install',
      '--prefer-offline',
      '--ignore-scripts',
      '--config.node-linker=hoisted',
    ],
    consumer,
  );
  const installed = path.join(consumer, 'node_modules', pkg.name);
  const actual = JSON.parse(
    await readFile(path.join(installed, 'package.json'), 'utf8'),
  );
  assert.equal(actual.version, pkg.version);
  for (const entry of Object.values(actual.exports))
    for (const file of Object.values(entry))
      await access(path.join(installed, file));
  for (const file of Object.values(actual.paperclipPlugin))
    await access(path.join(installed, file));
  await writeFile(
    path.join(consumer, 'check.mjs'),
    `
import assert from 'node:assert/strict';
import plugin, { manifest } from '${pkg.name}';
import directManifest from '${pkg.name}/manifest';
import worker from '${pkg.name}/worker';
import { pluginManifestV1Schema } from '@paperclipai/shared';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdir, utimes } from 'node:fs/promises';
assert.equal(manifest.version, ${JSON.stringify(pkg.version)});
assert.equal(directManifest.version, manifest.version);
const hostManifestPath = ${JSON.stringify(path.join(installed, actual.paperclipPlugin.manifest))};
const hostManifest = (await import(pathToFileURL(hostManifestPath).href)).default;
assert.deepEqual(hostManifest, manifest);
// Reproduce successive npm installs in one host process, with normalized
// tarball mtimes and the same package directory. Both metadata and schema
// must refresh, without relying on a server restart.
const reloadRoot = ${JSON.stringify(path.join(consumer, 'reload'))};
await mkdir(reloadRoot);
const oldPath = reloadRoot + '/manifest-old.js';
const oldManifest = structuredClone(manifest);
oldManifest.version = '0.0.0-old';
oldManifest.environmentDrivers[0].configSchema = {type:'object',properties:{oldField:{type:'string'}}};
await writeFile(oldPath, 'export default ' + JSON.stringify(oldManifest));
const fixedTime = new Date('1985-10-26T08:15:00Z');
await utimes(oldPath, fixedTime, fixedTime);
const loadLikePaperclip = async file => {
  const url = pathToFileURL(file);
  url.searchParams.set('mtime', String(fixedTime.getTime()));
  return (await import(url.href)).default;
};
assert.equal((await loadLikePaperclip(oldPath)).version, oldManifest.version);
const nextPath = reloadRoot + '/' + ${JSON.stringify(path.basename(actual.paperclipPlugin.manifest))};
await writeFile(nextPath, await readFile(hostManifestPath, 'utf8'));
await utimes(nextPath, fixedTime, fixedTime);
assert.deepEqual(await loadLikePaperclip(nextPath), manifest);
assert.equal(plugin, worker);
assert.equal(pluginManifestV1Schema.safeParse(manifest).success, true);
assert.equal(typeof worker.definition.onEnvironmentStopLease, 'function');
const child = spawn(process.execPath, [${JSON.stringify(path.join(installed, actual.paperclipPlugin.worker))}], {stdio:['pipe','pipe','pipe']});
const lines = createInterface({input:child.stdout});
const timer = setTimeout(()=>child.kill('SIGKILL'), 5000);
try {
  const response = new Promise((resolve,reject)=> {
    lines.once('line', line=> { try {resolve(JSON.parse(line));} catch(e) {reject(e);} });
    child.once('error',reject);
    child.once('exit',()=>reject(new Error('Packed worker exited before initialization')));
  });
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{manifest,config:{},apiVersion:1,instanceInfo:{instanceId:'packed-test',hostVersion:'2026.1005.0'}}})+'\\n');
  const result = await response;
  assert.equal(result.result.ok,true);
  for (const method of ['environmentAcquireLease','environmentResumeLease','environmentReleaseLease','environmentDestroyLease','environmentStopLease','environmentExecute']) assert.ok(result.result.supportedMethods.includes(method));
} finally {clearTimeout(timer);lines.close();child.stdin.end();child.kill();}
`,
  );
  execFileSync(process.execPath, ['check.mjs'], {
    cwd: consumer,
    stdio: 'inherit',
  });
  await writeFile(
    path.join(consumer, 'check.ts'),
    `import plugin, { manifest, OpenShellProvider, type Config } from '${pkg.name}';\nimport worker from '${pkg.name}/worker';\nimport directManifest from '${pkg.name}/manifest';\nconst p: OpenShellProvider = new OpenShellProvider();\nvoid [plugin, worker, manifest, directManifest, p];\n`,
  );
  execFileSync(
    process.execPath,
    [
      path.join(root, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--module',
      'NodeNext',
      '--target',
      'ES2024',
      'check.ts',
    ],
    { cwd: consumer, stdio: 'inherit' },
  );
  console.log(`Packed consumer validated: ${pkg.name}@${pkg.version}`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
