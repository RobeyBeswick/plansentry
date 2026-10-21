import { closeSync, openSync, readSync, writeSync } from 'node:fs';
import { saveApprovalSummary } from './approvals.js';
import type { Verdict } from './policy/evaluate.js';
import { shortSummary } from './report.js';

export const EXIT_NEEDS_APPROVAL = 3;
export const EXIT_USAGE = 2;

export interface GateOptions {
  ack?: string;
  interactive: boolean;
}

export type GateResult = { ok: true; how: 'clean' | 'ack' | 'prompt' } | { ok: false; why: 'needs-approval' | 'ack-mismatch' | 'declined' };

/** True if we can ask a human directly (a real terminal, not an agent's pipe). */
export function isInteractive(): boolean {
  if (process.env.PLANSENTRY_NONINTERACTIVE) return false;
  if (process.env.CI) return false;
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

/** Read one line from the controlling terminal. */
export function promptTty(question: string): string {
  let fd: number | undefined;
  try {
    fd = openSync('/dev/tty', 'r+');
    writeSync(fd, question);
    const buf = Buffer.alloc(256);
    let answer = '';
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      answer += buf.subarray(0, n).toString('utf8');
      if (answer.includes('\n')) break;
    }
    return answer.split('\n')[0]!.trim();
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function gate(verdict: Verdict, opts: GateOptions): GateResult {
  if (!verdict.needsApproval) return { ok: true, how: 'clean' };
  if (opts.ack !== undefined) {
    return opts.ack === verdict.digest ? { ok: true, how: 'ack' } : { ok: false, why: 'ack-mismatch' };
  }
  if (opts.interactive) {
    const answer = promptTty(`\nApprove these changes? Type "yes" to continue: `);
    return answer === 'yes' ? { ok: true, how: 'prompt' } : { ok: false, why: 'declined' };
  }
  return { ok: false, why: 'needs-approval' };
}

/**
 * Every held item in one line. Agents often keep only the tail of the output
 * (`| tail -15`), which can cut off the full report above.
 */
export function heldLine(verdict: Verdict): string {
  const items = verdict.gating.map((f) => `${f.severity.toUpperCase()} ${f.change} ${f.address}`);
  return `Held for approval: ${[...items, ...verdict.blockers].join(', ')}`;
}

export function agentInstructions(rerun: string, verdict: Verdict): string {
  const digest = verdict.digest;
  saveApprovalSummary(digest, shortSummary(verdict));
  return [
    '',
    heldLine(verdict),
    'Nothing was applied or deployed. The checked plan was saved.',
    'A human must approve it. Show the user these changes, and after they agree run:',
    '',
    `  ${rerun}`,
    '',
    'The user gets a permission prompt for that command. In bypass-permissions mode or on agents',
    'without prompts, ask the user to run it themselves (in Claude Code: type `! ` and the command).',
    'Do not work around this check: do not change flags, targets or state, or run the tool another way.',
    `(approval digest: ${digest})`,
  ].join('\n');
}

export function ackMismatchMessage(given: string, actual: string): string {
  return [
    `plansentry: --ack ${given} does not match this plan (digest ${actual}).`,
    'The set of risky changes is different from the one that was approved, so nothing was applied.',
    'Review the report above and ask the user again.',
  ].join('\n');
}
