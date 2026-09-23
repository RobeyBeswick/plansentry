import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { shellQuote } from '../detect.js';
import { emptyAnalysis, mergeAnalyses, type Analysis } from '../findings.js';
import { EXIT_NEEDS_APPROVAL, ackMismatchMessage, agentInstructions, gate } from '../gate.js';
import { evaluate } from '../policy/evaluate.js';
import { renderReport } from '../report.js';
import type { RunContext } from '../terraform/runner.js';
import { analyzeCdkDestroy, analyzeCdkStack } from './analyze.js';
import { classifyCdk, parseCdk } from './args.js';
import { AssemblyError, readAssembly, readTemplate, selectStacks, type StackArtifact } from './assembly.js';
import { getBaseline, saveLocalBaseline } from './baseline.js';
import { runGuardedCommand } from '../guarded.js';

const log = (s: string) => process.stderr.write(`${s}\n`);

/** Options that affect synthesis and must be passed through to `cdk synth`. */
const SYNTH_VALUE_OPTS = new Set(['--app', '-a', '--context', '-c', '--profile', '--plugin', '-p', '--ca-bundle-path', '--proxy', '--lookup-role-arn', '--unstable']);
const SYNTH_BOOL_OPTS = new Set([
  '--strict', '--lookups', '--no-lookups', '--ignore-errors', '--staging', '--no-staging', '--debug', '--verbose', '-v',
  '--version-reporting', '--no-version-reporting', '--path-metadata', '--no-path-metadata', '--asset-metadata',
  '--no-asset-metadata', '--ec2creds', '--no-ec2creds',
]);

function optName(a: string): string {
  const eq = a.indexOf('=');
  return eq === -1 ? a : a.slice(0, eq);
}

function synthArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const name = optName(a);
    if (SYNTH_VALUE_OPTS.has(name)) {
      out.push(a);
      if (!a.includes('=') && i + 1 < args.length) out.push(args[++i]!);
    } else if (SYNTH_BOOL_OPTS.has(name) || /^-v+$/.test(a)) out.push(a);
  }
  return out;
}

/** Remove `--app`/`--output` so we can point the CLI at the checked assembly. */
function withoutAppAndOutput(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const name = optName(a);
    if (['--app', '-a', '--output', '-o'].includes(name)) {
      if (!a.includes('=')) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function assembliesDir(projectDir: string): string {
  const dir = join(projectDir, '.plansentry', 'assemblies');
  mkdirSync(dir, { recursive: true });
  const ignore = join(projectDir, '.plansentry', '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  return dir;
}

function run(argv: string[], ctx: RunContext, toStderr = false) {
  const [cmd, ...args] = argv;
  return spawnSync(cmd!, args, { cwd: ctx.cwd, env: ctx.env, stdio: toStderr ? ['inherit', 2, 2] : 'inherit' });
}

/** Stacks that depend on the given ones (what `cdk destroy` also removes). */
function withDependents(all: StackArtifact[], selected: StackArtifact[]): StackArtifact[] {
  const out = [...selected];
  const ids = new Set(selected.map((s) => s.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of all) {
      if (!ids.has(s.id) && s.dependencies.some((d) => ids.has(d))) {
        ids.add(s.id);
        out.push(s);
        grew = true;
      }
    }
  }
  return out;
}

export function runCdk(argv: string[], ctx: RunContext & { offline?: boolean }): number {
  const inv = parseCdk(argv);
  const op = classifyCdk(inv);
  const bin = [...ctx.prefix, inv.bin];

  if (op.kind === 'safe') return run([...bin, inv.sub, ...inv.args], ctx).status ?? 1;
  if (op.kind === 'risky') return runGuardedCommand(op.description, [...bin, inv.sub, ...inv.args], ctx);
  if (op.kind === 'watch') {
    return runGuardedCommand('cdk watch deploys continuously (hotswap by default) without plan checks', [...bin, inv.sub, ...inv.args], ctx);
  }

  const projectDir = ctx.cwd;
  const givenApp = inv.app ? resolve(ctx.cwd, inv.app) : undefined;
  const usingAssembly = givenApp !== undefined && existsSync(join(givenApp, 'manifest.json'));
  let assemblyDir: string;
  if (usingAssembly) {
    assemblyDir = givenApp!;
  } else {
    assemblyDir = mkdtempSync(join(assembliesDir(projectDir), 'tmp-'));
    log('plansentry: synthesizing to check the templates that will be deployed');
    const res = run([...bin, 'synth', ...synthArgs(inv.args), '--quiet', '-o', assemblyDir], ctx, true);
    if (res.status !== 0) {
      rmSync(assemblyDir, { recursive: true, force: true });
      log(`plansentry: synth failed (exit ${res.status ?? 'signal'}); nothing was deployed.`);
      return res.status ?? 1;
    }
  }
  /** Temporary synth output always goes; a saved (approved) assembly only once it deployed. */
  const cleanup = (succeeded = false) => {
    const saved = usingAssembly && assemblyDir.includes(join('.plansentry', 'assemblies'));
    if (!usingAssembly || (saved && succeeded)) rmSync(assemblyDir, { recursive: true, force: true });
  };

  let stacks: StackArtifact[];
  try {
    const all = readAssembly(assemblyDir);
    const opts = { patterns: inv.stacks, all: inv.all, exclusively: inv.exclusively };
    stacks = op.kind === 'destroy'
      ? (inv.exclusively ? selectStacks(all, { ...opts, exclusively: true }) : withDependents(all, selectStacks(all, { ...opts, exclusively: true })))
      : selectStacks(all, opts);
  } catch (e) {
    cleanup();
    log(`plansentry: ${e instanceof AssemblyError ? e.message : (e as Error).message}`);
    return 1;
  }

  const parts: Analysis[] = [];
  for (const stack of stacks) {
    const baseline = getBaseline(stack, { projectDir, env: ctx.env, profile: inv.profile, offline: ctx.offline });
    if (baseline.kind === 'unknown') {
      const a = emptyAnalysis();
      a.blockers.push(`could not determine what is deployed for ${stack.displayName}: ${baseline.reason}`);
      parts.push(a);
      continue;
    }
    if (op.kind === 'destroy') {
      if (baseline.kind === 'new') continue;
      const a = analyzeCdkDestroy(stack.displayName, baseline.template, ctx.config);
      if (stack.terminationProtection) {
        for (const f of a.findings) f.notes.push('the stack has termination protection; CloudFormation will refuse to delete it');
      }
      parts.push(a);
    } else {
      const before = baseline.kind === 'deployed' ? baseline.template : {};
      parts.push(analyzeCdkStack({ stack: stack.displayName, before, after: readTemplate(stack) }, ctx.config));
    }
  }
  const analysis = mergeAnalyses(parts);
  if (op.kind === 'deploy' && inv.hotswap !== 'none') {
    analysis.findings.push({
      severity: 'warn',
      tool: 'cdk',
      address: stacks.map((s) => s.displayName).join(', ') || '(all stacks)',
      type: 'deployment',
      change: 'hotswap',
      reason: `--${inv.hotswap} updates resources directly, bypassing CloudFormation (causes drift; for development only)`,
      notes: [],
    });
  }

  const verdict = evaluate(analysis, ctx.config);
  log(renderReport(analysis, verdict, ctx));
  const g = gate(verdict, ctx);
  const finalArgs = [...withoutAppAndOutput(inv.args)];

  if (!g.ok) {
    let saved = assemblyDir;
    if (!usingAssembly) {
      saved = join(assembliesDir(projectDir), verdict.digest);
      rmSync(saved, { recursive: true, force: true });
      renameSync(assemblyDir, saved);
    }
    if (g.why === 'ack-mismatch') log(ackMismatchMessage(ctx.ack!, verdict.digest));
    else if (g.why === 'declined') log('plansentry: not approved; nothing was deployed.');
    else {
      const appArg = relative(ctx.cwd, saved) || '.';
      const rerun = ['plansentry', 'exec', '--ack', verdict.digest, '--', ...bin, inv.sub, ...finalArgs, '--app', appArg];
      log(agentInstructions(rerun.map(shellQuote).join(' '), verdict));
    }
    return EXIT_NEEDS_APPROVAL;
  }

  if (op.kind === 'destroy' && !inv.force && !ctx.interactive) {
    cleanup();
    log('plansentry: cdk destroy would ask for confirmation and there is no terminal; nothing was destroyed.');
    log('Re-run with --force to destroy after this check.');
    return 1;
  }

  const res = run([...bin, inv.sub, ...finalArgs, '--app', assemblyDir], ctx);
  if (res.status === 0 && op.kind === 'deploy') {
    for (const s of stacks) {
      try {
        saveLocalBaseline(s, readTemplate(s), projectDir);
      } catch {
        // best effort
      }
    }
  }
  cleanup(res.status === 0);
  return res.status ?? 1;
}
