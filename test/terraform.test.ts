import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, parseConfig, type Config } from '../src/policy/config.js';
import { evaluate } from '../src/policy/evaluate.js';
import { analyzeTerraformPlan, type PlanJson, type ResourceChange } from '../src/terraform/analyze.js';
import { classifyTerraform, parseTerraform } from '../src/terraform/args.js';

const cfg = (over: Partial<Config> = {}): Config => ({ ...structuredClone(DEFAULT_CONFIG), ...over });

function rc(address: string, type: string, actions: string[], extra: Partial<ResourceChange> & { before?: object; after?: object } = {}): ResourceChange {
  const { before, after, ...rest } = extra;
  return {
    address,
    mode: 'managed',
    type,
    name: address.split('.').pop()!,
    ...rest,
    change: { actions, before: (before ?? {}) as Record<string, unknown>, after: (after ?? {}) as Record<string, unknown>, ...(rest.change ?? {}) },
  };
}

const plan = (...changes: ResourceChange[]): PlanJson => ({ format_version: '1.2', resource_changes: changes });

describe('analyzeTerraformPlan', () => {
  it('flags replacing a database as danger with the forcing attribute', () => {
    const a = analyzeTerraformPlan(
      plan(
        rc('aws_db_instance.main', 'aws_db_instance', ['delete', 'create'], {
          action_reason: 'replace_because_cannot_update',
          before: { deletion_protection: false, skip_final_snapshot: true },
          change: { actions: ['delete', 'create'], replace_paths: [['engine']] },
        }),
      ),
      cfg(),
    );
    expect(a.findings).toHaveLength(1);
    const f = a.findings[0]!;
    expect(f.severity).toBe('danger');
    expect(f.change).toBe('replace');
    expect(f.notes).toContain('forced by: engine');
    expect(f.notes).toContain('skip_final_snapshot = true (no final snapshot)');
    expect(a.counts.replace).toBe(1);
    expect(evaluate(a, cfg()).needsApproval).toBe(true);
  });

  it('treats create_before_destroy replacement as danger too', () => {
    const a = analyzeTerraformPlan(plan(rc('aws_dynamodb_table.t', 'aws_dynamodb_table', ['create', 'delete'])), cfg());
    expect(a.findings[0]!.severity).toBe('danger');
    expect(a.findings[0]!.notes.join()).toContain('create_before_destroy');
  });

  it('notes force_destroy on bucket deletion', () => {
    const a = analyzeTerraformPlan(
      plan(rc('aws_s3_bucket.logs', 'aws_s3_bucket', ['delete'], { action_reason: 'delete_because_no_resource_config', before: { force_destroy: true } })),
      cfg(),
    );
    expect(a.findings[0]!.notes).toEqual(['because it was removed from the configuration', 'force_destroy = true (all contents are deleted with it)']);
  });

  it('keeps non-stateful deletes at info and does not require approval', () => {
    const a = analyzeTerraformPlan(plan(rc('aws_iam_policy.p', 'aws_iam_policy', ['delete'])), cfg());
    expect(a.findings[0]!.severity).toBe('info');
    expect(evaluate(a, cfg()).needsApproval).toBe(false);
  });

  it('warns on name-based stateful guesses for unknown providers', () => {
    const a = analyzeTerraformPlan(plan(rc('acme_database.x', 'acme_database', ['delete'])), cfg());
    expect(a.findings[0]!.severity).toBe('warn');
  });

  it('warns when protection is switched off in an update', () => {
    const a = analyzeTerraformPlan(
      plan(rc('aws_rds_cluster.c', 'aws_rds_cluster', ['update'], { before: { deletion_protection: true }, after: { deletion_protection: false } })),
      cfg(),
    );
    expect(a.findings).toHaveLength(1);
    expect(a.findings[0]!.change).toBe('weaken');
    expect(a.findings[0]!.severity).toBe('warn');
  });

  it('skips data sources and no-ops', () => {
    const a = analyzeTerraformPlan(
      plan({ ...rc('data.aws_db_instance.x', 'aws_db_instance', ['delete']), mode: 'data' }, rc('aws_db_instance.y', 'aws_db_instance', ['no-op'])),
      cfg(),
    );
    expect(a.findings).toHaveLength(0);
  });

  it('warns on forget', () => {
    const a = analyzeTerraformPlan(plan(rc('aws_db_instance.old', 'aws_db_instance', ['forget'])), cfg());
    expect(a.findings[0]!.change).toBe('forget');
    expect(a.findings[0]!.severity).toBe('warn');
  });

  it('fails closed on errored, deferred and incomplete plans', () => {
    expect(analyzeTerraformPlan({ errored: true, resource_changes: [] }, cfg()).blockers).toHaveLength(1);
    expect(analyzeTerraformPlan({ complete: false, deferred_changes: [{}], resource_changes: [] }, cfg()).blockers[0]).toContain('deferred');
    expect(analyzeTerraformPlan({ complete: false, resource_changes: [] }, cfg()).blockers[0]).toContain('incomplete');
  });

  it('honours config: ignore, statefulTypes, treatAllDeletesAsDanger', () => {
    const p = plan(rc('module.scratch.aws_db_instance.x', 'aws_db_instance', ['delete']), rc('aws_iam_role.r', 'aws_iam_role', ['delete']));
    expect(analyzeTerraformPlan(p, cfg({ ignore: ['module.scratch.**'] })).findings.map((f) => f.address)).toEqual(['aws_iam_role.r']);
    expect(analyzeTerraformPlan(p, cfg({ statefulTypes: { add: [], remove: ['aws_db_instance'] } })).findings[0]!.severity).toBe('info');
    expect(analyzeTerraformPlan(p, cfg({ treatAllDeletesAsDanger: true })).findings.every((f) => f.severity === 'danger')).toBe(true);
    expect(analyzeTerraformPlan(plan(rc('x_thing.a', 'x_thing', ['delete'])), cfg({ statefulTypes: { add: ['x_*'], remove: [] } })).findings[0]!.severity).toBe('danger');
  });

  it('gives the same digest for the same risky set and a different one otherwise', () => {
    const one = evaluate(analyzeTerraformPlan(plan(rc('aws_db_instance.a', 'aws_db_instance', ['delete'])), cfg()), cfg());
    const same = evaluate(analyzeTerraformPlan(plan(rc('aws_db_instance.a', 'aws_db_instance', ['delete']), rc('null_resource.n', 'null_resource', ['create'])), cfg()), cfg());
    const other = evaluate(analyzeTerraformPlan(plan(rc('aws_db_instance.b', 'aws_db_instance', ['delete'])), cfg()), cfg());
    expect(one.digest).toMatch(/^[a-f0-9]{12}$/);
    expect(same.digest).toBe(one.digest);
    expect(other.digest).not.toBe(one.digest);
  });
});

describe('terraform argument handling', () => {
  it('folds TF_CLI_ARGS into effective args', () => {
    const inv = parseTerraform(['terraform', 'apply'], { TF_CLI_ARGS_apply: '-auto-approve -var "a=b c"' }, 'terraform');
    expect(inv.args).toEqual(['-auto-approve', '-var', 'a=b c']);
    const op = classifyTerraform(inv);
    expect(op).toMatchObject({ kind: 'apply', autoApprove: true });
  });

  it('finds the saved plan positional past value flags', () => {
    const op = classifyTerraform(parseTerraform(['terraform', 'apply', '-lock-timeout', '30s', 'tfplan'], {}, 'terraform'));
    expect(op).toMatchObject({ kind: 'apply', planFile: 'tfplan' });
  });

  it('reads -chdir and -auto-approve=false', () => {
    const inv = parseTerraform(['terraform', '-chdir=infra', 'apply', '-auto-approve=false'], {}, 'terraform');
    expect(inv.chdir).toBe('infra');
    expect(classifyTerraform(inv)).toMatchObject({ autoApprove: false });
  });
});

describe('config', () => {
  it('rejects unknown keys and bad values', () => {
    expect(() => parseConfig({ approvalLevel: 'never' })).toThrow();
    expect(() => parseConfig({ ignroe: [] })).toThrow(/unknown key/);
    expect(parseConfig({ approvalLevel: 'warn', ignore: ['a.*'] })).toMatchObject({ approvalLevel: 'warn', ignore: ['a.*'] });
  });
});
