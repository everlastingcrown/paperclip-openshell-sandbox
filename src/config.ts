import { isScopeName } from './validation.js';
export const remotePath = '/sandbox/paperclip-workspace';
export const runtimeTools =
  'sh bash node git tar base64 cat mkdir rm mv chmod find dd wc basename awk sed head tail touch cp ln sleep'.split(
    ' ',
  );
export interface Config {
  executable: string;
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
export function parseConfig(raw: Record<string, unknown>): Config {
  const str = (key: string, fallback?: string) => {
    const value = raw[key] ?? fallback;
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
  const timeoutMs = raw.timeoutMs ?? 300_000;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 86_400_000
  )
    throw new Error('Invalid timeoutMs (1000–86400000)');
  if (raw.reuseLease !== undefined && typeof raw.reuseLease !== 'boolean')
    throw new Error('Invalid reuseLease');
  const providers = raw.providers ?? [];
  if (
    !Array.isArray(providers) ||
    providers.some(
      (p) => typeof p !== 'string' || !p.trim() || p.includes('\0'),
    )
  )
    throw new Error('Invalid providers');
  const gateway = str('gateway');
  const workspace = str('workspace', 'default');
  if (![gateway, workspace].every(isScopeName))
    throw new Error('Invalid gateway/workspace name');
  const configHome = optional('configHome');
  const policyFile = optional('policyFile');
  const template = optional('template');
  if (template && !isScopeName(template))
    throw new Error('Invalid template name');
  if (template && raw.image !== undefined)
    throw new Error(
      'Use template or image; configure template resources in OpenShell',
    );
  if (policyFile && !policyFile.startsWith('/'))
    throw new Error('Invalid policyFile (expected absolute worker-local path)');
  if (configHome && !configHome.startsWith('/'))
    throw new Error(
      'Invalid configHome (expected absolute XDG config directory)',
    );
  return {
    executable: str('executable', 'openshell'),
    configHome,
    gateway,
    workspace,
    image: template ? '' : str('image'),
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
  oneOf: [{ required: ['image'] }, { required: ['template'] }],
  properties: {
    executable: { type: 'string', default: 'openshell' },
    configHome: { type: 'string' },
    gateway: { type: 'string', minLength: 1 },
    workspace: { type: 'string', default: 'default' },
    image: { type: 'string', minLength: 1 },
    template: {
      type: 'string',
      minLength: 1,
      description:
        'Existing OpenShell workload template; configure resources directly in OpenShell',
    },
    policyFile: { type: 'string' },
    providers: { type: 'array', items: { type: 'string' }, default: [] },
    timeoutMs: {
      type: 'integer',
      minimum: 1000,
      maximum: 86400000,
      default: 300000,
    },
    reuseLease: { type: 'boolean', default: false },
  },
};
