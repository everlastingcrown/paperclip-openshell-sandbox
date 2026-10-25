import { isScopeName } from './validation.js';
export const remotePath = '/sandbox/paperclip-workspace';
export const runtimeTools =
  'sh bash node git tar base64 cat mkdir rm mv chmod find dd wc basename awk sed head tail touch cp ln sleep'.split(
    ' ',
  );
export interface Config {
  executable: string;
  sshExecutable: string;
  enableDuplex: boolean;
  configHome?: string;
  gateway: string;
  workspace: string;
  image: string;
  template?: string;
  policyFile?: string;
  providers: string[];
  timeoutMs: number;
  reuseLease: boolean;
}
const defaults = {
  executable: 'openshell',
  sshExecutable: 'ssh',
  workspace: 'default',
  timeoutMs: 300_000,
};
const isBlank = (value: unknown) => typeof value === 'string' && !value.trim();

export function parseConfig(raw: Record<string, unknown>): Config {
  const str = (key: string, fallback?: string) => {
    const value = isBlank(raw[key]) ? fallback : (raw[key] ?? fallback);
    if (typeof value !== 'string' || !value.trim() || value.includes('\0'))
      throw new Error(`Invalid ${key}`);
    return value;
  };
  const optional = (key: string) => {
    const value = raw[key];
    return value === undefined || (typeof value === 'string' && !value.trim())
      ? undefined
      : str(key);
  };
  const timeoutMs = isBlank(raw.timeoutMs)
    ? defaults.timeoutMs
    : (raw.timeoutMs ?? defaults.timeoutMs);
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 86_400_000
  )
    throw new Error('Invalid timeoutMs (1000–86400000)');
  if (raw.reuseLease !== undefined && typeof raw.reuseLease !== 'boolean')
    throw new Error('Invalid reuseLease');
  if (raw.enableDuplex !== undefined && typeof raw.enableDuplex !== 'boolean')
    throw new Error('Invalid enableDuplex');
  const providers = raw.providers ?? [];
  if (
    !Array.isArray(providers) ||
    providers.some(
      (p) => typeof p !== 'string' || !p.trim() || p.includes('\0'),
    )
  )
    throw new Error('Invalid providers');
  const gateway = str('gateway');
  const workspace = str('workspace', defaults.workspace);
  if (![gateway, workspace].every(isScopeName))
    throw new Error('Invalid gateway/workspace name');
  const configHome = optional('configHome');
  const policyFile = optional('policyFile');
  const template = optional('template');
  if (template && !isScopeName(template))
    throw new Error('Invalid template name');
  const image = optional('image');
  if (template && image)
    throw new Error(
      'Choose either a workload template or a container image; leave the other field blank',
    );
  if (!template && !image)
    throw new Error('Choose a workload template or enter a container image');
  if (policyFile && !policyFile.startsWith('/'))
    throw new Error('Invalid policyFile (expected absolute worker-local path)');
  if (configHome && !configHome.startsWith('/'))
    throw new Error(
      'Invalid configHome (expected absolute XDG config directory)',
    );
  return {
    executable: str('executable', defaults.executable),
    sshExecutable: str('sshExecutable', defaults.sshExecutable),
    enableDuplex: raw.enableDuplex === true,
    configHome,
    gateway,
    workspace,
    image: image ?? '',
    ...(template ? { template } : {}),
    policyFile,
    providers,
    timeoutMs,
    reuseLease: raw.reuseLease === true,
  };
}
export const configSchema = {
  type: 'object',
  additionalProperties: true,
  required: ['gateway'],
  // An unused source may be present as a cleared form field. Only a nonblank
  // value selects a source; oneOf still rejects two selected sources.
  oneOf: ['template', 'image'].map((key) => ({
    required: [key],
    properties: { [key]: { type: 'string', minLength: 1, pattern: '\\S' } },
  })),
  properties: {
    gateway: {
      type: 'string',
      title: 'OpenShell gateway',
      minLength: 1,
      description:
        'Name of a gateway already registered and authenticated on the Paperclip worker. Use its registered name, not a URL.',
    },
    workspace: {
      type: 'string',
      title: 'OpenShell workspace',
      default: defaults.workspace,
      description:
        'Workspace within the selected gateway. Leave blank to use "default". This is an OpenShell scope, not the sandbox filesystem path.',
    },
    configHome: {
      type: 'string',
      title: 'Worker configuration directory',
      description:
        'Absolute worker-local XDG_CONFIG_HOME containing the openshell directory, for example /home/paperclip/.config. Leave blank to inherit the worker configuration. Set this if the worker cannot find your registered gateway.',
    },
    template: {
      type: 'string',
      title: 'Workload template (choose template or image)',
      description:
        'Recommended: name of an existing OpenShell template defining the image, resources and environment. Fill in either this field or Container image below; leave the other blank. Policy and credential providers are configured separately under Advanced options.',
    },
    image: {
      type: 'string',
      title: 'Container image (alternative to template)',
      description:
        'Use an image reference instead of a template, for example registry.example.com/agent:tag. Leave blank when using a template. The image must contain the agent tooling, Node.js, Bash, Git and workspace transfer tools listed in the README. Use a template to configure resources and environment.',
    },
    policyFile: {
      type: 'string',
      title: 'Sandbox policy file',
      'x-paperclip-advanced': true,
      'x-paperclip-group': 'Policy and credentials',
      description:
        'Absolute path to an existing policy YAML file on the Paperclip worker, not inside the sandbox. Leave blank to use OpenShell policy behavior. Applies to both template and image workloads; the plugin does not generate policy.',
    },
    providers: {
      type: 'array',
      title: 'Credential providers',
      items: { type: 'string', minLength: 1 },
      default: [],
      'x-paperclip-advanced': true,
      'x-paperclip-group': 'Policy and credentials',
      description:
        'Add one existing, authenticated OpenShell credential-provider name per item, for example github. Applies to both template and image workloads. Leave the list empty for no explicit bindings; do not enter credentials here.',
    },
    timeoutMs: {
      type: 'integer',
      title: 'Operation timeout (milliseconds)',
      minimum: 1000,
      maximum: 86400000,
      default: defaults.timeoutMs,
      'x-paperclip-advanced': true,
      'x-paperclip-group': 'Lifecycle',
      description:
        'Budget for acquisition and CLI operations. Default: 300000 ms (5 minutes); allowed range: 1000 ms (1 second) to 86400000 ms (24 hours). Leave blank to keep the default. Paperclip may impose a shorter deadline.',
    },
    reuseLease: {
      type: 'boolean',
      title: 'Keep sandbox for reuse after release',
      default: false,
      'x-paperclip-advanced': true,
      'x-paperclip-group': 'Lifecycle',
      description:
        'Off by default: ordinary release deletes the sandbox. Enable to retain it for a later resume. Explicit stop preserves files and explicit destroy deletes the sandbox regardless of this setting.',
    },
    executable: {
      type: 'string',
      title: 'OpenShell CLI executable',
      default: defaults.executable,
      'x-paperclip-advanced': true,
      'x-paperclip-group': 'Worker executables',
      description:
        'Executable name on the worker PATH or absolute worker-local path. Leave blank to use openshell. Requires OpenShell CLI 0.1.2.',
    },
    sshExecutable: {
      type: 'string',
      title: 'SSH executable',
      default: defaults.sshExecutable,
      'x-paperclip-advanced': true,
      'x-paperclip-group': 'Worker executables',
      description:
        'Executable name on the worker PATH or absolute worker-local path for the duplex callback bridge. Leave blank to use ssh. Only needed when the bridge is enabled.',
    },
    enableDuplex: {
      type: 'boolean',
      title: 'Enable duplex callback bridge',
      default: false,
      'x-paperclip-advanced': true,
      'x-paperclip-group': 'Callback transport',
      description:
        "Off by default; runs use file polling. Requires Paperclip's instance setting enableSandboxDuplexBridge=true as well as this option. An instance admin must enable it through the instance settings API; see the provider README for instructions. Existing runs keep their current transport.",
    },
  },
};
