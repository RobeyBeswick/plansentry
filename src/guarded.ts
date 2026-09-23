import { spawnSync } from 'node:child_process';
import { shellQuote } from './detect.js';
import { emptyAnalysis } from './findings.js';
import { EXIT_NEEDS_APPROVAL, ackMismatchMessage, agentInstructions, gate } from './gate.js';
import { evaluate } from './policy/evaluate.js';
import { renderReport } from './report.js';
import type { RunContext } from './terraform/runner.js';

/** For commands without a plan to inspect: the human approves the exact command line. */
export function runGuardedCommand(description: string, argv: string[], ctx: RunContext): number {
  const line = argv.map(shellQuote).join(' ');
  const analysis = emptyAnalysis();
  analysis.blockers.push(`${description}: \`${line}\``);
  const verdict = evaluate(analysis, ctx.config);
  process.stderr.write(`${renderReport(analysis, verdict, ctx)}\n`);
  const g = gate(verdict, ctx);
  if (!g.ok) {
    if (g.why === 'ack-mismatch') process.stderr.write(`${ackMismatchMessage(ctx.ack!, verdict.digest)}\n`);
    else if (g.why === 'declined') process.stderr.write('plansentry: not approved; nothing was run.\n');
    else process.stderr.write(`${agentInstructions(`plansentry exec --ack ${verdict.digest} -- ${line}`, verdict)}\n`);
    return EXIT_NEEDS_APPROVAL;
  }
  const [cmd, ...args] = argv;
  return spawnSync(cmd!, args, { cwd: ctx.cwd, env: ctx.env, stdio: 'inherit' }).status ?? 1;
}
