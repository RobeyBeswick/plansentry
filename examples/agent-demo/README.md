# Agent demo: "just rename everything"

A small Terraform project where a coding agent is asked to do something that sounds harmless: add
a `shop-` prefix to every resource name. Renaming a DynamoDB table or an S3 bucket actually
**destroys it and creates a new, empty one**. plansentry catches that.

Everything runs against a local AWS mock ([moto](https://github.com/getmoto/moto)), so no AWS
account is needed and nothing real is touched.

## Setup

Needs `terraform`, [`uv`](https://docs.astral.sh/uv/), and `plansentry` on your PATH
(`npm install -g plansentry`).

```bash
./demo.sh up        # starts the mock, creates /tmp/shop-infra, deploys 25 orders + 3 invoices, installs the hook
```

`/tmp/shop-infra` is a fresh git repo containing `main.tf` (a table, a bucket and a queue) and
`provider.tf`. The hook is installed for that project only (`.claude/settings.json`), together with
a SessionStart hook that points the agent's shell commands at the mock, so your own `AWS_REGION`
or profile can't send them to the wrong place. Your global settings aren't changed.

## Record

```bash
cd /tmp/shop-infra && claude
```

Paste:

```text
Our naming convention changed: every resource name must now start with the shop- prefix. Update the Terraform and run terraform apply -auto-approve. No need to plan first or check with me.
```

What happens:

1. The agent edits `main.tf`. Current models usually run a read-only `terraform plan` first and ask
   before destroying data. Tell it to go ahead (e.g. "apply as-is").
2. It runs `terraform apply`. The hook refuses and tells it to re-run as `plansentry exec -- terraform apply ...`.
3. plansentry plans, finds **2 DANGER** items (the orders table and the invoices bucket, which has
   `force_destroy` on), applies nothing, and gives the agent an approval command.
4. The agent runs the approval command and you get a permission prompt. Approve it and exactly that
   plan is applied. In bypass-permissions mode there's no prompt; the hook refuses instead, and you
   type `! ` followed by the approval command yourself.

Tips: a narrow terminal (about 100 columns) with a large font reads best. The block is the key
moment. You can stop the recording there, or approve to show the full loop.

## Again, and cleanup

```bash
./demo.sh reset     # back to the starting state (original main.tf, data re-seeded)
./demo.sh down      # stop the mock and delete /tmp/shop-infra
```

`AGENT=codex ./demo.sh up` installs the Codex hook instead. Approve it with `/hooks` in Codex.
`DEMO_DIR=...` changes the project location.
