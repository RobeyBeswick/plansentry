# Changelog

All notable changes to this project are documented in this file.

## [0.1.1] - 2026-11-04

### Added

- Repeatable data-loss demo with real Terraform plans and local AWS mocks. It shows
  the same destructive rename leaving 0 orders and 0 invoices without PlanSentry,
  versus 25 orders and 3 invoices with PlanSentry.
- Live-agent demo fixture pinned to the local mock.
- Installation warning when the `plansentry` executable is not on the agent's PATH.
- CI coverage for Node.js 22 and 24 on Linux and macOS.

### Changed

- Node.js 22 or newer is now required.
- Release checks build before running tests and fail if the Terraform end-to-end
  prerequisites are missing.
- Dependency updates resolve the previously reported audit findings.

### Fixed

- Hook timeouts and unexpected errors now deny infrastructure commands instead of
  failing open.
- Applies behind `bash` options that take a value, and behind `time -p`, are now
  detected.
- Terragrunt applies are held for approval regardless of option order.
- Nested CloudFormation stack changes now require approval because their contents
  are not diffed.
- Held resources remain visible when report output is truncated by tools such as
  `tail`.

### Documentation

- Added the demo recording guide and publishing checklist.
- Documented nested-stack behaviour and shell forms that are not detected.

## [0.1.0] - 2026-09-26

Initial npm release.
