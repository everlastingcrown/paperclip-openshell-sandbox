import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useHostContext, useHostNavigation } from '@paperclipai/plugin-sdk/ui';
import {
  creationAttempt,
  RecoveryClient,
  recoveryDraft,
  type PendingRecovery,
  type RecoverySnapshot,
} from './recovery-client.js';
import type { CleanupRecovery } from '../recovery.js';

const client = new RecoveryClient();
const button =
  'rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-50';
const input =
  'w-full rounded-md border bg-background px-3 py-2 text-sm read-only:opacity-70';
const panel = 'rounded-lg border p-5 space-y-4';

function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Recovery information could not be loaded. Refresh and try again.';
}

export function RecoveryLink() {
  const navigation = useHostNavigation();
  return (
    <a
      {...navigation.linkProps('/openshell-recovery')}
      className="flex items-center px-3 py-2 text-sm font-medium hover:bg-accent rounded-md"
    >
      OpenShell recovery
    </a>
  );
}

export function RecoveryPage() {
  const { companyId } = useHostContext();
  return (
    <main className="mx-auto w-full max-w-3xl p-6 space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">OpenShell recovery</h1>
        <p>
          Help Paperclip finish cleaning up a sandbox after an earlier failure.
        </p>
        <p className="text-sm text-muted-foreground">
          This page fills in recovery settings from saved cleanup records.
          Saving lets Paperclip use them on its next automatic cleanup attempt.
          It does not run cleanup immediately or delete the environment.
        </p>
      </header>
      {companyId ? (
        <CompanyRecovery key={companyId} companyId={companyId} />
      ) : (
        <p role="status">
          Select a company to view its pending cleanup records.
        </p>
      )}
      <details className="text-sm space-y-2">
        <summary className="cursor-pointer font-medium">
          What this page can help with
        </summary>
        <p>
          Ordinary cleanup failures already retry automatically. Use recovery
          settings when the worker configuration directory has moved, or when
          gateway or CLI evidence confirms that a creation attempt was rejected.
        </p>
        <p>
          A gateway outage must be fixed before cleanup can succeed. This page
          shows Paperclip’s saved status, not a live inspection of OpenShell. It
          cannot force cleanup or mark a sandbox as deleted.
        </p>
        <p>
          Only this company’s OpenShell leases attached to existing environment
          records are listed. If an environment record has been removed, use the
          advanced recovery settings or ask an operator for help.
        </p>
        <p>
          Recovery settings stay saved after cleanup. Administrators can review
          or remove them in the plugin’s settings under “Cleanup recovery
          entries”.
        </p>
      </details>
    </main>
  );
}

function CompanyRecovery({ companyId }: { companyId: string }) {
  const [snapshot, setSnapshot] = useState<RecoverySnapshot>();
  const [selected, setSelected] = useState('');
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lifetime = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setSnapshot(undefined);
    client
      .load(companyId, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setSnapshot(next);
        setSelected((previous) =>
          next.pending.some((item) => item.lease.id === previous)
            ? previous
            : (next.pending[0]?.lease.id ?? ''),
        );
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(message(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [companyId, revision]);

  async function save(
    pending: PendingRecovery,
    draft: CleanupRecovery,
    rejectedAttempt?: string,
  ) {
    const signal = lifetime.current!.signal;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await client.save(companyId, pending, draft, signal, rejectedAttempt);
      if (!signal.aborted) {
        setNotice(
          'Recovery settings saved. Paperclip will use them on its next automatic cleanup attempt; retries may be delayed. Refresh status later to check progress.',
        );
        setRevision((value) => value + 1);
      }
    } catch (error) {
      if (!signal.aborted) setError(message(error));
    } finally {
      if (!signal.aborted) setSaving(false);
    }
  }

  const pending = snapshot?.pending.find((item) => item.lease.id === selected);
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Pending cleanup</h2>
        <button
          className={button}
          disabled={loading || saving}
          onClick={() => setRevision((value) => value + 1)}
        >
          Refresh status
        </button>
      </div>
      {notice && (
        <p role="status" className="rounded-md border p-3 text-sm">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-md border p-3 text-sm">
          {error}
        </p>
      )}
      {loading ? (
        <p role="status">Loading cleanup records…</p>
      ) : (
        snapshot && (
          <>
            {!snapshot.pending.length ? (
              <p role="status">
                No pending OpenShell cleanup records were found for this
                company’s existing environments.
              </p>
            ) : (
              <>
                <label className="block space-y-2">
                  <span className="text-sm font-medium">
                    Choose an environment awaiting cleanup
                  </span>
                  <select
                    className={input}
                    value={selected}
                    disabled={saving}
                    onChange={(event) => {
                      setSelected(event.target.value);
                      setNotice('');
                      setError('');
                    }}
                  >
                    {snapshot.pending.map((item, index) => (
                      <option key={item.lease.id} value={item.lease.id}>
                        {item.environment.name} · cleanup record {index + 1}
                      </option>
                    ))}
                  </select>
                </label>
                {pending && (
                  <RecoveryEditor
                    key={`${selected}:${revision}`}
                    pending={pending}
                    config={snapshot.config}
                    saving={saving}
                    onSave={save}
                  />
                )}
              </>
            )}
          </>
        )
      )}
    </>
  );
}

function RecoveryEditor({
  pending,
  config,
  saving,
  onSave,
}: {
  pending: PendingRecovery;
  config: Record<string, unknown>;
  saving: boolean;
  onSave: (
    pending: PendingRecovery,
    draft: CleanupRecovery,
    rejectedAttempt?: string,
  ) => Promise<void>;
}) {
  let initial: CleanupRecovery;
  let configError = '';
  try {
    initial = recoveryDraft(pending, config);
  } catch {
    initial = {
      environmentId: pending.environment.id,
      gateway: '',
      workspace: 'default',
      rejectedAttemptIds: [],
    };
    configError =
      'The saved recovery settings could not be read. Ask an administrator to review “Cleanup recovery entries” in plugin settings.';
  }
  const [gateway, setGateway] = useState(initial.gateway);
  const [workspace, setWorkspace] = useState(initial.workspace);
  const [configHome, setConfigHome] = useState(initial.configHome ?? '');
  const [rejected, setRejected] = useState(false);
  const attempt = creationAttempt(pending);
  const alreadyRejected = Boolean(
    attempt && initial.rejectedAttemptIds.includes(attempt),
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    void onSave(
      pending,
      {
        ...initial,
        gateway: gateway.trim(),
        workspace: workspace.trim() || 'default',
        configHome: configHome.trim() || undefined,
      },
      rejected ? attempt : undefined,
    );
  }

  return (
    <form className={panel} onSubmit={submit}>
      <div className="space-y-1">
        <h3 className="font-semibold">Review recovery settings</h3>
        <p className="text-sm">Status: awaiting automatic cleanup</p>
        <p className="text-sm text-muted-foreground">
          Saving requires an instance administrator. Paperclip will verify
          ownership and confirm deletion or the requested retained stop before
          it completes cleanup.
        </p>
      </div>
      {configError && <p role="alert">{configError}</p>}
      <fieldset disabled={saving || Boolean(configError)} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="text-sm font-medium">Original gateway</span>
            <input
              className={input}
              required
              value={gateway}
              readOnly={Boolean(initial.gateway)}
              onChange={(event) => setGateway(event.target.value)}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium">Original workspace</span>
            <input
              className={input}
              value={workspace}
              readOnly={Boolean(initial.gateway)}
              onChange={(event) => setWorkspace(event.target.value)}
            />
          </label>
        </div>
        <p className="text-sm text-muted-foreground">
          These identify the original allocation. Saved connection details take
          priority over changes to the environment.
        </p>
        <label className="block space-y-1">
          <span className="text-sm font-medium">
            Worker configuration directory (optional)
          </span>
          <input
            className={input}
            value={configHome}
            onChange={(event) => setConfigHome(event.target.value)}
            placeholder="/absolute/path/to/.config"
            pattern="/.*"
          />
          <span className="block text-sm text-muted-foreground">
            If the directory moved, enter the absolute path on the Paperclip
            worker containing the openshell folder. This is not a directory on
            your own computer. Leave blank to use the saved lease or worker
            configuration.
          </span>
        </label>
        {attempt && (
          <details className="space-y-3 text-sm">
            <summary className="cursor-pointer font-medium">
              Advanced: creation was rejected
            </summary>
            <p>
              Use only if gateway or CLI evidence confirms this exact creation
              request was rejected before allocation. A timeout or “sandbox not
              found” result is not proof: creation may still finish later.
            </p>
            {alreadyRejected ? (
              <p>This attempt is already recorded as verified rejected.</p>
            ) : (
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={rejected}
                  onChange={(event) => setRejected(event.target.checked)}
                />
                <span>
                  I have verified that this creation attempt was rejected.
                  Paperclip must still confirm absence in the original gateway
                  and workspace.
                </span>
              </label>
            )}
            <p className="break-all">
              Creation attempt: <code>{attempt}</code>
            </p>
          </details>
        )}
        <button
          className={`${button} bg-primary text-primary-foreground`}
          type="submit"
        >
          {saving ? 'Saving…' : 'Save recovery settings'}
        </button>
      </fieldset>
      <details className="text-sm space-y-2">
        <summary className="cursor-pointer">Technical details</summary>
        <p className="break-all">Environment: {pending.environment.id}</p>
        <p className="break-all">Cleanup lease: {pending.lease.id}</p>
        <p className="break-all">
          Provider lease: {pending.lease.providerLeaseId ?? 'Not recorded'}
        </p>
        <p>
          Last record update:{' '}
          {new Date(pending.lease.updatedAt).toLocaleString()}
        </p>
      </details>
    </form>
  );
}
