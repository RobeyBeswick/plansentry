export interface CdkInvocation {
  /** Program as written (`cdk`, `./node_modules/.bin/cdk`, ...). */
  bin: string;
  sub: string;
  args: string[];
  /** Stack name patterns given as positionals. */
  stacks: string[];
  all: boolean;
  exclusively: boolean;
  app?: string;
  output?: string;
  profile?: string;
  hotswap: 'none' | 'hotswap' | 'hotswap-fallback';
  method?: string;
  force: boolean;
}

/** Options (global + deploy/destroy) that take a separate value. */
const VALUE_OPTIONS = new Set([
  '--app', '-a', '--output', '-o', '--context', '-c', '--profile', '--plugin', '-p',
  '--role-arn', '-r', '--toolkit-stack-name', '--ca-bundle-path', '--proxy', '--method', '-m',
  '--parameters', '--outputs-file', '-O', '--require-approval', '--notification-arns',
  '--tags', '-t', '--concurrency', '--change-set-name', '--build-exclude', '-E', '--progress',
  '--asset-parallelism', '--asset-prebuild', '--lookup-role-arn', '--unstable', '--language', '-l',
  '--hotswap-ecs-minimum-healthy-percent', '--hotswap-ecs-maximum-healthy-percent',
  '--hotswap-ecs-stabilization-timeout-seconds', '--resource-mapping', '--record-resource-mapping',
]);

function optName(a: string): string {
  const eq = a.indexOf('=');
  return eq === -1 ? a : a.slice(0, eq);
}

function optValue(args: string[], names: string[]): string | undefined {
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const name = optName(a);
    if (!names.includes(name)) continue;
    value = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[i + 1];
  }
  return value;
}

function boolOpt(args: string[], names: string[]): boolean {
  let v = false;
  for (const a of args) {
    const name = optName(a);
    if (names.includes(name)) v = !a.endsWith('=false');
    if (names.some((n) => n.startsWith('--') && name === `--no-${n.slice(2)}`)) v = false;
  }
  return v;
}

export function parseCdk(argv: string[]): CdkInvocation {
  const [bin = 'cdk', ...rest] = argv;
  // The subcommand is the first positional; global options may precede it.
  let sub = '';
  const args: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!sub && !a.startsWith('-')) {
      sub = a;
      continue;
    }
    args.push(a);
    if (a.startsWith('-') && !a.includes('=') && VALUE_OPTIONS.has(a) && i + 1 < rest.length) {
      args.push(rest[++i]!);
    }
  }

  const stacks: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') {
      stacks.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('-')) {
      if (!a.includes('=') && VALUE_OPTIONS.has(a)) i++;
      continue;
    }
    stacks.push(a);
  }

  let hotswap: CdkInvocation['hotswap'] = 'none';
  if (boolOpt(args, ['--hotswap'])) hotswap = 'hotswap';
  if (boolOpt(args, ['--hotswap-fallback'])) hotswap = 'hotswap-fallback';

  return {
    bin,
    sub,
    args,
    stacks,
    all: boolOpt(args, ['--all']),
    exclusively: boolOpt(args, ['--exclusively', '-e']),
    app: optValue(args, ['--app', '-a']),
    output: optValue(args, ['--output', '-o']),
    profile: optValue(args, ['--profile']),
    hotswap,
    method: optValue(args, ['--method', '-m']),
    force: boolOpt(args, ['--force', '-f']),
  };
}

export type CdkOperation =
  | { kind: 'deploy' }
  | { kind: 'destroy' }
  | { kind: 'watch' }
  | { kind: 'risky'; description: string }
  | { kind: 'safe' };

export function classifyCdk(inv: CdkInvocation): CdkOperation {
  switch (inv.sub) {
    case 'deploy':
      return { kind: 'deploy' };
    case 'destroy':
      return { kind: 'destroy' };
    case 'watch':
      return { kind: 'watch' };
    case 'import':
      return { kind: 'risky', description: 'cdk import (adopts existing resources into a stack)' };
    case 'refactor':
      if (inv.args.includes('--dry-run')) return { kind: 'safe' };
      return { kind: 'risky', description: 'cdk refactor (moves resources between logical IDs/stacks)' };
    case 'orphan':
      return { kind: 'risky', description: 'cdk orphan (detaches resources from their stack)' };
    case 'gc':
      if (inv.args.some((a) => a === '--action=print' || a.startsWith('--dry'))) return { kind: 'safe' };
      return { kind: 'risky', description: 'cdk gc (deletes unused bootstrap assets)' };
    default:
      return { kind: 'safe' };
  }
}
