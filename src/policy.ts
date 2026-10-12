import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './config.js';

export interface PolicyFiles {
  mkdtemp: typeof mkdtemp;
  writeFile: typeof writeFile;
  rm: typeof rm;
}
const files: PolicyFiles = { mkdtemp, writeFile, rm };
export async function withPolicyFile<T>(
  c: Config,
  action: (path: string | undefined) => Promise<T>,
  fs: PolicyFiles = files,
): Promise<T> {
  if (!c.policy) return action(c.policyFile);
  let directory: string;
  try {
    directory = await fs.mkdtemp(join(tmpdir(), 'paperclip-openshell-policy-'));
  } catch {
    throw new Error('Cannot create temporary OpenShell policy directory');
  }
  let result: T;
  let primary: unknown;
  let failed = false;
  try {
    const path = join(directory, 'policy.yaml');
    try {
      await fs.writeFile(path, c.policy, { encoding: 'utf8', mode: 0o600 });
    } catch {
      throw new Error('Cannot write temporary OpenShell policy');
    }
    result = await action(path);
  } catch (error) {
    primary = error;
    failed = true;
  }
  try {
    await fs.rm(directory, { recursive: true, force: true });
  } catch {
    // Only our sanitized diagnostics leave this boundary; filesystem errors
    // can contain policy paths or other private data.
    const cleanup = 'Cannot remove temporary OpenShell policy';
    if (failed)
      throw new Error(
        `${primary instanceof Error ? primary.message : 'OpenShell policy action failed'}; ${cleanup}`,
      );
    throw new Error(cleanup);
  }
  if (failed) throw primary;
  return result!;
}
