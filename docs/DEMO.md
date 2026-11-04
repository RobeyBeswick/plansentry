# Recording the PlanSentry demo

Aim for **about three minutes**, including the opening and closing cards.
The demo uses scripted requests, the real PlanSentry CLI, real Terraform plans,
and synthetic data stored in two separate local Moto processes.

The story is “just add `shop-` to the resource names.” Both shops begin with
25 paid orders awaiting shipment and three invoices. In the unguarded copy,
Terraform replaces the table and bucket: the old resources disappear and the
new resources are empty. In the guarded copy, PlanSentry blocks the same change
and the demo reads back every order and invoice to verify they survived.

There is no live model to persuade into making a mistake. Say that the requests
are scripted; this is a reproducible guard walkthrough, not an agent recording.

## Prepare

Requires Node.js 20+, Terraform 1.5+, and `uv` on your PATH.

```sh
npm ci
npm run demo -- --auto
```

The first run downloads Moto 5.2.2 and Terraform's AWS provider 5.100.0.
The provider cache is in the checkout's ignored `.demo-cache/terraform/`;
Python dependencies use uv's cache. Rehearse with network access before the
presentation. A cached run can still need the package registries for resolution.
The setup and each operation have time limits; a failed check exits unsuccessfully.

Neither an AWS account nor AWS CLI is needed. The runner uses dummy credentials,
explicit loopback endpoints, a private Terraform CLI configuration, and fresh
temporary directories. It does not install agent hooks or change global settings.
The two mock servers select their own unused ports and never reuse a running mock.

A successful rehearsal ends with:

```text
Demo complete. Both mocks stopped; temporary shops removed.
```

## Record

Skip the build chatter once you have rehearsed:

```sh
node scripts/demo.mjs
```

Wait for preparation to finish and the opening card to appear, then start recording.
**Press Enter once per scene.** Each scene clears the screen. On the closing card,
stop recording before pressing Enter again to clean up.

Use a terminal around **100 columns by 36 rows**, with a readable font and a 16:9
recording area. Open it through `cmux` if you need a new terminal. Hide tabs, titles
and shell prompts containing personal details. Output paths are replaced with
`<demo>` / `<control>` placeholders. `NO_COLOR=1` disables colors.

Ctrl-C stops both mocks and removes the temporary shops. Closing interactive
input also cleans up. Piped input or output automatically runs without pauses.
Download caches remain for the next take.

## Spoken script

These timings are cues, not a timer. Let viewers read the counts and the danger
report before advancing.

| Time | Screen | Say |
|---|---|---|
| 0:00–0:20 | Opening card | “The request sounds harmless: just rename the resources. But these resources hold paid orders and invoices. This is a scripted replay with real Terraform and real guard decisions, using synthetic data in two local mocks.” |
| 0:20–0:40 | **1 / 5 — Something worth protecting** | “Here are 25 orders waiting to ship and three invoices. We read them back from the table and bucket. Read-only work passes through the hook.” |
| 0:40–1:00 | **2 / 5 — Routine work** | “First, change a tag. PlanSentry checks the plan and applies it. Every order and invoice is unchanged. Routine work keeps moving.” |
| 1:00–1:35 | **3 / 5 — Without PlanSentry** | “Now add a prefix to the names. In this disposable control, we let Terraform apply it. It reports success. But the old table and bucket are gone, and the new ones are empty. Zero orders. Zero invoices. The bucket had force-destroy enabled, so its contents did not stop the replacement.” |
| 1:35–2:15 | **4 / 5 — With PlanSentry** | “Same change, same command, separate copy of the same data. The hook routes the apply through PlanSentry. It reads the actual plan: replace the orders table, replace the invoices bucket. It stops before applying. All 25 orders and all three invoices are still there.” |
| 2:15–2:40 | **5 / 5 — The human decides** | “The checked plan is saved. Its approval command produces an ask-human response from the real hook. This is the hook response, not a running agent UI. We leave that plan unapproved, and the data stays intact.” |
| 2:40–3:00 | Closing card | “The apply can succeed while your data disappears. PlanSentry checks what the change will do before it runs. It guards against mistakes; it is not a sandbox against a malicious agent. Run the same demo from the checkout.” |

For a **90-second cut**, shorten the opening, omit scenes 1, 2 and 5 in the edit,
and keep the unguarded loss, guarded block and final comparison. Keep the
“scripted requests, local mocks” disclosure.

## Finish the video for publication

- [ ] Capture a 16:9 master at 1920×1080 or higher, with a font that remains
  readable in the exported video. Use 30 fps for the final export.
- [ ] Record the narration above, leaving room to read the danger report and
  both sets of counts. Trim preparation, long waits and the cleanup screen.
- [ ] Keep **“Scripted requests · real Terraform + PlanSentry · local mocks”**
  visible in the opening and short cut. Label scene 5 as a replayed hook
  response; it does not show a live agent UI.
- [ ] Keep the unguarded result, the real block report, the preserved counts and
  the `force_destroy` explanation. Do not edit the sequence to imply a
  production account, a live model or a production incident.
- [ ] Add captions and review command/resource names by hand. Check the
  exported audio and terminal text at normal playback size.
- [ ] Finish the roughly three-minute walkthrough and a 60–90-second launch
  cut. Export MP4 with H.264 video and AAC audio, plus an SRT caption file for
  each cut.
- [ ] Create a thumbnail with **“Just rename the resources.”** and the measured
  comparison: **Without: 0 orders / 0 invoices; With: 25 orders / 3 invoices**.
- [ ] Add the public repository and `npm run demo` to the closing card. Add an
  npm install call to action only after the intended release is available.
- [ ] Watch the full exports for private paths, usernames, account identifiers,
  notifications and unrelated windows. Keep raw captures outside Git.

Suggested deliverables: `plansentry-demo.mp4`, `plansentry-demo.srt`,
`plansentry-demo-short.mp4`, `plansentry-demo-short.srt` and
`plansentry-demo-thumbnail.png`. These are target filenames, not existing assets.
Upload the reviewed files with the release, then add a working video link or
embed to the README and test it while signed out.

Continue with the [publishing checklist](PUBLISHING.md) for versioning, package
verification, public source, release assets and the launch post.

## What is executed and verified

- Setup creates a table and bucket in each mock and seeds identical data.
- A read-only hook request passes silently; that request is inspected, not run.
- A tag change runs through `plansentry exec` and applies successfully.
- The unguarded rename actually replaces its mock resources. Queries confirm
  the old resources are absent and both replacement resources are empty.
- The guarded rename goes through the real hook and CLI. The CLI exits `3`,
  identifies both replacements and their changed attributes, and saves a plan.
- The guarded Terraform state is unchanged. Every order field and every invoice's
  contents match their original values; replacement resources do not exist.
- The real Claude hook returns `ask` for the approval command. The generic hook
  and Claude bypass-permissions mode deny it. No approval command is executed.

Terraform progress is captured to keep the recording legible. The displayed
PlanSentry report is an excerpt of actual CLI output, with paths sanitized.
Counts come from data reads, not hardcoded outcome messages.

The bucket deliberately has `force_destroy = true`, and the table has no deletion
protection. This fixture demonstrates a destructive plan that can succeed, not a
recommended production configuration. Moto is a local simulation; the demo does
not validate a production deployment or every AWS service behavior.

## Files

- `scripts/demo.mjs`: scene runner, real hook/CLI calls, assertions and cleanup.
- `scripts/demo/main.tf`: the disposable table and bucket.
- `scripts/demo/mock.py`: loopback Moto server, seeding and data reads.
- `examples/agent-demo/`: the optional live-agent variant. Model behavior varies;
  use this scripted walkthrough for a repeatable presentation.
