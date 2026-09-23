import { existsSync, readFileSync } from 'node:fs';
import { detect, type Operation } from '../detect.js';
import { approvalSummaryPath } from '../approvals.js';

export type Agent = 'claude' | 'codex' | 'generic';

export type Decision =
  | { kind: 'pass' }
  /** A human must confirm (native permission prompt). */
  | { kind: 'ask'; reason: string }
  /** Blocked; `reason` is written for the agent. */
  | { kind: 'deny'; reason: string };

export interface DecideOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  agent: Agent;
  /** Claude Code's `permission_mode`. */
  permissionMode?: string;
}

/** Modes where an `ask` would not reach a human. */
const NO_PROMPT_MODES = new Set(['bypassPermissions', 'dontAsk']);

/** Wrappers that change what arguments reach the tool; we can't re-run them faithfully. */
const UNFAITHFUL_PREFIX = new Set(['xargs', 'watch']);

function viaText(op: Operation): string {
  return op.via.length ? ` (via ${op.via.join(' → ')})` : '';
}

/** Insert `plansentry exec -- ` in front of each guarded command. */
export function rewriteCommand(command: string, ops: { insertAt: number }[]): string {
  let out = command;
  for (const at of [...new Set(ops.map((o) => o.insertAt))].sort((a, b) => b - a)) {
    out = `${out.slice(0, at)}plansentry exec -- ${out.slice(at)}`;
  }
  return out;
}

function ackSummary(digest: string | undefined): string {
  if (!digest) return '';
  const p = approvalSummaryPath(digest);
  if (!existsSync(p)) return '';
  try {
    return readFileSync(p, 'utf8').trim();
  } catch {
    return '';
  }
}

export function decide(command: string, opts: DecideOptions): Decision {
  let ops: Operation[];
  try {
    ops = detect(command, { cwd: opts.cwd, env: opts.env });
  } catch (e) {
    // Never crash the agent's tool call on our bug; but don't silently allow IaC either.
    if (/\b(terraform|tofu|cdk|terragrunt)\b/.test(command)) {
      return { kind: 'deny', reason: `plansentry could not analyse this command (${(e as Error).message}). Run the terraform/cdk command on its own.` };
    }
    return { kind: 'pass' };
  }
  if (!ops.length) return { kind: 'pass' };

  const denies: string[] = [];
  const asks: string[] = [];
  const rewrites: { insertAt: number; label: string }[] = [];

  for (const op of ops) {
    switch (op.kind) {
      case 'opaque':
        denies.push(
          `${op.reason}${viaText(op)}: \`${op.snippet}\`. plansentry cannot see what this would apply or destroy. ` +
            'Run the terraform/tofu/cdk command directly as its own Bash command so its plan can be checked.',
        );
        break;
      case 'risky':
        asks.push(`${op.description}${viaText(op)}`);
        break;
      case 'plansentry':
        if (op.ack !== undefined) {
          if (op.via.length) denies.push(`\`plansentry exec --ack\` must be run directly, not${viaText(op)}.`);
          else {
            const summary = ackSummary(op.ack);
            asks.push(`apply changes approved by digest ${op.ack}${summary ? `:\n${summary}` : ''}`);
          }
        }
        break;
      case 'terraform':
      case 'cdk': {
        const label = op.kind === 'terraform' ? `${op.inv.flavor} ${op.inv.sub}` : `cdk ${op.inv.sub}`;
        if (op.kind === 'cdk' && op.op.kind === 'watch') {
          asks.push(`cdk watch${viaText(op)} deploys continuously without plan checks`);
          break;
        }
        if (op.via.length) {
          denies.push(
            `\`${label}\` runs${viaText(op)}, where plansentry cannot check its plan. ` +
              `Run the underlying command directly instead, prefixed with \`plansentry exec --\`.`,
          );
        } else if (op.prefix.some((w) => UNFAITHFUL_PREFIX.has(w))) {
          denies.push(`\`${label}\` behind ${op.prefix.filter((w) => UNFAITHFUL_PREFIX.has(w)).join('/')} can't be checked. Run it directly with explicit arguments.`);
        } else {
          rewrites.push({ insertAt: op.insertAt, label });
        }
        break;
      }
    }
  }

  const prompts = !NO_PROMPT_MODES.has(opts.permissionMode ?? '') && opts.agent === 'claude';

  if (denies.length) return { kind: 'deny', reason: `plansentry: ${denies.join('\n')}` };

  if (rewrites.length) {
    const rerun = rewriteCommand(command, rewrites);
    const what = [...new Set(rewrites.map((r) => r.label))].join(', ');
    const extra = asks.length ? `\nThis command also contains operations that need a human: ${asks.join('; ')}. Run those separately.` : '';
    return {
      kind: 'deny',
      reason:
        `plansentry: \`${what}\` must go through plansentry so the plan is checked for destructive changes before anything is applied. ` +
        `Re-run exactly this instead:\n\n${rerun}\n\n` +
        'plansentry plans first, applies only that checked plan, and stops for human approval if a stateful resource would be destroyed or replaced.' +
        extra,
    };
  }

  if (asks.length) {
    if (prompts) return { kind: 'ask', reason: `plansentry: needs your approval: ${asks.join('; ')}` };
    return {
      kind: 'deny',
      reason:
        `plansentry: this needs a human's approval (${asks.join('; ')}), and this session can't show a permission prompt. ` +
        `Stop and ask the user to review and run it themselves` +
        (opts.agent === 'claude' ? ' by typing `! ` followed by the command.' : '.'),
    };
  }
  return { kind: 'pass' };
}
