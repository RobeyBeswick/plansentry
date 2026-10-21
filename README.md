# plansentry: a safety net for AI agents running Terraform, OpenTofu and AWS CDK

<div align="center" name="top">

[![Claude Code Hook](https://img.shields.io/badge/Claude_Code-Hook-6272F5)](https://code.claude.com/docs/en/hooks-reference)
[![Codex Hook](https://img.shields.io/badge/Codex-Hook-10A37F)](#-2-min-quickstart)
[![Terraform | OpenTofu | CDK](https://img.shields.io/badge/Terraform_|_OpenTofu_|_CDK-supported-844FBA)](#-what-it-catches)
[![npm](https://img.shields.io/npm/v/plansentry.svg)](https://www.npmjs.com/package/plansentry)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

Let your agent run `terraform apply` and `cdk deploy`. plansentry stops it only when the plan would
destroy your data.

### Reads the Plan, Not the Command.

Blocklists see `terraform apply` and must either allow it or block it. plansentry makes the plan,
reads it, and blocks only if a database, bucket, table or key would be **destroyed or replaced**.
Everything else goes through.

### Applies Exactly What Was Checked.

The checked plan file (or synthesized CDK assembly) is the thing that gets applied. Nothing is
re-planned between the check and the apply.

### You Approve, Not the Agent.

When something dangerous shows up, nothing runs. The agent gets a one-time approval command, and the
hook turns that command into a permission prompt **for you**. Agents without prompts, like Codex,
ask you to run it yourself.

---

[Quick Start](#-2-min-quickstart) • [Demo](#-demo) • [How It Works](#-how-it-works) • [What It Catches](#-what-it-catches) • [Config](#%EF%B8%8F-config) • [FAQ](#%E2%84%B9%EF%B8%8F-faq)

---

## ⚡ 2 min Quickstart

Requires Node.js 20+.

```bash
npm install -g plansentry
```

Then hook it into your agent:

```bash
plansentry install claude     # Claude Code (add --project for just this repo)
plansentry install codex      # Codex, then approve the hook with /hooks
```

That's it. Keep working as usual. When your agent runs an apply or deploy, plansentry steps in.

## 🎬 Demo

“Just add `shop-` to the resource names.” The repeatable demo shows what that change
does to a shop with **25 paid orders and three invoices**:

| Same rename, separate disposable shops | Orders left | Invoices left |
|---|---:|---:|
| Without plansentry: apply succeeds, resources are replaced | 0 | 0 |
| With plansentry: replacement blocked before apply | 25 | 3 |

Run it from a checkout with Node.js 20+, Terraform 1.5+ and `uv`:

```sh
npm ci
npm run demo            # Enter advances each scene
npm run demo -- --auto  # uninterrupted rehearsal with assertions
```

Scripted requests, real Terraform plans and real PlanSentry decisions. Synthetic data
lives in two local AWS mocks: the unguarded copy really loses its data, and the guarded
copy is read back to verify every record survived. A safe tag update goes through first.
The bucket deliberately has `force_destroy` enabled to make the data-loss case visible.
No model, cloud account or global hook installation is needed.

The first run downloads the demo dependencies. See the [recording guide and spoken
script](docs/DEMO.md), or the optional [live-agent setup](examples/agent-demo/README.md).

## 🔎 How It Works

1. **The hook checks every shell command** your agent runs. It follows `cd`, `&&`, `bash -c`,
   `npx`, Makefiles, npm scripts and local scripts, so an apply can't hide behind a wrapper.
2. **Applies are sent through `plansentry exec`.** The agent is told the exact command to re-run.
3. **`plansentry exec` makes the plan and reads it.** Safe? It applies that plan. Dangerous? It stops
   and saves the plan for your approval.

Commands that change state without a plan (`terraform state rm`, `taint`, `force-unlock`,
`cdk import`, `aws cloudformation delete-stack`, ...) always ask you first.

## 🦈 What It Catches

| | Examples | What happens |
|---|---|---|
| 🔴 **Danger** | Deleting or replacing RDS/Aurora, DynamoDB, S3, EFS, KMS keys, ElastiCache, OpenSearch, Kinesis, Secrets Manager, Route 53 zones, and more | Stops and waits for you |
| 🟡 **Warn** | Deletion protection turned off, `DeletionPolicy: Retain → Delete`, resources dropped from state, CDK hotswap | Shown in the report |
| ⚪ **Info** | Deleting anything else | Shown with `--verbose` |

It also tells you **why**: "forced by: KeySchema", "autoDeleteObjects is on", "no final snapshot".
When in doubt, it blocks. An errored plan, or a CDK stack whose deployed version it can't read,
needs your approval.

## ⚙️ Config

Optional. Drop a `.plansentry.json` in your repo:

```json
{
  "statefulTypes": { "add": ["acme_database"], "remove": ["aws_s3_bucket"] },
  "ignore": ["module.sandbox.**", "DevStack/*"],
  "approvalLevel": "danger"
}
```

Set `approvalLevel` to `"warn"` to be stricter. A typo in a key is an error, never a silent off switch.

**In CI**, run `plansentry check plan.tfplan` (or `plansentry check cdk.out`). It exits `3` when a
plan needs a human.

## ℹ️ FAQ

**Q: Why not just deny `terraform apply` in my agent's permission rules?**

Then the agent can't do infra work at all, or you click "allow" all day without seeing the plan.
plansentry lets routine changes through and puts the plan in front of you only when it matters.

**Q: Isn't `prevent_destroy` enough?**

It helps, and you should use it. But per the Terraform docs it "doesn't prevent Terraform from
destroying a resource if you remove its configuration", and an agent can simply edit it out.
plansentry checks the plan, whatever the config says.

**Q: Can it stop a malicious agent?**

No. It protects against honest mistakes, like "I'll just recreate the table to fix the schema". For
real isolation, also give the agent least-privilege credentials and turn on deletion protection.

**Q: What doesn't it cover yet?**

Terragrunt plans aren't analysed yet (terragrunt applies always ask you). Nested CloudFormation stacks
aren't diffed, so any change to one asks you (add it to `ignore` to skip that). Commands built at
runtime (`eval "$CMD"`) can't be seen, and neither can applies behind less common shell constructs
(shell functions, loops over subcommands, `xargs`, `find -exec`).

**Q: How do I see what the hook would do?**

```bash
plansentry explain "make deploy"
```

## 📄 License

This project is under the **MIT** license.

---

<p align="center">
  <a href="#top"><strong>Go Back to Top</strong></a>
</p>
