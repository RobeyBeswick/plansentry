import { SEVERITY_RANK, type Analysis, type Finding } from './findings.js';
import type { Verdict } from './policy/evaluate.js';

const LABEL = { danger: 'DANGER', warn: 'WARN  ', info: 'info  ' } as const;

function color(enabled: boolean) {
  const wrap = (code: string) => (s: string) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { red: wrap('1;31'), yellow: wrap('33'), dim: wrap('2'), bold: wrap('1') };
}

export interface ReportOptions {
  color?: boolean;
  /** Include info-level findings. */
  verbose?: boolean;
}

export function renderFindings(findings: Finding[], opts: ReportOptions = {}): string[] {
  const c = color(opts.color ?? false);
  const lines: string[] = [];
  const sorted = [...findings]
    .filter((f) => opts.verbose || f.severity !== 'info')
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.address.localeCompare(b.address));
  for (const f of sorted) {
    const tag = f.severity === 'danger' ? c.red(LABEL.danger) : f.severity === 'warn' ? c.yellow(LABEL.warn) : c.dim(LABEL.info);
    lines.push(`  ${tag}  ${c.bold(f.address)}  ${c.dim(`(${f.type})`)}`);
    lines.push(`          ${f.reason}`);
    for (const n of f.notes) lines.push(c.dim(`          · ${n}`));
  }
  const hidden = findings.length - sorted.length;
  if (hidden > 0) lines.push(c.dim(`  … and ${hidden} lower-risk change(s) (non-stateful deletes); use --verbose to list`));
  return lines;
}

export function summaryLine(a: Analysis): string {
  const { create, update, delete: del, replace, other } = a.counts;
  const parts = [`${create} to add`, `${update} to change`, `${del} to destroy`, `${replace} to replace`];
  if (other) parts.push(`${other} other`);
  return parts.join(', ');
}

export function renderReport(analysis: Analysis, verdict: Verdict, opts: ReportOptions = {}): string {
  const c = color(opts.color ?? false);
  const lines: string[] = [];
  if (verdict.needsApproval) {
    const n = verdict.gating.length + verdict.blockers.length;
    lines.push(c.red(`plansentry: ${n} item(s) need human approval`) + c.dim(`  [digest ${verdict.digest}]`));
  } else {
    lines.push(`plansentry: no destructive changes to stateful resources`);
  }
  for (const b of verdict.blockers) lines.push(`  ${c.red('BLOCKED')} ${b}`);
  lines.push(...renderFindings(analysis.findings, opts));
  lines.push(c.dim(`  Plan: ${summaryLine(analysis)}.`));
  return lines.join('\n');
}

/** One line for permission prompts, e.g. "DESTROYS aws_db_instance.main; REPLACES 2 more". */
export function shortSummary(verdict: Verdict): string {
  const items = verdict.gating.map((f) => `${f.change} ${f.address}`);
  const head = items.slice(0, 3).join(', ');
  const more = items.length > 3 ? ` (+${items.length - 3} more)` : '';
  const blockers = verdict.blockers.length ? `; ${verdict.blockers.join('; ')}` : '';
  return `${head}${more}${blockers}`;
}
