export const remotePath = '/sandbox/paperclip-workspace';
export const runtimeTools =
  'sh bash node git tar base64 cat mkdir rm mv chmod find dd wc basename awk sed head tail touch cp ln sleep'.split(
    ' ',
  );
export function validateRuntimeImage(c: Config) {
  if (/^(?:docker\.io\/)?curlimages\/curl(?::|@|$)/.test(c.image))
    throw new Error(
      'curlimages/curl is a network test image, not a Paperclip runtime. Use an image containing bash, node, git and the required workspace tools (see README).',
    );
}
export interface Config {
  executable: string;
  configHome?: string;
  gateway: string;
  workspace: string;
  image: string;
  policyFile?: string;
  providers: string[];
  cpu?: string;
  memory?: string;
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
  if (
    ![gateway, workspace].every((v) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(v))
  )
    throw new Error('Invalid gateway/workspace name');
  const cpu =
    typeof raw.cpu === 'number' && Number.isFinite(raw.cpu)
      ? String(raw.cpu)
      : optional('cpu');
  const memory = optional('memory');
  const configHome = optional('configHome');
  if (configHome && !configHome.startsWith('/'))
    throw new Error(
      'Invalid configHome (expected absolute XDG config directory)',
    );
  if (cpu && (!/^(?:\d+(?:\.\d+)?|\d+m)$/.test(cpu) || parseFloat(cpu) <= 0))
    throw new Error('Invalid cpu');
  if (
    memory &&
    (!/^\d+(?:\.\d+)?(?:[EPTGMK]i?|m|k)?$/.test(memory) ||
      parseFloat(memory) <= 0)
  )
    throw new Error('Invalid memory');
  return {
    executable: str('executable', 'openshell'),
    configHome,
    gateway,
    workspace,
    image: str('image'),
    policyFile: optional('policyFile'),
    providers,
    cpu,
    memory,
    timeoutMs,
    reuseLease: raw.reuseLease === true,
  };
}
export const configSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['gateway', 'image'],
  properties: {
    executable: { type: 'string', default: 'openshell' },
    configHome: { type: 'string' },
    gateway: { type: 'string', minLength: 1 },
    workspace: { type: 'string', default: 'default' },
    image: { type: 'string', minLength: 1 },
    policyFile: { type: 'string' },
    providers: { type: 'array', items: { type: 'string' }, default: [] },
    cpu: {
      anyOf: [{ type: 'string' }, { type: 'number', exclusiveMinimum: 0 }],
    },
    memory: { type: 'string' },
    timeoutMs: {
      type: 'integer',
      minimum: 1000,
      maximum: 86400000,
      default: 300000,
    },
    reuseLease: { type: 'boolean', default: false },
  },
};
