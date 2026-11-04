# Compatibility and release validation

Last updated: **2026-11-04**.

This record covers the local checks performed for the 0.1.1 release candidate.
It is not a substitute for live-client testing.

## Local release candidate

| Area | Result |
| --- | --- |
| Platform | macOS ARM64 |
| Node.js | 22.23.4 |
| npm | 10.9.9 |
| Terraform | 1.15.8 |
| uv | 0.13.7 (Python 3.12 downloaded by the demo) |
| Test runner | Vitest 5.1.0 |
| Typecheck and build | Passed |
| Test suite | 145 passed, including both real Terraform end-to-end tests |
| Dependency audit | 0 vulnerabilities, including production dependencies |
| Packed package | 30 files, 41.6 kB compressed, version `0.1.1` |
| Packed-package smoke test | Passed outside the source tree: version, `explain`, project hook install/uninstall for Claude and Codex, and destructive-plan exit `3` |
| Deterministic demo | `npm run demo -- --auto` passed; the unguarded shop lost its data and the guarded shop retained 25 orders and 3 invoices |

## Integration coverage

| Integration | Status |
| --- | --- |
| Terraform | Real end-to-end tests pass locally |
| Claude Code | Hook protocol and install/uninstall are covered by tests and the packed-package smoke test. A live client permission prompt has not been verified for this release. |
| Codex | Hook protocol and install/uninstall are covered by tests and the packed-package smoke test. Live hook loading/trust has not been verified for this release. |
| OpenTofu | Not validated for this release. |
| AWS CDK | Analysis tests pass; a live `cdk deploy` against a real account was not performed. |
| AWS production deployment | Not tested. The demo uses local AWS mocks and is not evidence of production behaviour. |

## Known limits

- Terragrunt plans are not analysed; Terragrunt applies ask for approval.
- Nested CloudFormation stack contents are not diffed; changes require approval.
- Commands built at runtime and less common shell constructs are not detected.
- PlanSentry guards against accidental destructive changes. It is not a sandbox
  against a malicious agent.

Live-client testing should be repeated when the advertised client versions or
permission modes change, and the results recorded here with the date, client
version and observed outcome.
