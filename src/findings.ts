import { createHash } from 'node:crypto';

export type Severity = 'danger' | 'warn' | 'info';

export type ChangeKind =
  | 'delete'
  | 'replace'
  | 'forget'
  | 'orphan'
  | 'weaken'
  | 'import'
  | 'hotswap'
  | 'unknown';

export interface Finding {
  severity: Severity;
  tool: 'terraform' | 'cdk';
  /** Terraform address or `Stack/LogicalId`. */
  address: string;
  /** Resource type (`aws_db_instance`, `AWS::RDS::DBInstance`). */
  type: string;
  change: ChangeKind;
  /** One-line human explanation. */
  reason: string;
  notes: string[];
}

export interface Analysis {
  findings: Finding[];
  /** Counts of planned changes, for the summary line. */
  counts: { create: number; update: number; delete: number; replace: number; other: number };
  /** Reasons the analysis could not be trusted (fail closed). */
  blockers: string[];
}

export const SEVERITY_RANK: Record<Severity, number> = { info: 0, warn: 1, danger: 2 };

export function emptyAnalysis(): Analysis {
  return { findings: [], counts: { create: 0, update: 0, delete: 0, replace: 0, other: 0 }, blockers: [] };
}

export function mergeAnalyses(parts: Analysis[]): Analysis {
  const out = emptyAnalysis();
  for (const p of parts) {
    out.findings.push(...p.findings);
    out.blockers.push(...p.blockers);
    for (const k of Object.keys(out.counts) as (keyof Analysis['counts'])[]) out.counts[k] += p.counts[k];
  }
  return out;
}

/**
 * Stable digest of what the human is approving. It changes if the set of
 * risky changes changes, so an old ack can't approve a different plan.
 */
export function digestFindings(findings: Finding[], blockers: string[] = []): string {
  const lines = [
    ...findings.map((f) => `${f.severity}|${f.tool}|${f.address}|${f.type}|${f.change}`),
    ...blockers.map((b) => `blocker|${b}`),
  ].sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 12);
}

/** Minimal glob: `*` matches within a segment-ish run, `**` matches anything. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '.';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(value: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(value));
}
