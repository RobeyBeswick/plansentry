import { createRequire } from 'node:module';
import { emptyAnalysis, matchesAny, type Analysis, type Finding, type Severity } from '../findings.js';
import type { Config } from '../policy/config.js';
import { CFN_PROTECTION_PROPS, CFN_WARN_TYPES, isCfnStateful } from './stateful.js';

type Template = Record<string, unknown>;
interface CfnResource {
  Type?: string;
  Properties?: Record<string, unknown>;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
}

type CfnDiffModule = typeof import('@aws-cdk/cloudformation-diff');
let cfnDiff: CfnDiffModule | undefined;
/** Loaded lazily: the hook path never needs it. */
function loadDiff(): CfnDiffModule {
  cfnDiff ??= createRequire(import.meta.url)('@aws-cdk/cloudformation-diff') as CfnDiffModule;
  return cfnDiff;
}

const RETAINED = new Set(['Retain', 'RetainExceptOnCreate']);

function resources(t: Template | undefined): Record<string, CfnResource> {
  return ((t?.Resources ?? {}) as Record<string, CfnResource>) ?? {};
}

/** CDK's autoDeleteObjects custom resource empties the bucket before CloudFormation deletes it. */
function autoDeletedBuckets(t: Template | undefined): Set<string> {
  const out = new Set<string>();
  for (const r of Object.values(resources(t))) {
    if (r.Type !== 'Custom::S3AutoDeleteObjects') continue;
    const ref = (r.Properties?.BucketName as { Ref?: string } | undefined)?.Ref;
    if (ref) out.add(ref);
  }
  return out;
}

function severityFor(type: string, retained: boolean, config: Config, stateful: boolean): Severity {
  if (stateful) return retained ? 'warn' : 'danger';
  if (config.treatAllDeletesAsDanger && !retained) return 'danger';
  return CFN_WARN_TYPES.has(type) ? 'warn' : 'info';
}

export interface StackDiffInput {
  /** Name shown in findings (`Stage/Stack`). */
  stack: string;
  /** Deployed template; `{}` for a stack that doesn't exist yet. */
  before: Template;
  after: Template;
}

export function analyzeCdkStack(input: StackDiffInput, config: Config): Analysis {
  const { fullDiff, ResourceImpact } = loadDiff();
  const out = emptyAnalysis();
  const diff = fullDiff(input.before, input.after);
  const autoDelete = autoDeletedBuckets(input.before);

  diff.resources.forEachDifference((logicalId, rd) => {
    const oldRes = rd.oldValue as CfnResource | undefined;
    const newRes = rd.newValue as CfnResource | undefined;
    const type = rd.resourceType ?? oldRes?.Type ?? newRes?.Type ?? 'unknown';
    const address = `${input.stack}/${logicalId}`;
    if (matchesAny(address, config.ignore)) {
      countImpact(out, rd.changeImpact);
      return;
    }
    const stateful = isCfnStateful(type, config);
    const push = (severity: Severity, change: Finding['change'], reason: string, notes: string[] = []) =>
      out.findings.push({ severity, tool: 'cdk', address, type, change, reason, notes });

    const replacingProps = Object.entries(rd.propertyUpdates)
      .filter(([, p]) => p.changeImpact === ResourceImpact.WILL_REPLACE || p.changeImpact === ResourceImpact.MAY_REPLACE)
      .map(([name]) => name);

    switch (rd.changeImpact) {
      case ResourceImpact.WILL_DESTROY: {
        out.counts.delete++;
        const policy = oldRes?.DeletionPolicy ?? 'Delete';
        const retained = RETAINED.has(policy);
        const notes = [`DeletionPolicy: ${policy}${oldRes?.DeletionPolicy ? '' : ' (default)'}`];
        if (policy === 'Snapshot') notes.push('a snapshot is taken before deletion');
        if (autoDelete.has(logicalId)) notes.push('autoDeleteObjects: all objects are deleted first');
        const reason = retained
          ? 'removed from the stack but retained in the account (becomes unmanaged)'
          : stateful
            ? 'stateful resource will be DESTROYED'
            : 'will be destroyed';
        push(severityFor(type, retained, config, stateful), retained ? 'orphan' : 'delete', reason, notes);
        break;
      }
      case ResourceImpact.WILL_REPLACE:
      case ResourceImpact.MAY_REPLACE: {
        out.counts.replace++;
        // CloudFormation applies the UpdateReplacePolicy to the old resource; require both
        // templates to agree so a policy change in the same deploy can't hide a loss.
        const oldP = oldRes?.UpdateReplacePolicy ?? 'Delete';
        const newP = newRes?.UpdateReplacePolicy ?? 'Delete';
        const retained = RETAINED.has(oldP) && RETAINED.has(newP);
        const may = rd.changeImpact === ResourceImpact.MAY_REPLACE;
        const notes = [`UpdateReplacePolicy: ${newP}${newRes?.UpdateReplacePolicy ? '' : ' (default)'}`];
        if (replacingProps.length) notes.push(`forced by: ${replacingProps.join(', ')}`);
        if (rd.resourceTypeChanged) notes.push(`type changes from ${rd.oldResourceType} to ${rd.newResourceType}`);
        const verb = may ? 'MAY BE REPLACED' : 'will be REPLACED';
        const reason = retained
          ? `${verb}; the old resource is retained but the stack will point at a new, empty one`
          : stateful
            ? `stateful resource ${verb} (the old one and its data are deleted)`
            : verb;
        push(severityFor(type, retained, config, stateful), 'replace', reason, notes);
        break;
      }
      case ResourceImpact.WILL_ORPHAN:
        out.counts.other++;
        push('warn', 'orphan', 'will be removed from CloudFormation management but kept');
        break;
      case ResourceImpact.WILL_IMPORT:
        out.counts.other++;
        push('info', 'import', 'will be imported into the stack');
        break;
      case ResourceImpact.WILL_CREATE:
        out.counts.create++;
        break;
      case ResourceImpact.WILL_UPDATE: {
        out.counts.update++;
        if (type === 'AWS::CloudFormation::Stack') {
          // Its contents could delete a database, and we can't see them: don't let it through unasked.
          push('danger', 'unknown', 'nested stack changes; its contents are not analysed', ['review the nested template diff with `cdk diff`']);
        }
        if (stateful && RETAINED.has(oldRes?.DeletionPolicy ?? '') && !RETAINED.has(newRes?.DeletionPolicy ?? 'Delete')) {
          push('warn', 'weaken', `DeletionPolicy weakened from ${oldRes?.DeletionPolicy} to ${newRes?.DeletionPolicy ?? 'Delete'}`);
        }
        if (stateful && RETAINED.has(oldRes?.UpdateReplacePolicy ?? '') && !RETAINED.has(newRes?.UpdateReplacePolicy ?? 'Delete')) {
          push('warn', 'weaken', `UpdateReplacePolicy weakened from ${oldRes?.UpdateReplacePolicy} to ${newRes?.UpdateReplacePolicy ?? 'Delete'}`);
        }
        for (const prop of CFN_PROTECTION_PROPS) {
          if (isOn(oldRes?.Properties?.[prop]) && !isOn(newRes?.Properties?.[prop])) {
            push('warn', 'weaken', `protection weakened: ${prop} turned off`);
          }
        }
        break;
      }
      default:
        break;
    }
  });
  return out;
}

function isOn(v: unknown): boolean {
  return v === true || v === 'true' || v === 'ACTIVE';
}

function countImpact(out: Analysis, impact: string): void {
  if (impact === 'WILL_CREATE') out.counts.create++;
  else if (impact === 'WILL_UPDATE') out.counts.update++;
  else if (impact === 'WILL_DESTROY') out.counts.delete++;
  else if (impact === 'WILL_REPLACE' || impact === 'MAY_REPLACE') out.counts.replace++;
  else if (impact !== 'NO_CHANGE') out.counts.other++;
}

/** `cdk destroy`: every resource in the deployed template goes, unless retained. */
export function analyzeCdkDestroy(stack: string, deployed: Template, config: Config): Analysis {
  return analyzeCdkStack({ stack, before: deployed, after: {} }, config);
}
