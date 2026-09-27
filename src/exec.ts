import { spawnSync } from 'node:child_process';
import { runCdk } from './cdk/runner.js';
import { terragruntChangesState } from './detect.js';
import { EXIT_USAGE, isInteractive } from './gate.js';
import { runGuardedCommand } from './guarded.js';
import { ConfigError, loadConfig } from './policy/config.js';
import { normalize, programName } from './shell/normalize.js';
import type { WordToken } from './shell/tokenize.js';
import { terraformFlavor } from './terraform/args.js';
import { runTerraform, type RunContext } from './terraform/runner.js';

export interface ExecOptions {
  ack?: string;
  verbose: boolean;
  color: boolean;
  offline: boolean;
  argv: string[];
}

export function parseExecArgs(args: string[]): ExecOptions | string {
  const opts: ExecOptions = { verbose: false, color: Boolean(process.stderr.isTTY) && !process.env.NO_COLOR, offline: false, argv: [] };
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') {
      i++;
      break;
    }
    if (a === '--ack') opts.ack = args[++i];
    else if (a.startsWith('--ack=')) opts.ack = a.slice(6);
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '--no-color') opts.color = false;
    else if (a === '--offline') opts.offline = true;
    else if (a.startsWith('-')) return `unknown option ${a}`;
    else break; // tolerate a missing `--`
  }
  opts.argv = args.slice(i);
  if (!opts.argv.length) return 'no command given (usage: plansentry exec [--ack DIGEST] -- terraform apply ...)';
  if (opts.ack !== undefined && !/^[a-f0-9]{12}$/.test(opts.ack)) return `--ack expects a 12-character digest, got "${opts.ack}"`;
  return opts;
}

const word = (value: string): WordToken => ({ type: 'word', value, start: 0, end: 0, dynamic: false, substitutions: [] });

export function execMain(args: string[]): number {
  const parsed = parseExecArgs(args);
  if (typeof parsed === 'string') {
    process.stderr.write(`plansentry exec: ${parsed}\n`);
    return EXIT_USAGE;
  }
  const n = normalize({ words: parsed.argv.map(word), redirects: [], start: 0, end: 0 });
  if (n.opaqueReason || !n.argv.length) {
    process.stderr.write(`plansentry exec: can't run this through plansentry (${n.opaqueReason ?? 'no program'}).\n`);
    return EXIT_USAGE;
  }
  if (n.prefix.some((w) => w === 'xargs' || w === 'watch')) {
    process.stderr.write('plansentry exec: xargs/watch hide the real arguments; run the command directly.\n');
    return EXIT_USAGE;
  }

  let config;
  try {
    config = loadConfig(process.cwd());
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`plansentry: invalid config: ${e.message}\n`);
      return EXIT_USAGE;
    }
    throw e;
  }

  const ctx: RunContext & { offline: boolean } = {
    cwd: process.cwd(),
    env: { ...process.env, ...n.env },
    prefix: n.prefix,
    ack: parsed.ack,
    interactive: parsed.ack === undefined && isInteractive(),
    config,
    color: parsed.color,
    verbose: parsed.verbose,
    offline: parsed.offline,
  };

  const program = programName(n.argv[0]!);
  const flavor = terraformFlavor(program);
  if (flavor) return runTerraform(n.argv, ctx, flavor);
  if (program === 'cdk' || program === 'aws-cdk') return runCdk(n.argv, ctx);
  if (program === 'terragrunt') {
    const sub = n.argv.find((a, i) => i > 0 && !a.startsWith('-')) ?? '';
    // Scan every argument, not just the first positional: `--terragrunt-working-dir infra apply`.
    if (terragruntChangesState(n.argv.slice(1)) || ['run-all', 'run'].includes(sub)) {
      return runGuardedCommand('terragrunt plans are not analysed yet', [...n.prefix, ...n.argv], ctx);
    }
    const [cmd, ...rest] = [...n.prefix, ...n.argv];
    return spawnSync(cmd!, rest, { env: ctx.env, stdio: 'inherit' }).status ?? 1;
  }
  process.stderr.write(
    `plansentry exec only runs terraform, tofu and cdk commands directly (got \`${program}\`).\n` +
      'Run the underlying terraform/tofu/cdk command instead of a script or wrapper.\n',
  );
  return EXIT_USAGE;
}
