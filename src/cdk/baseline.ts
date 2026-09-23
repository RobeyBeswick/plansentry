import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StackArtifact } from './assembly.js';

type Template = Record<string, unknown>;

export type Baseline =
  | { kind: 'deployed'; template: Template; source: 'cloudformation' | 'local' }
  | { kind: 'new' }
  | { kind: 'unknown'; reason: string };

export interface BaselineOptions {
  projectDir: string;
  env: NodeJS.ProcessEnv;
  profile?: string;
  /** Skip AWS calls (tests, offline). */
  offline?: boolean;
}

const AWS_TIMEOUT_MS = 60_000;

function awsArgs(opts: BaselineOptions, region?: string): string[] {
  const a = ['--output', 'json', '--cli-read-timeout', '30', '--cli-connect-timeout', '10'];
  if (region) a.push('--region', region);
  if (opts.profile) a.push('--profile', opts.profile);
  return a;
}

function aws(args: string[], opts: BaselineOptions) {
  return spawnSync('aws', args, {
    env: { ...opts.env, AWS_PAGER: '' },
    encoding: 'utf8',
    timeout: AWS_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });
}

const callerAccounts = new Map<string, string | undefined>();
function callerAccount(opts: BaselineOptions): string | undefined {
  const key = opts.profile ?? '';
  if (!callerAccounts.has(key)) {
    const res = aws(['sts', 'get-caller-identity', ...awsArgs(opts)], opts);
    let account: string | undefined;
    if (res.status === 0) {
      try {
        account = (JSON.parse(res.stdout) as { Account?: string }).Account;
      } catch {
        account = undefined;
      }
    }
    callerAccounts.set(key, account);
  }
  return callerAccounts.get(key);
}

function localPath(stack: StackArtifact, projectDir: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(projectDir, '.plansentry', 'cdk-baselines', `${safe(stack.account ?? 'any')}-${safe(stack.region ?? 'any')}-${safe(stack.stackName)}.json`);
}

function readLocal(stack: StackArtifact, projectDir: string): Template | undefined {
  const p = localPath(stack, projectDir);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Template;
  } catch {
    return undefined;
  }
}

export function saveLocalBaseline(stack: StackArtifact, template: Template, projectDir: string): void {
  const p = localPath(stack, projectDir);
  mkdirSync(join(projectDir, '.plansentry', 'cdk-baselines'), { recursive: true });
  const ignore = join(projectDir, '.plansentry', '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  writeFileSync(p, JSON.stringify(template));
}

/**
 * What CloudFormation has deployed for this stack. Prefers the live template;
 * falls back to the one plansentry saved after its last successful deploy.
 */
export function getBaseline(stack: StackArtifact, opts: BaselineOptions): Baseline {
  const local = () => readLocal(stack, opts.projectDir);
  if (opts.offline) {
    const t = local();
    return t ? { kind: 'deployed', template: t, source: 'local' } : { kind: 'unknown', reason: 'offline and no saved baseline' };
  }

  const region = stack.region ?? opts.env.AWS_REGION ?? opts.env.AWS_DEFAULT_REGION;
  // CDK deploys into the stack's account through bootstrap roles; if our credentials are
  // for another account, "stack does not exist" would be a lie.
  if (stack.account) {
    const acct = callerAccount(opts);
    if (acct && acct !== stack.account) {
      const t = local();
      if (t) return { kind: 'deployed', template: t, source: 'local' };
      return { kind: 'unknown', reason: `credentials are for another account than the stack's (${stack.account})` };
    }
  }

  const res = aws(['cloudformation', 'get-template', '--stack-name', stack.stackName, '--template-stage', 'Original', ...awsArgs(opts, region)], opts);
  if (res.error) {
    const t = local();
    if (t) return { kind: 'deployed', template: t, source: 'local' };
    const why = (res.error as NodeJS.ErrnoException).code === 'ENOENT' ? 'the aws CLI is not installed' : res.error.message;
    return { kind: 'unknown', reason: why };
  }
  if (res.status === 0) {
    try {
      const body = (JSON.parse(res.stdout) as { TemplateBody?: unknown }).TemplateBody;
      const template = typeof body === 'string' ? (JSON.parse(body) as Template) : (body as Template);
      return { kind: 'deployed', template, source: 'cloudformation' };
    } catch {
      return { kind: 'unknown', reason: 'the deployed template is not JSON (YAML templates are not supported)' };
    }
  }
  const stderr = res.stderr ?? '';
  if (/does not exist/i.test(stderr)) return { kind: 'new' };
  const t = local();
  if (t) return { kind: 'deployed', template: t, source: 'local' };
  const first = stderr.trim().split('\n').filter(Boolean).pop() ?? `aws exited with ${res.status}`;
  return { kind: 'unknown', reason: first.slice(0, 200) };
}
