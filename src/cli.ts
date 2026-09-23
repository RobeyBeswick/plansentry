#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { detect } from './detect.js';
import { execMain } from './exec.js';
import { mergeAnalyses } from './findings.js';
import { decide, type Agent } from './hook/decide.js';
import { hookMain } from './hook/hook.js';
import { installMain } from './install.js';
import { ConfigError, loadConfig } from './policy/config.js';
import { evaluate } from './policy/evaluate.js';
import { renderReport } from './report.js';
import { analyzeTerraformPlan, type PlanJson } from './terraform/analyze.js';

const HELP = `plansentry — plan-aware guardrail for AI coding agents running Terraform, OpenTofu and AWS CDK

Usage:
  plansentry install <claude|codex> [--project]   Add the PreToolUse hook
  plansentry uninstall <claude|codex> [--project]
  plansentry exec [--ack DIGEST] -- <command>     Plan, check, then apply exactly the checked plan
  plansentry check <plan.tfplan|plan.json|cdk.out> [--before t.json --after t.json]
  plansentry explain "<shell command>"            Show what the hook would do
  plansentry hook --agent <claude|codex|generic>  (called by the agent)
  plansentry version

Exit codes: 0 ok, 2 usage/config error, 3 needs human approval, otherwise the tool's own exit code.
`;

function version(): string {
  const require = createRequire(import.meta.url);
  return (require('../package.json') as { version: string }).version;
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

async function checkMain(args: string[]): Promise<number> {
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const verbose = args.includes('--verbose') || args.includes('-v');
  let config;
  try {
    config = loadConfig(process.cwd());
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`plansentry: invalid config: ${e.message}\n`);
      return 2;
    }
    throw e;
  }

  const before = flagValue(args, '--before');
  const after = flagValue(args, '--after');
  if (before || after) {
    const { analyzeCdkStack } = await import('./cdk/analyze.js');
    const read = (p?: string) => (p ? (JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>) : {});
    const analysis = analyzeCdkStack({ stack: flagValue(args, '--stack') ?? 'Stack', before: read(before), after: read(after) }, config);
    const verdict = evaluate(analysis, config);
    process.stdout.write(`${renderReport(analysis, verdict, { color, verbose })}\n`);
    return verdict.needsApproval ? 3 : 0;
  }

  const target = args.find((a) => !a.startsWith('-'));
  if (!target) {
    process.stderr.write('usage: plansentry check <plan.tfplan|plan.json|cdk.out>\n');
    return 2;
  }
  const path = resolve(target);
  if (existsSync(path) && statSync(path).isDirectory()) {
    if (!existsSync(join(path, 'manifest.json'))) {
      process.stderr.write(`plansentry: ${target} is a directory without manifest.json\n`);
      return 2;
    }
    const { readAssembly, readTemplate } = await import('./cdk/assembly.js');
    const { getBaseline } = await import('./cdk/baseline.js');
    const { analyzeCdkStack } = await import('./cdk/analyze.js');
    const offline = args.includes('--offline');
    const parts = readAssembly(path).map((stack) => {
      const b = getBaseline(stack, { projectDir: process.cwd(), env: process.env, offline, profile: flagValue(args, '--profile') });
      if (b.kind === 'unknown') {
        const a = { findings: [], counts: { create: 0, update: 0, delete: 0, replace: 0, other: 0 }, blockers: [`${stack.displayName}: ${b.reason}`] };
        return a;
      }
      return analyzeCdkStack({ stack: stack.displayName, before: b.kind === 'deployed' ? b.template : {}, after: readTemplate(stack) }, config);
    });
    const analysis = mergeAnalyses(parts);
    const verdict = evaluate(analysis, config);
    process.stdout.write(`${renderReport(analysis, verdict, { color, verbose })}\n`);
    return verdict.needsApproval ? 3 : 0;
  }

  let plan: PlanJson;
  const text = readFileSync(path);
  if (text[0] === 0x7b /* { */) plan = JSON.parse(text.toString('utf8')) as PlanJson;
  else {
    const bin = flagValue(args, '--bin') ?? (existsSync('.terraform') || !commandExists('tofu') ? 'terraform' : 'tofu');
    const res = spawnSync(bin, ['show', '-json', path], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
    if (res.status !== 0) {
      process.stderr.write(`plansentry: \`${bin} show -json\` failed\n`);
      return 1;
    }
    plan = JSON.parse(res.stdout) as PlanJson;
  }
  const analysis = analyzeTerraformPlan(plan, config);
  const verdict = evaluate(analysis, config);
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify({ ...verdict, analysis }, null, 2)}\n`);
  else process.stdout.write(`${renderReport(analysis, verdict, { color, verbose })}\n`);
  return verdict.needsApproval ? 3 : 0;
}

function commandExists(cmd: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
}

function explainMain(args: string[]): number {
  const agentArg = flagValue(args, '--agent') ?? 'claude';
  const mode = flagValue(args, '--mode');
  const command = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--agent' && args[i - 1] !== '--mode').join(' ');
  if (!command) {
    process.stderr.write('usage: plansentry explain "<shell command>" [--agent claude|codex|generic] [--mode bypassPermissions]\n');
    return 2;
  }
  const ops = detect(command, { cwd: process.cwd(), env: process.env });
  process.stdout.write(`Detected ${ops.length} guarded operation(s):\n`);
  for (const op of ops) {
    const via = op.via.length ? `  via ${op.via.join(' → ')}` : '';
    const what =
      op.kind === 'terraform' ? `${op.inv.flavor} ${op.inv.sub} (${op.op.kind})`
      : op.kind === 'cdk' ? `cdk ${op.inv.sub}`
      : op.kind === 'risky' ? op.description
      : op.kind === 'plansentry' ? `plansentry ${op.ack ? `--ack ${op.ack}` : '(self-checking)'}`
      : `${op.reason}: ${op.snippet}`;
    process.stdout.write(`  - [${op.kind}] ${what}${via}\n`);
  }
  const d = decide(command, { cwd: process.cwd(), env: process.env, agent: agentArg as Agent, permissionMode: mode });
  process.stdout.write(`\nHook decision: ${d.kind.toUpperCase()}\n`);
  if (d.kind !== 'pass') process.stdout.write(`${d.reason}\n`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'hook': {
      const agent = (flagValue(rest, '--agent') ?? 'claude') as Agent;
      if (!['claude', 'codex', 'generic'].includes(agent)) {
        process.stderr.write(`plansentry hook: unknown agent ${agent}\n`);
        return 2;
      }
      return hookMain(agent);
    }
    case 'exec':
      return execMain(rest);
    case 'check':
      return checkMain(rest);
    case 'explain':
      return explainMain(rest);
    case 'install':
      return installMain(rest);
    case 'uninstall':
      return installMain(rest, true);
    case 'version':
    case '--version':
    case '-V':
      process.stdout.write(`${version()}\n`);
      return 0;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`plansentry: unknown command ${cmd}\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`plansentry: ${(e as Error).stack ?? String(e)}\n`);
    process.exit(1);
  },
);
