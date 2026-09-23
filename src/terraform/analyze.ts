import { emptyAnalysis, matchesAny, type Analysis, type Finding, type Severity } from '../findings.js';
import type { Config } from '../policy/config.js';
import { GENERIC_PROTECTIONS, TERRAFORM_STATEFUL, TERRAFORM_WARN_TYPES, looksStateful, type Protection } from './stateful.js';

/** The subset of `terraform show -json <plan>` we read. */
export interface PlanJson {
  format_version?: string;
  terraform_version?: string;
  errored?: boolean | null;
  complete?: boolean | null;
  applyable?: boolean | null;
  resource_changes?: ResourceChange[];
  deferred_changes?: unknown[];
}

export interface ResourceChange {
  address: string;
  previous_address?: string;
  module_address?: string;
  mode: 'managed' | 'data';
  type: string;
  name: string;
  provider_name?: string;
  action_reason?: string;
  change: {
    actions: string[];
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    replace_paths?: (string | number)[][];
    importing?: unknown;
  };
}

const REASONS: Record<string, string> = {
  replace_because_tainted: 'the resource is tainted',
  replace_because_cannot_update: 'an attribute that cannot be updated in place changed',
  replace_by_request: 'replacement was requested with -replace',
  replace_by_triggers: 'replace_triggered_by fired',
  delete_because_no_resource_config: 'it was removed from the configuration',
  delete_because_no_module: 'its module was removed from the configuration',
  delete_because_wrong_repetition: 'count/for_each was added or removed',
  delete_because_count_index: 'its count index is out of range (count was reduced)',
  delete_because_each_key: 'its for_each key no longer exists',
  delete_because_no_move_target: 'its moved block target does not exist',
};

function describeActions(actions: string[]): 'create' | 'update' | 'delete' | 'replace' | 'forget' | 'noop' | 'other' {
  const has = (a: string) => actions.includes(a);
  if (has('delete') && has('create')) return 'replace';
  if (has('delete')) return 'delete';
  if (has('forget')) return 'forget';
  if (has('create')) return 'create';
  if (has('update')) return 'update';
  if (actions.every((a) => a === 'no-op' || a === 'read')) return 'noop';
  return 'other';
}

function protectionNotes(protections: Protection[], values: Record<string, unknown> | null | undefined): string[] {
  if (!values) return [];
  const notes: string[] = [];
  for (const p of protections) {
    if (!(p.attr in values)) continue;
    notes.push(p.protects(values[p.attr]) ? p.onLabel : p.offLabel);
  }
  return notes;
}

function pathToString(path: (string | number)[]): string {
  return path.map((p, i) => (typeof p === 'number' ? `[${p}]` : i === 0 ? p : `.${p}`)).join('');
}

const isRemoved = (type: string, config: Config) => matchesAny(type, config.statefulTypes.remove);

export function statefulProtections(type: string, config: Config): Protection[] | undefined {
  if (isRemoved(type, config)) return undefined;
  if (TERRAFORM_STATEFUL[type]) return TERRAFORM_STATEFUL[type];
  if (matchesAny(type, config.statefulTypes.add)) return [];
  return undefined;
}

export function analyzeTerraformPlan(plan: PlanJson, config: Config): Analysis {
  const out = emptyAnalysis();

  if (plan.errored) out.blockers.push('the plan errored, so it does not describe what apply would do');
  if (plan.deferred_changes?.length) {
    out.blockers.push(`${plan.deferred_changes.length} change(s) were deferred and are not in this plan`);
  } else if (plan.complete === false) {
    out.blockers.push('the plan is incomplete (another plan/apply round will be needed)');
  }
  if (!Array.isArray(plan.resource_changes) && plan.resource_changes !== undefined) {
    out.blockers.push('plan JSON has an unexpected shape');
    return out;
  }

  for (const rc of plan.resource_changes ?? []) {
    if (rc.mode === 'data') continue;
    const kind = describeActions(rc.change?.actions ?? []);
    const notes: string[] = [];
    if (rc.action_reason && REASONS[rc.action_reason]) notes.push(`because ${REASONS[rc.action_reason]}`);
    if (rc.change.replace_paths?.length) {
      notes.push(`forced by: ${rc.change.replace_paths.map(pathToString).join(', ')}`);
    }
    if (rc.previous_address) notes.push(`moved from ${rc.previous_address}`);
    if (rc.change.actions[0] === 'create' && kind === 'replace') notes.push('create_before_destroy: the old one is deleted after the new one exists');

    const ignored = matchesAny(rc.address, config.ignore);
    const protections = statefulProtections(rc.type, config);
    const push = (severity: Severity, change: Finding['change'], reason: string, extra: string[] = []) => {
      if (ignored) return;
      out.findings.push({ severity, tool: 'terraform', address: rc.address, type: rc.type, change, reason, notes: [...notes, ...extra] });
    };

    switch (kind) {
      case 'noop':
        break;
      case 'create':
        out.counts.create++;
        if (rc.change.importing) push('info', 'import', 'will be imported into state');
        break;
      case 'update': {
        out.counts.update++;
        const before = rc.change.before ?? {};
        const after = rc.change.after ?? {};
        const seen = new Set<string>();
        for (const p of [...(protections ?? []), ...GENERIC_PROTECTIONS]) {
          if (seen.has(p.attr)) continue;
          seen.add(p.attr);
          if (!(p.attr in before) || !(p.attr in after)) continue;
          if (p.protects(before[p.attr]) && !p.protects(after[p.attr])) {
            push('warn', 'weaken', `protection weakened: ${p.offLabel}`, [`was: ${p.onLabel}`]);
          }
        }
        break;
      }
      case 'forget':
        out.counts.other++;
        push('warn', 'forget', 'will be removed from state but left running (no longer managed)');
        break;
      case 'delete':
      case 'replace': {
        if (kind === 'delete') out.counts.delete++;
        else out.counts.replace++;
        const verb = kind === 'delete' ? 'will be DESTROYED' : 'will be REPLACED (destroyed and recreated empty)';
        if (protections) {
          push('danger', kind, `stateful resource ${verb}`, protectionNotes(protections, rc.change.before));
        } else if (config.treatAllDeletesAsDanger) {
          push('danger', kind, `${verb}`);
        } else if (looksStateful(rc.type) && !isRemoved(rc.type, config)) {
          push('warn', kind, `${verb}; the type name looks stateful`, [
            `add "${rc.type}" to statefulTypes.add in .plansentry.json to require approval`,
          ]);
        } else if (TERRAFORM_WARN_TYPES.has(rc.type) && !isRemoved(rc.type, config)) {
          push('warn', kind, verb);
        } else {
          push('info', kind, verb);
        }
        break;
      }
      default:
        out.counts.other++;
        push('warn', 'unknown', `unrecognised actions ${JSON.stringify(rc.change.actions)}`);
    }
  }
  return out;
}
