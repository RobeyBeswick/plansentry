import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * When exec stops for approval it leaves a plain-text summary keyed by digest,
 * so the hook can show it in the permission prompt for the `--ack` command.
 */
export function approvalSummaryPath(digest: string): string {
  return join(tmpdir(), 'plansentry-approvals', `${digest.replace(/[^a-f0-9]/gi, '')}.txt`);
}

export function saveApprovalSummary(digest: string, text: string): void {
  try {
    mkdirSync(join(tmpdir(), 'plansentry-approvals'), { recursive: true, mode: 0o700 });
    writeFileSync(approvalSummaryPath(digest), text, { mode: 0o600 });
  } catch {
    // Only used to enrich the prompt.
  }
}
