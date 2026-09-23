import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { shellQuote } from '../detect.js';
import { runGuardedCommand } from '../guarded.js';
import { emptyAnalysis, type Analysis } from '../findings.js';
import { EXIT_NEEDS_APPROVAL, ackMismatchMessage, agentInstructions, gate, promptTty } from '../gate.js';
import { loadConfig, type Config } from '../policy/config.js';
import { evaluate } from '../policy/evaluate.js';
import { renderReport } from '../report.js';
import { analyzeTerraformPlan, type PlanJson } from './analyze.js';
import { classifyTerraform, hasFlag, parseTerraform, type TerraformFlavor } from './args.js';

export interface RunContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Wrapper words to keep (`aws-vault exec prod --`). */
  prefix: string[];
  ack?: string;
  interactive: boolean;
  config: Config;
  color: boolean;
  verbose: boolean;
}

const log = (s: string) => process.stderr.write(`${s}\n`);

/** Flags `apply` accepts when given a saved plan. Anything else would be rejected or change nothing. */
const SAVED_PLAN_APPLY_FLAGS = new Set(['lock', 'lock-timeout', 'parallelism', 'no-color', 'compact-warnings', 'json', 'input', 'state', 'state-out', 'backup']);
/** Flags of `apply` that `plan` doesn't take. */
const APPLY_ONLY_FLAGS = new Set(['auto-approve', 'backup', 'state-out']);

function flagName(a: string): string | undefined {
  const m = /^--?([^=]+)/.exec(a);
  return m?.[1];
}

/** Keep flags (and their separate values) whose name passes `keep`; drop positionals. */
function filterFlags(args: string[], keep: (name: string) => boolean): string[] {
  const out: string[] = [];
  const valueFlags = new Set(['var', 'var-file', 'target', 'replace', 'state', 'state-out', 'backup', 'lock-timeout', 'parallelism', 'out', 'exclude']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const name = flagName(a);
    if (!name) continue;
    const takesNext = !a.includes('=') && valueFlags.has(name) && i + 1 < args.length;
    if (keep(name)) {
      out.push(a);
      if (takesNext) out.push(args[i + 1]!);
    }
    if (takesNext) i++;
  }
  return out;
}

/**
 * Terraform without TF_CLI_ARGS*: we pass the effective arguments explicitly.
 * TF_IN_AUTOMATION stops it suggesting `terraform apply <planfile>`, which would send agents around plansentry.
 */
function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { TF_IN_AUTOMATION: '1' };
  for (const [k, v] of Object.entries(env)) if (!k.startsWith('TF_CLI_ARGS')) out[k] = v;
  return out;
}

function run(argv: string[], ctx: RunContext, capture = false) {
  const [cmd, ...args] = argv;
  return spawnSync(cmd!, args, {
    cwd: ctx.cwd,
    env: childEnv(ctx.env),
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : ['inherit', 'inherit', 'inherit'],
    maxBuffer: 1024 * 1024 * 1024,
    encoding: 'utf8',
  });
}

export function showPlan(bin: string[], planPath: string, ctx: RunContext): { plan?: PlanJson; error?: string } {
  const res = run([...bin, 'show', '-json', planPath], ctx, true);
  if (res.error) return { error: res.error.message };
  if (res.status !== 0) return { error: `\`show -json\` exited with ${res.status}` };
  try {
    return { plan: JSON.parse(res.stdout) as PlanJson };
  } catch (e) {
    return { error: `could not parse plan JSON: ${(e as Error).message}` };
  }
}

function plansDir(workDir: string): string {
  const dir = join(workDir, '.plansentry', 'plans');
  mkdirSync(dir, { recursive: true });
  const ignore = join(workDir, '.plansentry', '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  return dir;
}

export function runTerraform(argv: string[], baseCtx: RunContext, flavor: TerraformFlavor): number {
  const inv = parseTerraform(argv, baseCtx.env, flavor);
  const op = classifyTerraform(inv);
  const bin = [...baseCtx.prefix, inv.bin, ...inv.globalArgs];
  const workDir = resolve(baseCtx.cwd, inv.chdir ?? '.');
  // Policy belongs to the Terraform root module, not wherever the shell happens to be.
  const ctx = inv.chdir ? { ...baseCtx, config: loadConfig(workDir) } : baseCtx;

  if (op.kind === 'safe') return run([...bin, inv.sub, ...inv.args], ctx).status ?? 1;

  if (op.kind === 'state-mutation') {
    // No plan to inspect; the human approves the exact command line.
    return runGuardedCommand(`${op.description} changes state directly`, [...bin, inv.sub, ...inv.args], { ...ctx, env: childEnv(ctx.env) });
  }

  // apply / destroy
  let planPath: string;
  let userPlanFile = false;
  if (op.kind === 'apply' && op.planFile) {
    planPath = isAbsolute(op.planFile) ? op.planFile : resolve(workDir, op.planFile);
    userPlanFile = true;
  } else {
    const dir = plansDir(workDir);
    planPath = join(dir, `pending-${process.pid}-${Date.now()}.tfplan`);
    const planArgs = filterFlags(inv.args, (n) => !APPLY_ONLY_FLAGS.has(n) && n !== 'out' && n !== 'destroy');
    if (op.kind === 'destroy' || (op.kind === 'apply' && op.destroy)) planArgs.push('-destroy');
    if (!ctx.interactive && !inv.args.some((a) => flagName(a) === 'input')) planArgs.push('-input=false');
    if (!ctx.color && !inv.args.some((a) => flagName(a) === 'no-color')) planArgs.push('-no-color');
    planArgs.push(`-out=${planPath}`);
    log(`plansentry: planning first (${[inv.bin, inv.sub].join(' ')} will only apply the plan that was checked)`);
    const res = run([...bin, 'plan', ...planArgs], ctx);
    if (res.status !== 0) {
      rmSync(planPath, { force: true });
      log(`plansentry: plan failed (exit ${res.status ?? 'signal'}); nothing was applied.`);
      return res.status ?? 1;
    }
  }

  const shown = showPlan(bin, planPath, ctx);
  let analysis: Analysis;
  if (shown.plan) analysis = analyzeTerraformPlan(shown.plan, ctx.config);
  else {
    analysis = emptyAnalysis();
    analysis.blockers.push(`could not read the plan: ${shown.error}`);
  }
  const verdict = evaluate(analysis, ctx.config);
  log(renderReport(analysis, verdict, ctx));
  const g = gate(verdict, ctx);

  const applyFlags = filterFlags(inv.args, (n) => SAVED_PLAN_APPLY_FLAGS.has(n));

  if (!g.ok) {
    let saved = planPath;
    if (!userPlanFile) {
      saved = join(plansDir(workDir), `${verdict.digest}.tfplan`);
      renameSync(planPath, saved);
    }
    if (g.why === 'ack-mismatch') log(ackMismatchMessage(ctx.ack!, verdict.digest));
    else if (g.why === 'declined') log('plansentry: not approved; nothing was applied.');
    else {
      const rerun = ['plansentry', 'exec', '--ack', verdict.digest, '--', ...bin, 'apply', ...applyFlags, saved];
      log(agentInstructions(rerun.map(shellQuote).join(' '), verdict));
    }
    return EXIT_NEEDS_APPROVAL;
  }

  const hasChanges = analysis.counts.create + analysis.counts.update + analysis.counts.delete + analysis.counts.replace + analysis.counts.other > 0;
  // Keep Terraform's own confirmation semantics: without -auto-approve it asks.
  const wantsConfirm = !userPlanFile && !hasFlag(inv.args, 'auto-approve') && g.how === 'clean';
  if (wantsConfirm && hasChanges) {
    if (!ctx.interactive) {
      rmSync(planPath, { force: true });
      log(`plansentry: ${inv.bin} ${inv.sub} would ask for confirmation here and there is no terminal; nothing was applied.`);
      log('Re-run with -auto-approve to apply after this check.');
      return 1;
    }
    if (promptTty('\nDo you want to perform these actions? Only "yes" will be accepted: ') !== 'yes') {
      rmSync(planPath, { force: true });
      log('Apply cancelled.');
      return 1;
    }
  }

  const applyArgs = userPlanFile ? [...inv.args] : [...applyFlags, planPath];
  if (!ctx.color && !applyArgs.some((a) => flagName(a) === 'no-color')) applyArgs.unshift('-no-color');
  const res = run([...bin, 'apply', ...applyArgs], ctx);
  if (!userPlanFile || planPath.includes(`${join('.plansentry', 'plans')}`)) rmSync(planPath, { force: true });
  return res.status ?? 1;
}

