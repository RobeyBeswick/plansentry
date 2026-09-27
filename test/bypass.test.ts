import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { decide, type Decision } from '../src/hook/decide.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plansentry-bypass-'));
  writeFileSync(
    join(dir, 'Makefile'),
    ['TOFU ?= tofu', 'CHDIR := -chdir=$(ENVDIR)', '.PHONY: deploy plan nuke', 'up:', '\t$(TOFU) $(CHDIR) apply', 'plan:', '\tterraform plan', 'deploy: plan', '\t@cd infra && $(TF) apply -auto-approve', 'nuke:', '\tterraform destroy -auto-approve', 'safe:', '\techo hi', ''].join('\n'),
  );
  writeFileSync(join(dir, 'justfile'), ['deploy:', '    npx cdk deploy --all', 'test:', '    npm test', ''].join('\n'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      scripts: {
        deploy: 'cdk deploy --require-approval never',
        predestroy: 'echo about to',
        destroy: 'cdk destroy --force',
        build: 'tsc',
        cdk: 'cdk',
        up: 'npm run deploy',
      },
    }),
  );
  writeFileSync(join(dir, 'deploy.sh'), '#!/bin/bash\nset -e\nterraform init\nterraform apply -auto-approve\n');
  writeFileSync(join(dir, 'ok.sh'), '#!/bin/sh\necho fine\n');
  writeFileSync(join(dir, 'apply.py'), 'import subprocess\nsubprocess.run(["terraform", "apply", "-auto-approve"])\n');
  mkdirSync(join(dir, 'infra'));
});

function d(command: string, permissionMode = 'default', agent: 'claude' | 'codex' | 'generic' = 'claude'): Decision {
  return decide(command, { cwd: dir, env: {}, agent, permissionMode });
}

const kind = (command: string, mode?: string, agent?: 'claude' | 'codex' | 'generic') => d(command, mode, agent).kind;

describe('passes ordinary and read-only commands', () => {
  it.each([
    'ls -la',
    'terraform plan',
    'terraform plan -out=tfplan',
    'terraform init -upgrade',
    'terraform show -json tfplan',
    'terraform state list',
    'terraform workspace select dev',
    'cdk synth',
    'npx cdk diff',
    'cdk refactor --dry-run',
    'git commit -m "terraform apply fix"',
    'echo terraform apply',
    'grep -r "cdk deploy" .',
    'command -v terraform',
    'curl -fsSL https://example.com/install.sh | sh',
    'npm run build',
    'make safe',
    'just test',
    './ok.sh',
    'plansentry exec -- terraform apply',
    'plansentry explain "terraform destroy"',
    'bash -euo pipefail -c "terraform plan"',
    'bash -o pipefail ok.sh',
  ])('%s', (cmd) => {
    expect(kind(cmd)).toBe('pass');
  });
});

describe('routes direct applies through plansentry exec', () => {
  it.each([
    ['terraform apply', 'plansentry exec -- terraform apply'],
    ['terraform apply -auto-approve', 'plansentry exec -- terraform apply -auto-approve'],
    ['terraform apply tfplan', 'plansentry exec -- terraform apply tfplan'],
    ['terraform destroy -auto-approve', 'plansentry exec -- terraform destroy -auto-approve'],
    ['terraform apply -destroy', 'plansentry exec -- terraform apply -destroy'],
    ['tofu apply -auto-approve', 'plansentry exec -- tofu apply -auto-approve'],
    ['/usr/local/bin/terraform apply', 'plansentry exec -- /usr/local/bin/terraform apply'],
    ['terraform -chdir=infra apply', 'plansentry exec -- terraform -chdir=infra apply'],
    ['cd infra && terraform apply -auto-approve', 'cd infra && plansentry exec -- terraform apply -auto-approve'],
    ['echo yes | terraform apply', 'echo yes | plansentry exec -- terraform apply'],
    ['terraform apply -input=false', 'plansentry exec -- terraform apply -input=false'],
    ['TF_CLI_ARGS_apply=-auto-approve terraform apply', 'TF_CLI_ARGS_apply=-auto-approve plansentry exec -- terraform apply'],
    ['TF_WORKSPACE=prod terraform apply', 'TF_WORKSPACE=prod plansentry exec -- terraform apply'],
    ['sudo terraform apply', 'plansentry exec -- sudo terraform apply'],
    ['aws-vault exec prod -- terraform apply', 'plansentry exec -- aws-vault exec prod -- terraform apply'],
    ['timeout 600 terraform apply', 'plansentry exec -- timeout 600 terraform apply'],
    ['env AWS_PROFILE=prod terraform apply', 'plansentry exec -- env AWS_PROFILE=prod terraform apply'],
    ['cdk deploy', 'plansentry exec -- cdk deploy'],
    ['npx cdk deploy --all --require-approval never', 'plansentry exec -- npx cdk deploy --all --require-approval never'],
    ['npx aws-cdk@latest deploy', 'plansentry exec -- npx aws-cdk@latest deploy'],
    ['pnpm dlx cdk deploy', 'plansentry exec -- pnpm dlx cdk deploy'],
    ['bunx cdk deploy MyStack', 'plansentry exec -- bunx cdk deploy MyStack'],
    ['npm exec -- cdk deploy', 'plansentry exec -- npm exec -- cdk deploy'],
    ['cdk destroy --force', 'plansentry exec -- cdk destroy --force'],
    ['cdk deploy --hotswap', 'plansentry exec -- cdk deploy --hotswap'],
    ['terraform plan && terraform apply', 'terraform plan && plansentry exec -- terraform apply'],
    ['if true; then terraform apply; fi', 'if true; then plansentry exec -- terraform apply; fi'],
    ['time -p terraform apply', 'time -p plansentry exec -- terraform apply'],
  ])('%s', (cmd, rerun) => {
    const res = d(cmd);
    expect(res.kind).toBe('deny');
    expect(res.kind === 'deny' && res.reason).toContain(rerun);
  });

  it('rewrites the same way for Codex and generic agents', () => {
    expect(d('terraform apply', 'default', 'codex').kind).toBe('deny');
    expect(d('terraform apply', 'default', 'generic').kind).toBe('deny');
  });
});

describe('denies indirection that hides an apply', () => {
  it.each([
    ['bash -c "terraform destroy -auto-approve"', 'bash -c'],
    ["sh -c 'cd infra && terraform apply'", 'sh -c'],
    ['bash -lc "npx cdk deploy"', 'via bash'],
    ['bash -euo pipefail -c "terraform apply -auto-approve"', 'bash -c'],
    ['bash -o pipefail -c "cdk deploy"', 'bash -c'],
    ['bash -O extglob -c "terraform destroy -auto-approve"', 'bash -c'],
    ['sh -c -- "terraform apply"', 'sh -c'],
    ['bash -o pipefail deploy.sh', 'bash deploy.sh'],
    ['eval "terraform apply -auto-approve"', 'eval'],
    ['X=$(terraform apply -auto-approve)', 'command substitution'],
    ['echo `terraform destroy -auto-approve`', 'command substitution'],
    ['make deploy', 'make deploy'],
    ['make nuke', 'make nuke'],
    ['make -C . deploy', 'make deploy'],
    ['make up', 'make up'],
    ['just deploy', 'just deploy'],
    ['npm run deploy', 'npm run deploy'],
    ['npm run destroy', 'npm run destroy'],
    ['npm run up', 'npm run up'],
    ['yarn deploy', 'yarn'],
    ['npm run cdk -- deploy', 'npm run cdk'],
    ['./deploy.sh', 'deploy.sh'],
    ['bash deploy.sh', 'bash deploy.sh'],
    ['source deploy.sh', 'source deploy.sh'],
    ['python3 apply.py', 'apply.py'],
    ['python -c "import os; os.system(\'terraform destroy -auto-approve\')"', 'python -c'],
    ['node -e "require(\'child_process\').execSync(\'cdk deploy\')"', 'node -e'],
    ['echo "terraform destroy -auto-approve" | bash', 'piped into'],
    ['bash <<EOF\nterraform apply -auto-approve\nEOF', 'heredoc'],
    ['$TF apply', 'variable'],
    ['"$(which terraform)" apply', 'variable'],
    ['env -S "terraform apply"', 'env -S'],
    ['npx -c "cdk deploy"', '-c'],
    ['ls | xargs terraform apply', 'xargs'],
  ])('%s', (cmd, mention) => {
    const res = d(cmd);
    expect(res.kind).toBe('deny');
    expect(res.kind === 'deny' && res.reason).toContain(mention);
  });
});

describe('asks a human for operations with no plan', () => {
  it.each([
    'terraform state rm aws_db_instance.main',
    'terraform state mv a b',
    'terraform state push errored.tfstate',
    'terraform taint aws_instance.web',
    'terraform force-unlock 1234',
    'terraform workspace delete prod',
    'terragrunt run-all apply',
    'terragrunt --terragrunt-working-dir infra apply',
    'cdk import',
    'cdk watch',
    'cdk gc',
    'aws cloudformation delete-stack --stack-name prod',
    'sam delete',
  ])('%s', (cmd) => {
    expect(kind(cmd)).toBe('ask');
  });

  it('asks for acks, with the saved summary', () => {
    expect(kind('plansentry exec --ack 0123456789ab -- terraform apply /x/.plansentry/plans/0123456789ab.tfplan')).toBe('ask');
  });

  it('denies instead of asking when no prompt can be shown', () => {
    for (const mode of ['bypassPermissions', 'dontAsk']) {
      const res = d('terraform state rm aws_db_instance.main', mode);
      expect(res.kind).toBe('deny');
      expect(res.kind === 'deny' && res.reason).toContain('! ');
    }
    expect(kind('plansentry exec --ack 0123456789ab -- terraform apply x', 'bypassPermissions')).toBe('deny');
    expect(kind('terraform taint x', 'default', 'codex')).toBe('deny');
  });

  it('never lets an ack run from inside a script or substitution', () => {
    expect(kind('bash -c "plansentry exec --ack 0123456789ab -- terraform apply x"')).toBe('deny');
  });

  it('asks the human for `make nuke`-style indirect state changes', () => {
    expect(kind('bash -c "terraform state rm x"')).toBe('ask');
  });
});

describe('combined commands', () => {
  it('asks to split a command mixing an apply with an ask-level operation', () => {
    const res = d('terraform state rm x && terraform apply');
    expect(res.kind).toBe('deny');
    expect(res.kind === 'deny' && res.reason).toContain('separately');
  });

  it('rewrites every apply in a chain', () => {
    const res = d('terraform apply -auto-approve; cd ../b && tofu apply -auto-approve');
    expect(res.kind === 'deny' && res.reason).toContain('plansentry exec -- terraform apply -auto-approve; cd ../b && plansentry exec -- tofu apply -auto-approve');
  });
});
