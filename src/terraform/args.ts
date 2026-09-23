import { tokenize } from '../shell/tokenize.js';

export type TerraformFlavor = 'terraform' | 'tofu';

export interface TerraformInvocation {
  flavor: TerraformFlavor;
  /** Program as written (may be a path). */
  bin: string;
  /** Global options before the subcommand, e.g. `-chdir=infra`. */
  globalArgs: string[];
  chdir?: string;
  /** Subcommand, e.g. `apply`, `state`. Empty when none given. */
  sub: string;
  /** Arguments after the subcommand, with TF_CLI_ARGS / TF_CLI_ARGS_<sub> folded in. */
  args: string[];
  /** Arguments exactly as written on the command line (without env injection). */
  explicitArgs: string[];
  /** Args injected from environment variables, for reporting. */
  injected: { variable: string; args: string[] }[];
}

export function terraformFlavor(program: string): TerraformFlavor | undefined {
  if (program === 'terraform') return 'terraform';
  if (program === 'tofu' || program === 'opentofu') return 'tofu';
  return undefined;
}

/** Split an env var value the way Terraform does (shell-like word splitting). */
export function splitArgs(value: string): string[] {
  try {
    return tokenize(value)
      .filter((t) => t.type === 'word')
      .map((t) => (t as { value: string }).value);
  } catch {
    return value.split(/\s+/).filter(Boolean);
  }
}

export function parseTerraform(
  argv: string[],
  env: Record<string, string | undefined>,
  flavor: TerraformFlavor,
): TerraformInvocation {
  const [bin = flavor, ...rest] = argv;
  const globalArgs: string[] = [];
  let i = 0;
  while (i < rest.length && rest[i]!.startsWith('-')) {
    globalArgs.push(rest[i]!);
    i++;
  }
  const sub = rest[i] ?? '';
  const explicitArgs = rest.slice(i + 1);
  const chdirArg = globalArgs.find((a) => a.startsWith('-chdir='));

  const injected: { variable: string; args: string[] }[] = [];
  const generic = env.TF_CLI_ARGS;
  if (generic) injected.push({ variable: 'TF_CLI_ARGS', args: splitArgs(generic) });
  if (sub) {
    const specificName = `TF_CLI_ARGS_${sub.replace(/-/g, '_')}`;
    const specific = env[specificName];
    if (specific) injected.push({ variable: specificName, args: splitArgs(specific) });
  }

  return {
    flavor,
    bin,
    globalArgs,
    chdir: chdirArg?.slice('-chdir='.length),
    sub,
    // Terraform inserts env args right after the subcommand.
    args: [...injected.flatMap((x) => x.args), ...explicitArgs],
    explicitArgs,
    injected,
  };
}

/** Boolean flag lookup handling `-flag`, `-flag=true`, `--flag`. */
export function hasFlag(args: string[], name: string): boolean {
  let result = false;
  for (const a of args) {
    const m = /^--?([^=]+)(?:=(.*))?$/.exec(a);
    if (!m || m[1] !== name) continue;
    const v = m[2];
    result = v === undefined || !['false', '0', 'no', 'off'].includes(v.toLowerCase());
  }
  return result;
}

export function flagValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const m = /^--?([^=]+)(?:=(.*))?$/.exec(args[i]!);
    if (!m || m[1] !== name) continue;
    if (m[2] !== undefined) values.push(m[2]);
    else if (i + 1 < args.length) values.push(args[++i]!);
  }
  return values;
}

/** Flags of `apply`/`plan` that take a separate value when written without `=`. */
const VALUE_FLAGS = new Set(['var', 'var-file', 'target', 'replace', 'state', 'state-out', 'backup', 'lock-timeout', 'parallelism', 'out', 'exclude']);

/** Positional (non-flag) arguments of apply: at most one, the saved plan file. */
export function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('-')) {
      const m = /^--?([^=]+)(=.*)?$/.exec(a);
      if (m && !m[2] && VALUE_FLAGS.has(m[1]!)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

export type TerraformOperation =
  | { kind: 'apply'; planFile?: string; destroy: boolean; autoApprove: boolean }
  | { kind: 'destroy'; autoApprove: boolean }
  | { kind: 'state-mutation'; description: string }
  | { kind: 'safe' };

export function classifyTerraform(inv: TerraformInvocation): TerraformOperation {
  const a = inv.args;
  switch (inv.sub) {
    case 'apply': {
      const pos = positionals(a);
      return {
        kind: 'apply',
        planFile: pos[0],
        destroy: hasFlag(a, 'destroy'),
        autoApprove: hasFlag(a, 'auto-approve'),
      };
    }
    case 'destroy':
      return { kind: 'destroy', autoApprove: hasFlag(a, 'auto-approve') };
    case 'state': {
      const op = a.find((x) => !x.startsWith('-'));
      if (op && ['rm', 'mv', 'push', 'replace-provider'].includes(op)) {
        return { kind: 'state-mutation', description: `${inv.flavor} state ${op}` };
      }
      return { kind: 'safe' };
    }
    case 'taint':
      return { kind: 'state-mutation', description: `${inv.flavor} taint (forces replacement on next apply)` };
    case 'force-unlock':
      return { kind: 'state-mutation', description: `${inv.flavor} force-unlock` };
    case 'workspace':
      if (a.find((x) => !x.startsWith('-')) === 'delete') {
        return { kind: 'state-mutation', description: `${inv.flavor} workspace delete` };
      }
      return { kind: 'safe' };
    default:
      return { kind: 'safe' };
  }
}
