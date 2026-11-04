# Publishing checklist

Prepared **2026-10-30**, using the same handoff format as NoMeatProxy.
Work through the numbered steps in order: record the demo, prepare and verify
the release, make the source public, publish the package, then announce it.

**This is a public-source launch and an npm update.** `plansentry@0.1.0` is
already published. Suggested next version: **0.1.1**, subject to rechecking the
registry before release. Do not try to publish `0.1.0` again.

## Current state

| Area | Verified state on 2026-10-30 |
| --- | --- |
| Source | `main` at `4096830`; working tree clean before this documentation handoff |
| npm | `0.1.0` is `latest`, published 2026-09-26; registry `gitHead` is `f8d10af`, nine commits behind this checkout |
| Package metadata | Both manifests still say `0.1.0`; no `"private": true` flag |
| GitHub | Private repository; no tags, releases, Actions workflows or runs found |
| Video preparation | [Three-minute spoken script and recording guide](DEMO.md), automated rehearsal and optional live-agent fixture exist |
| Finished video | No tracked video found; recording, editing, captions and upload remain |
| Release documentation | No `CHANGELOG.md`, `SECURITY.md` or dated live-client compatibility record found |
| Dependency audit | Six affected packages: two moderate, two high and two critical; production-only audit reports one moderate package (`fast-uri`) |
| Public-content review | History-aware secret scan, commit-metadata review and media review remain |

The published package predates fixes for hook failures, shell-wrapper detection,
Terragrunt approval handling, nested stack changes and approval-report visibility,
as well as the new demo. An installation of `0.1.0` does not validate this checkout.

Local verification for source commit `4096830`:

- `npm ci`, typecheck, build and **all 145 tests passed**, including both real
  Terraform end-to-end tests.
- Packed-package smoke check passed: **30 files, about 41 KiB compressed**,
  installed outside the source tree. Version reporting, read-only allow, apply
  redirect, destructive-plan exit `3`, and both agents' project hook
  install/uninstall worked.
- `npm run demo -- --auto` passed: safe update applied, the unguarded shop lost
  its data, the guarded shop preserved every order and invoice, the approval
  responses matched expectations, and both mocks and temporary shops cleaned up.
- Runtime: Node.js `22.22.2`, npm `10.9.7`, Terraform `1.5.7`, macOS ARM64.
- Dependency audit is **not clear**; see step 3. These checks do not establish
  live agent compatibility or production deployment coverage.

Rerun verification after release changes. Local passes do not complete the
unchecked release tasks below.

## 1. Record and finish the demo video

- [ ] Follow [DEMO.md](DEMO.md) for the complete spoken script, scene controls,
  terminal setup, editing checklist and final assets.
- [ ] On the recording machine, install Git, a maintained Node.js runtime with
  npm, Terraform 1.5+ and `uv`. Use `cmux` if opening a new terminal.
- [ ] Rehearse once with network access:

```sh
npm ci
npm run demo -- --auto
```

- [ ] Confirm the safe tag update applies, the unguarded shop ends with **zero
  orders and zero invoices**, and the guarded shop retains **25 orders and
  three invoices**. Require the final cleanup success message.
- [ ] Record the interactive run after preparation finishes:

```sh
node scripts/demo.mjs
```

- [ ] Produce a roughly three-minute walkthrough and a 60–90-second launch cut.
  Keep the scripted-requests/local-mocks disclosure in both.
- [ ] Keep the actual danger report, measured before/after counts and the
  distinction between a replayed hook response and a live agent permission UI.
- [ ] Finish narration, captions, thumbnail and closing card. Review every
  frame for private paths, identifiers, notifications and terminal history.
- [ ] Keep raw captures outside Git. Upload the reviewed export with the release
  in step 7, then add and verify the README video link.

The deterministic demo is the primary recording. The optional live-agent demo
can provide extra footage after compatibility checks, but model behavior may
not follow the storyboard.

## 2. Prepare the release machine and check ownership

- [ ] Use the intended personal release machine, with GitHub CLI and npm access
  to this repository and package. Authenticate interactively if needed.
- [ ] Clone or update the checkout, then confirm its branch and working tree:

```sh
gh repo clone RobeyBeswick/plansentry
cd plansentry
git status --short --branch
npm ci
npm whoami
npm owner ls plansentry
npm view plansentry version dist-tags gitHead --registry=https://registry.npmjs.org/
```

Run the clone commands only for a new checkout. Do not copy credentials or
personal agent settings into the repository.

- [ ] Confirm the publishing identity has package access and the required npm
  authentication is configured.
- [ ] Recheck that `0.1.1` is unused. If another release has appeared, choose the
  next appropriate version and replace `0.1.1` throughout the commands below.

## 3. Prepare the version, dependencies and checks

```sh
git switch -c chore/public-launch
npm version 0.1.1 --no-git-tag-version
npm outdated
npm audit
npm audit --omit=dev
```

Run and inspect these individually: outdated packages and audit findings can
produce nonzero exit codes.

- [ ] Review and resolve the audit findings before release. The current
  production finding is in `fast-uri`; the development findings include
  Vitest, its mocker, Tinypool, Vite and `source-map-js`. Distinguish dependency
  findings from demonstrated exploitability in PlanSentry.
- [ ] Review targeted dependency updates and the lockfile diff. Some current
  audit fixes propose a Vitest major upgrade; do not apply `npm audit fix
  --force` blindly. Record any remaining finding's applicability and disposition.
- [ ] Decide the supported Node versions. The package currently advertises
  `>=20`, but Node 20 reached end of life on 2026-04-30 according to the
  [official release schedule](https://github.com/nodejs/Release/blob/main/schedule.json).
  Align `engines`, README, demo prerequisites, Node types and CI with the chosen
  support policy; use maintained runtimes for launch validation.
- [ ] Ensure builds happen **before tests** in the release check. The current
  `prepublishOnly` runs tests before building; Terraform end-to-end tests skip
  without `dist/cli.js` or Terraform, and can otherwise exercise an old build.
  Change it to `npm run typecheck && npm run build && npm test`, or use a shared
  check script with that order.
- [ ] Add CI for the supported Node/platform combinations, installing Terraform
  before running the checks. Node 22 and 24 on Linux and macOS are a reasonable
  initial matrix; broaden advertised support only with evidence.
- [ ] Make missing end-to-end prerequisites fail the release check instead of
  accepting a run with those tests skipped.
- [ ] Confirm both manifests have the release version and review
  `git diff -- package.json package-lock.json`.

## 4. Finish public documentation and content review

- [ ] Add `CHANGELOG.md` covering changes since the published `0.1.0`, including
  the safety fixes and reproducible demo.
- [ ] Add `SECURITY.md` with a working private reporting route; configure the
  route before advertising it.
- [ ] Check the README quickstart against the release candidate. Retain the
  restart/trust instructions, the need for the executable on the agent's PATH,
  and the distinction between client permission modes.
- [ ] Keep claims scoped to supported operations and tested clients. Preserve
  the shell-parsing limitations, Terragrunt approval requirement, nested-stack
  limitation and “guard against mistakes” qualification.
- [ ] Verify AWS feature claims against current official documentation before
  adding them to the launch copy. Do not present the local mock demonstration
  as a production deployment test.
- [ ] Run a history-aware secret scan, such as `gitleaks git --redact .` after
  installing Gitleaks, and inspect the results privately.
- [ ] Review tracked content and commit metadata for secrets, internal domains,
  account identifiers, personal paths and customer information. Use synthetic
  examples such as `123456789012`, `jsmith`, `Acme Corp` and `~/project`.
- [ ] Review any Actions logs and artifacts created during preparation before
  changing visibility. GitHub makes Actions history and logs public when the
  repository becomes public.
- [ ] Check the npm tarball contents and README links as well as the source.
  The package currently includes `dist`, README, LICENSE and package metadata;
  demo scripts and `docs/` are checkout-only. Make documentation links resolve
  for npm readers.

If sensitive content is found, remove it from history and artifacts as needed,
and rotate exposed credentials before publication.

## 5. Validate the advertised integrations

- [ ] Install the candidate tarball in an isolated environment and make its
  executable available to the test clients. Confirm its version; do not
  accidentally validate npm's older `0.1.0`.
- [ ] Use the [live-agent fixture](../examples/agent-demo/README.md) in a
  disposable workspace for each advertised client. Verify endpoint isolation
  and dummy credentials before running it.
- [ ] For Claude Code, observe read-only work passing, an apply being redirected,
  the safe update succeeding, the destructive plan being held, and the real
  human permission prompt. Confirm bypass-permissions mode cannot self-approve.
- [ ] For Codex, verify hook loading/trust, routing and the human handoff with the
  actual installed client. A simulated generic hook response is not evidence
  that the current client loads and enforces the integration.
- [ ] Verify the checked-plan approval path only in a disposable fixture, then
  confirm managed hook uninstall works without removing unrelated settings.
- [ ] Validate OpenTofu and CDK behavior separately if advertising them in the
  launch. The recording uses Terraform; it is not evidence for either of those
  execution paths.
- [ ] Record date, OS, runtime/tool/client versions, permission modes, results
  and gaps in `docs/COMPATIBILITY.md`. Keep raw transcripts private. Narrow any
  launch claim that cannot be verified.

The deterministic runner does not install hooks or launch a model. Live-client
testing is a separate release task and can consume configured model usage.

## 6. Verify, commit and merge the release candidate

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run demo -- --auto
npm audit
npm audit --omit=dev
npm pack --dry-run
git diff --check
git status --short
```

- [ ] Require all applicable tests, the data-preservation assertions and cleanup
  to pass. Confirm no end-to-end tests were skipped.
- [ ] Confirm the video still matches the verified release; rerecord affected
  scenes if preparation changed the displayed behavior or commands.
- [ ] Review the audit disposition from step 3 and every package file. Exclude
  credentials, local reports, Terraform state/plans, caches and raw media.
- [ ] Repeat a packed-package installation smoke check outside the source tree,
  including version, `explain`, destructive-plan exit `3`, and project hook
  install/uninstall.

For the package installation check, start in the built checkout:

```sh
plansentry_check_dir="$(mktemp -d)"
npm pack --pack-destination "$plansentry_check_dir"
npm install --prefix "$plansentry_check_dir" --omit=dev \
  "$plansentry_check_dir/plansentry-0.1.1.tgz"
(
  cd "$plansentry_check_dir"
  export PATH="$plansentry_check_dir/node_modules/.bin:$PATH"
  plansentry version
  plansentry explain "terraform plan"
  plansentry explain "terraform apply -auto-approve"
  plansentry install claude --project
  plansentry uninstall claude --project
  plansentry install codex --project
  plansentry uninstall codex --project
)
```

Verify the reported version, `PASS` for the plan and `DENY` for the apply.
Inspect the temporary project's settings before and after uninstall. Use a
synthetic replacement plan with `plansentry check` to verify exit `3`; the
`explain` commands alone do not exercise plan analysis.

- [ ] Review and commit the intended files using conventional commits, push the
  release branch, and merge through a reviewed pull request.
- [ ] Obtain passing CI for the final release commit. Any implementation,
  dependency or packaging change after verification needs the relevant checks
  rerun.

## 7. Make the source public and prepare the final assets

- [ ] After the content review, change GitHub visibility using repository
  **Settings → General → Danger Zone → Change visibility → Public**.
- [ ] In a signed-out browser, check the repository, license, README and guides.
  Resolve inaccessible or private links before announcing them.
- [ ] From the verified, merged commit on `main`, build the final package:

```sh
git switch main
git pull --ff-only
git status --short
git rev-parse HEAD
npm ci
npm run typecheck
npm run build
npm test
npm pack
```

- [ ] Start with a clean working tree and record the exact release commit.
  Inspect `plansentry-0.1.1.tgz`; do not change its contents before publication.
  Keep the generated archive untracked.
- [ ] Stage reviewed release notes, video exports, captions and thumbnail
  outside the repository. Include installation, changes since `0.1.0`, the
  compatibility evidence and known limitations in the notes.

The video can be attached to the GitHub Release alongside the tarball. After the
release is public, link or embed the published video in the README and check
playback while signed out. A later README-only video-link commit need not move
the already published version tag.

## 8. Publish npm and create the GitHub Release

These commands perform the release. Run them after the preceding checks, using
the verified archive and publishing account.

```sh
npm publish ./plansentry-0.1.1.tgz --dry-run --registry=https://registry.npmjs.org/
npm publish ./plansentry-0.1.1.tgz --access public --registry=https://registry.npmjs.org/
npm view plansentry@0.1.1 version dist.integrity --registry=https://registry.npmjs.org/
npm view plansentry dist-tags --json --registry=https://registry.npmjs.org/
```

- [ ] Confirm `0.1.1` is available, its integrity matches the local packed
  artifact, and `latest` points to it.
- [ ] Tag the recorded release commit, then push the tag:

```sh
git tag -a v0.1.1 <release-commit> -m "PlanSentry 0.1.1"
git push origin v0.1.1
```

Replace `<release-commit>` with the hash recorded in step 7.

- [ ] Create the GitHub Release for that tag, attach the same tarball and the
  reviewed video assets, and use the prepared notes:

```sh
gh release create v0.1.1 ./plansentry-0.1.1.tgz \
  --verify-tag --title "PlanSentry 0.1.1" \
  --notes-file /path/to/release-notes.md
```

Attach the final exports using the release editor or include their actual paths
in the command. The example notes path is a placeholder.

If a command fails, check what actually published before retrying. npm does not
allow reuse of a published name/version combination. Do not overwrite release
tags to hide a mismatch.

## 9. Test the public installation, then announce

From a clean environment outside the checkout:

```sh
npm install --global plansentry@0.1.1
plansentry version
plansentry explain "terraform plan"
plansentry explain "terraform apply -auto-approve"
```

`explain` inspects the command string without executing it. Expect `PASS` for
the plan and `DENY` with a redirect through `plansentry exec` for the apply.
Both diagnostic commands themselves exit `0`; the destructive-plan check,
not `explain`, is the operation expected to return `3`.

- [ ] Repeat the live allow/block canary using the public package in a
  disposable workspace. Confirm project hook install, client restart/trust and
  uninstall using the applicable agent.
- [ ] Check that the unversioned README install command selects the intended
  release.
- [ ] Add the working public video to the README and release notes. Check video,
  captions, documentation and installation links while signed out.
- [ ] Prepare the launch post around “just rename the resources,” showing the
  measured **0/0 versus 25/3** outcome. Include the public repository, install
  command and short video, plus the scripted-demo/local-mocks disclosure.
- [ ] Review the final post and publish it to the chosen channels only after
  the public installation and links work.
- [ ] Check off completed steps with the final release version, commit and
  public artifact locations. Track subsequent product work separately.

## References

- [npm publish: archives, dry runs and version immutability](https://docs.npmjs.com/cli/v10/commands/npm-publish/)
- [npm lifecycle scripts](https://docs.npmjs.com/cli/v10/using-npm/scripts/)
- [GitHub repository visibility and public Actions history](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)
- [Node.js release schedule](https://github.com/nodejs/Release/blob/main/schedule.json)

Registry and GitHub status above were checked with `npm view`, `gh repo view`,
the tags/workflows APIs and `gh release list` on the preparation date.
