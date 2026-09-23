import { SEVERITY_RANK, digestFindings, type Analysis, type Finding } from '../findings.js';
import type { Config } from './config.js';

export interface Verdict {
  needsApproval: boolean;
  /** Findings at or above the approval level. */
  gating: Finding[];
  blockers: string[];
  /** What an ack must match. */
  digest: string;
}

export function evaluate(analysis: Analysis, config: Config): Verdict {
  const min = SEVERITY_RANK[config.approvalLevel];
  const gating = analysis.findings.filter((f) => SEVERITY_RANK[f.severity] >= min);
  return {
    needsApproval: gating.length > 0 || analysis.blockers.length > 0,
    gating,
    blockers: analysis.blockers,
    digest: digestFindings(gating, analysis.blockers),
  };
}
