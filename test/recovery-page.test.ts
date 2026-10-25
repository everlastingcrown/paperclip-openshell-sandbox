import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { pluginId } from '../src/plugin-id.js';

test('guided recovery page explains, prefills, saves and refreshes without running cleanup', async (t) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://paperclip.test',
  });
  const priorFetch = globalThis.fetch;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createElement, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const container = document.getElementById('root')!;
  const root = createRoot(container);
  let companyId: string | null = 'company';
  let pending = true;
  let denied = false;
  let settingsLoading = false;
  let settingsError = false;
  let pathname = '/COMPANY/openshell-recovery';
  let settingsRefreshes = 0;
  const refreshSettings = () => {
    settingsRefreshes++;
  };
  let config: any = {};
  const writes: any[] = [];
  const urls: string[] = [];
  const attemptId = '12345678-1234-1234-1234-123456789abc';
  const lease = {
    id: 'lease',
    companyId: 'company',
    environmentId: 'env',
    provider: 'openshell',
    providerLeaseId: 'pc-sandbox',
    status: 'pending_cleanup',
    updatedAt: '2026-10-25T00:00:00Z',
    metadata: {
      pluginKey: pluginId,
      gateway: 'saved-gateway',
      workspace: 'saved-workspace',
      configHome: '/original/config',
      failedCreateCleanup: {
        companyId: 'company',
        environmentId: 'env',
        providerLeaseId: 'pc-sandbox',
        attemptId,
      },
    },
  };
  (globalThis as any).__paperclipPluginBridge__ = {
    sdkUi: {
      useHostContext: () => ({ companyId }),
      useHostLocation: () => ({ pathname }),
      useHostNavigation: () => ({
        resolveHref: (to: string) => `/COMPANY${to}`,
        linkProps: (to: string) => ({ href: `/COMPANY${to}` }),
      }),
      usePluginData: (key: string) => {
        assert.equal(key, 'recovery-page-settings');
        return {
          loading: settingsLoading,
          error: settingsError ? { message: 'private diagnostics' } : null,
          data: { showRecoveryPage: config.showRecoveryPage !== false },
          refresh: refreshSettings,
        };
      },
    },
  };
  globalThis.fetch = async (path, init) => {
    const url = String(path);
    urls.push(url);
    if (init?.method === 'POST') {
      if (denied)
        return new Response('{"error":"private diagnostics"}', { status: 403 });
      const body = JSON.parse(String(init.body));
      writes.push(body);
      config = body.configJson;
      return Response.json({ configJson: config });
    }
    if (url.includes('/config?')) return Response.json({ configJson: config });
    if (url.endsWith('/environments'))
      return Response.json([
        {
          id: 'env',
          name: 'Dev sandbox',
          config: { provider: 'openshell', gateway: 'edited' },
        },
      ]);
    if (url.includes('/environment-leases/')) return Response.json(lease);
    return Response.json(pending ? [lease] : []);
  };
  const { RecoveryPage, RecoveryLink } = await import('../src/ui/index.js');
  const render = async () => {
    await act(async () => {
      root.render(createElement(RecoveryPage));
    });
  };
  const click = async (label: string) => {
    const element = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === label,
    );
    assert.ok(element, label);
    await act(async () => {
      element.click();
    });
  };
  const submit = async () => {
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(
          new dom.window.Event('submit', { bubbles: true, cancelable: true }),
        );
    });
  };

  try {
    await t.test(
      'names and scope are filled in, with honest limitations and no default rejection',
      async () => {
        await render();
        assert.match(
          container.textContent!,
          /does not run cleanup immediately/,
        );
        assert.match(container.textContent!, /Dev sandbox/);
        assert.match(container.textContent!, /instance administrator/);
        const fields = container.querySelectorAll('input');
        assert.equal(fields[0].value, 'saved-gateway');
        assert.equal(fields[0].readOnly, true);
        assert.equal(fields[1].value, 'saved-workspace');
        assert.equal(fields[2].value, '/original/config');
        assert.equal(
          container.querySelector<HTMLInputElement>('[type=checkbox]')!.checked,
          false,
        );
        assert.equal(writes.length, 0);
      },
    );

    await t.test(
      'edits the worker directory and saves without declaring creation rejected',
      async () => {
        const directory = container.querySelectorAll('input')[2];
        await act(async () => {
          Object.getOwnPropertyDescriptor(
            dom.window.HTMLInputElement.prototype,
            'value',
          )!.set!.call(directory, '/moved/config');
          directory.dispatchEvent(
            new dom.window.Event('input', { bubbles: true }),
          );
        });
        await submit();
        assert.equal(writes.length, 1);
        assert.equal(
          writes[0].configJson.cleanupRecovery[0].configHome,
          '/moved/config',
        );
        assert.deepEqual(
          writes[0].configJson.cleanupRecovery[0].rejectedAttemptIds,
          [],
        );
        assert.match(container.textContent!, /Recovery settings saved/);
        assert.match(container.textContent!, /retries may be delayed/);
      },
    );

    await t.test(
      'records only the selected attempt after explicit rejection confirmation',
      async () => {
        const checkbox =
          container.querySelector<HTMLInputElement>('[type=checkbox]')!;
        await act(async () => {
          checkbox.click();
        });
        await submit();
        assert.deepEqual(
          writes[1].configJson.cleanupRecovery[0].rejectedAttemptIds,
          [attemptId],
        );
        assert.match(
          container.textContent!,
          /already recorded as verified rejected/,
        );
      },
    );

    await t.test(
      'permission denial is actionable and does not claim settings were saved',
      async () => {
        denied = true;
        await submit();
        assert.match(
          container.querySelector('[role=alert]')!.textContent!,
          /requires an instance administrator/,
        );
        assert.doesNotMatch(
          container.textContent!,
          /private diagnostics|Recovery settings saved/,
        );
        assert.equal(writes.length, 2);
        denied = false;
      },
    );

    await t.test(
      'refresh observes cleanup completion without a destructive request',
      async () => {
        pending = false;
        await click('Refresh status');
        assert.match(
          container.textContent!,
          /No pending OpenShell cleanup records/,
        );
        assert.equal(container.querySelector('form'), null);
        assert.ok(urls.every((url) => !/destroy|probe|wakeup|retry/.test(url)));
      },
    );

    await t.test(
      'changing company removes the previous company records and form',
      async () => {
        pending = true;
        companyId = 'other-company';
        await render();
        assert.match(
          container.textContent!,
          /No pending OpenShell cleanup records/,
        );
        assert.doesNotMatch(
          container.textContent!,
          /Dev sandbox|Recovery settings saved/,
        );
        companyId = null;
        await render();
        assert.match(container.textContent!, /Select a company/);
        assert.equal(container.querySelector('form'), null);
      },
    );

    await t.test(
      'disabled page does not load leases and explains how to enable it',
      async () => {
        companyId = 'company';
        config.showRecoveryPage = false;
        const requests = urls.length;
        await render();
        assert.match(container.textContent!, /disabled for this company/);
        assert.match(container.textContent!, /Show OpenShell recovery page/);
        assert.equal(container.querySelector('form'), null);
        assert.equal(urls.length, requests);
      },
    );

    await t.test(
      'page waits for visibility settings and offers retry on failure',
      async () => {
        const requests = urls.length;
        settingsLoading = true;
        await render();
        assert.match(container.textContent!, /Loading recovery page settings/);
        settingsLoading = false;
        settingsError = true;
        await render();
        assert.match(
          container.querySelector('[role=alert]')!.textContent!,
          /settings could not be loaded/,
        );
        assert.doesNotMatch(container.textContent!, /private diagnostics/);
        await click('Try again');
        assert.equal(settingsRefreshes, 1);
        assert.equal(urls.length, requests);
        settingsError = false;
      },
    );

    await t.test(
      'sidebar matches native navigation with an icon, accessible label and active state',
      async () => {
        delete config.showRecoveryPage;
        await act(async () => root.render(createElement(RecoveryLink)));
        const link = container.querySelector('a')!;
        assert.equal(link.textContent, 'OpenShell recovery');
        assert.equal(link.getAttribute('href'), '/COMPANY/openshell-recovery');
        assert.equal(link.getAttribute('aria-current'), 'page');
        assert.equal(
          link.querySelector('svg')!.getAttribute('aria-hidden'),
          'true',
        );
        pathname = '/COMPANY/dashboard';
        await act(async () => root.render(createElement(RecoveryLink)));
        assert.equal(
          container.querySelector('a')!.getAttribute('aria-current'),
          null,
        );
        dom.window.dispatchEvent(new dom.window.Event('focus'));
        assert.equal(settingsRefreshes, 2);
      },
    );

    await t.test(
      'sidebar hides when disabled, loading, unavailable or outside a company',
      async () => {
        config.showRecoveryPage = false;
        await act(async () => root.render(createElement(RecoveryLink)));
        assert.equal(container.querySelector('a'), null);
        config.showRecoveryPage = true;
        settingsLoading = true;
        await act(async () => root.render(createElement(RecoveryLink)));
        assert.equal(container.querySelector('a'), null);
        settingsLoading = false;
        settingsError = true;
        await act(async () => root.render(createElement(RecoveryLink)));
        assert.equal(container.querySelector('a'), null);
        settingsError = false;
        companyId = null;
        await act(async () => root.render(createElement(RecoveryLink)));
        assert.equal(container.querySelector('a'), null);
      },
    );
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = priorFetch;
    delete (globalThis as any).__paperclipPluginBridge__;
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
    delete (globalThis as any).window;
    delete (globalThis as any).document;
    dom.window.close();
  }
});
