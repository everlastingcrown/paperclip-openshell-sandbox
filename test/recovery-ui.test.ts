import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Environment, EnvironmentLease } from '@paperclipai/shared';
import { pluginId } from '../src/plugin-id.js';
import {
  creationAttempt,
  mergeRecovery,
  RecoveryClient,
  recoveryDraft,
  type PendingRecovery,
} from '../src/ui/recovery-client.js';

const attemptId = '12345678-1234-1234-1234-123456789abc';
const otherAttempt = 'aaaaaaaa-1234-1234-1234-123456789abc';
function fixture(): PendingRecovery {
  return {
    environment: {
      id: 'env',
      name: 'Development',
      driver: 'sandbox',
      config: {
        provider: 'openshell',
        gateway: 'edited-gateway',
        workspace: 'edited-workspace',
      },
    } as Environment,
    lease: {
      id: 'lease',
      environmentId: 'env',
      companyId: 'company',
      provider: 'openshell',
      providerLeaseId: 'pc-allocation',
      status: 'pending_cleanup',
      metadata: {
        pluginKey: pluginId,
        gateway: 'original',
        workspace: 'original-workspace',
        configHome: '/saved/config',
        failedCreateCleanup: {
          companyId: 'company',
          environmentId: 'env',
          providerLeaseId: 'pc-allocation',
          attemptId,
        },
      },
    } as EnvironmentLease,
  };
}
const signal = () => new AbortController().signal;
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status });
const configPath = `/api/plugins/${pluginId}/config`;

test('recovery form uses persisted scope and matching recovery override', () => {
  const pending = fixture();
  const config = {
    cleanupRecovery: [
      {
        environmentId: 'env',
        gateway: 'original',
        workspace: 'original-workspace',
        configHome: '/moved/config',
        rejectedAttemptIds: [attemptId],
      },
    ],
  };
  assert.deepEqual(recoveryDraft(pending, config), {
    ...config.cleanupRecovery[0],
  });
  pending.lease.metadata!.openshell = {
    gateway: 'lease-gateway',
    workspace: 'lease-workspace',
    configHome: '/lease/config',
  };
  assert.deepEqual(recoveryDraft(pending, config), {
    environmentId: 'env',
    gateway: 'lease-gateway',
    workspace: 'lease-workspace',
    configHome: '/lease/config',
    rejectedAttemptIds: [],
  });
});

test('legacy missing connection fields fall back to environment or existing recovery', () => {
  const pending = fixture();
  pending.lease.metadata = { pluginKey: pluginId };
  assert.equal(recoveryDraft(pending, {}).gateway, 'edited-gateway');
  assert.equal(recoveryDraft(pending, {}).workspace, 'edited-workspace');
  pending.environment.config = {};
  const draft = recoveryDraft(pending, {
    cleanupRecovery: [
      { environmentId: 'env', gateway: 'recovered', workspace: 'custom' },
    ],
  });
  assert.equal(draft.gateway, 'recovered');
  assert.equal(draft.workspace, 'custom');
});

test('rejected creation confirmation requires an exact recorded ownership envelope', () => {
  const pending = fixture();
  assert.equal(creationAttempt(pending), attemptId);
  for (const [key, value] of [
    ['companyId', 'foreign'],
    ['environmentId', 'foreign'],
    ['providerLeaseId', 'foreign'],
    ['attemptId', 'not-a-uuid'],
  ]) {
    const changed = structuredClone(pending);
    (changed.lease.metadata!.failedCreateCleanup as any)[key] = value;
    assert.equal(creationAttempt(changed), undefined);
  }
});

test('merge preserves fresh settings and confirmations, validates input, and rejects incompatible scope', () => {
  const draft = recoveryDraft(fixture(), {});
  const existing = {
    cleanupRecovery: [
      { ...draft, rejectedAttemptIds: [otherAttempt] },
      { environmentId: 'other', gateway: 'other-gateway' },
    ],
    futureSetting: 'preserved',
  };
  const merged = mergeRecovery(existing, draft, attemptId) as any;
  assert.equal(merged.futureSetting, 'preserved');
  assert.equal(merged.cleanupRecovery.length, 2);
  assert.deepEqual(
    merged.cleanupRecovery.find((entry: any) => entry.environmentId === 'env')
      .rejectedAttemptIds,
    [otherAttempt, attemptId],
  );
  assert.equal(existing.cleanupRecovery[0].rejectedAttemptIds!.length, 1);
  assert.throws(
    () => mergeRecovery(existing, { ...draft, gateway: 'different' }),
    /different gateway/,
  );
  assert.throws(
    () => mergeRecovery({}, { ...draft, configHome: 'relative' }),
    /absolute configHome/,
  );
  assert.throws(() => mergeRecovery({}, draft, 'invalid'), /attempt UUIDs/);
  assert.throws(
    () => mergeRecovery({ cleanupRecovery: 'broken' }, draft),
    /cleanupRecovery/,
  );
});

test('load checks all environments and filters company, provider, owner, status and environment', async () => {
  const pending = fixture();
  const calls: string[] = [];
  const client = new RecoveryClient(async (path, init) => {
    calls.push(String(path));
    assert.equal(init?.credentials, 'include');
    assert.equal(init?.cache, 'no-store');
    if (String(path).includes('/config?')) return response(null);
    if (String(path).endsWith('/environments'))
      return response([
        pending.environment,
        {
          ...pending.environment,
          id: 'changed-provider',
          config: { provider: 'other' },
        },
      ]);
    if (String(path).includes('/changed-provider/')) return response([]);
    return response([
      pending.lease,
      { ...pending.lease, companyId: 'other' },
      { ...pending.lease, provider: 'other' },
      { ...pending.lease, status: 'expired' },
      { ...pending.lease, environmentId: 'foreign' },
      { ...pending.lease, metadata: { pluginKey: 'another-plugin' } },
      { ...pending.lease, metadata: {} },
    ]);
  });
  const snapshot = await client.load('company', signal());
  assert.equal(snapshot.pending.length, 1);
  assert.equal(snapshot.pending[0].environment.name, 'Development');
  assert.equal(calls.length, 4);
});

test('failed environment lookup does not report an empty successful list', async () => {
  const client = new RecoveryClient(async (path) => {
    if (String(path).includes('/config?')) return response(null);
    if (String(path).endsWith('/environments'))
      return response([fixture().environment]);
    return response({ error: 'secret raw CLI output' }, 500);
  });
  await assert.rejects(
    client.load('company', signal()),
    (error) =>
      /HTTP 500/.test(String(error)) && !String(error).includes('secret'),
  );
});

test('save rechecks the lease and merges the latest configuration without invoking cleanup', async () => {
  const pending = fixture();
  const draft = recoveryDraft(pending, {});
  const calls: string[] = [];
  let saved: any;
  const client = new RecoveryClient(async (path, init) => {
    calls.push(String(path));
    if (init?.method === 'POST') {
      saved = JSON.parse(String(init.body));
      return response(saved);
    }
    if (String(path).includes('/config?'))
      return response({
        configJson: {
          fresh: true,
          cleanupRecovery: [
            { environmentId: 'other', gateway: 'other-gateway' },
            { ...draft, rejectedAttemptIds: [otherAttempt] },
          ],
        },
      });
    return response(pending.lease);
  });
  await client.save(
    'company',
    pending,
    { ...draft, configHome: '/moved' },
    signal(),
    attemptId,
  );
  assert.deepEqual(calls, [
    '/api/environment-leases/lease',
    `${configPath}?companyId=company`,
    configPath,
  ]);
  assert.equal(saved.companyId, 'company');
  assert.equal(saved.configJson.fresh, true);
  assert.equal(saved.configJson.cleanupRecovery[1].configHome, '/moved');
  assert.deepEqual(saved.configJson.cleanupRecovery[1].rejectedAttemptIds, [
    otherAttempt,
    attemptId,
  ]);
});

test('stale, foreign, completed and changed-attempt leases cannot seed recovery settings', async () => {
  const pending = fixture();
  for (const change of [
    { id: 'other' },
    { companyId: 'foreign' },
    { environmentId: 'foreign' },
    { providerLeaseId: 'changed' },
    { provider: 'other' },
    { status: 'expired' },
    { metadata: { pluginKey: 'foreign' } },
    {
      metadata: {
        ...pending.lease.metadata,
        failedCreateCleanup: {
          ...(pending.lease.metadata!.failedCreateCleanup as any),
          attemptId: otherAttempt,
        },
      },
    },
  ]) {
    let calls = 0;
    const client = new RecoveryClient(async () => {
      calls++;
      return response({ ...pending.lease, ...change });
    });
    await assert.rejects(
      client.save(
        'company',
        pending,
        recoveryDraft(pending, {}),
        signal(),
        attemptId,
      ),
      /changed|pending/,
    );
    assert.equal(calls, 1);
  }
});

test('save refuses stale connection details and invalid paths before posting', async () => {
  const pending = fixture();
  let posts = 0;
  const client = new RecoveryClient(async (path, init) => {
    if (init?.method === 'POST') posts++;
    return response(String(path).includes('/config?') ? null : pending.lease);
  });
  const draft = recoveryDraft(pending, {});
  await assert.rejects(
    client.save('company', pending, { ...draft, gateway: 'wrong' }, signal()),
    /connection details/,
  );
  await assert.rejects(
    client.save(
      'company',
      pending,
      { ...draft, configHome: 'relative' },
      signal(),
    ),
    /absolute configHome/,
  );
  assert.equal(posts, 0);
});

test('non-admin save returns actionable permission guidance without raw server output', async () => {
  const pending = fixture();
  const client = new RecoveryClient(async (path, init) => {
    if (init?.method === 'POST') return response({ error: 'secret' }, 403);
    return response(String(path).includes('/config?') ? null : pending.lease);
  });
  await assert.rejects(
    client.save('company', pending, recoveryDraft(pending, {}), signal()),
    (error) =>
      /instance administrator/.test(String(error)) &&
      !String(error).includes('secret'),
  );
});

test('company query values are encoded and cancelled loads retain abort signals', async () => {
  const controller = new AbortController();
  const urls: string[] = [];
  const client = new RecoveryClient(async (path, init) => {
    assert.equal(init?.signal, controller.signal);
    urls.push(String(path));
    return response(String(path).includes('/config?') ? null : []);
  });
  await client.load('company/with?characters', controller.signal);
  assert.ok(urls.every((url) => url.includes('company%2Fwith%3Fcharacters')));
});
