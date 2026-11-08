# PEOS — UI evaluator (`eval-ui`) design

- Status: Implemented (increment 7e, 2026-11-08); see §14 for what differs from this draft
- Date: 2026-11-03
- Scope: extends [peos-v2-plugin.md](peos-v2-plugin.md) §8–§11 and [design-gate.md](design-gate.md)

## 1. Problem

A run can reach the release stage with a user interface change that nobody rendered.
`eval-code` reads the diff and `checks.json`, and since 5l it lists an unrendered
interface under `notAssessed`; nothing judges the screen itself. `rules/ui-ux.md` is
six lines of guidance, `references.design` in the configuration is written empty by
`setup` and read by no agent, and the spec has no place for screens or UI states.

Goal: every run that changes a user interface either carries observed evidence for its
UI acceptance criteria (what the screen shows, in which state and viewport) or says
plainly in `summary.md` that the interface was not verified and why.

Non-goals:

- Pixel-diff visual regression against stored baselines (a project tool's job; PEOS
  only reads its result as a check).
- Design generation or redesign. The evaluator judges against the spec and the
  project's design system; it never proposes a new look.
- Performance and Lighthouse budgets (`eval-performance`, increment 7).
- Physical devices, store builds, production URLs.

## 2. Principles applied

| Toolkit principle | Consequence here |
| --- | --- |
| Deterministic before LLM | A script decides *whether* UI changed and *whether* an app can be shown; the model only judges what it sees. Accessibility rules a tool can check come from a check, not from the model's eye. |
| Evaluators are read-only | `eval-ui` writes only its report. Browser tools that type or click are allowed only against the run's own preview origin (§7). |
| Evidence bound to code state | The report's `subject` is the code fingerprint, like every code evaluation; a code change invalidates it. |
| Proportional ceremony | Only runs whose diff matches a UI trigger pay for it. |
| Honest degraded mode | No preview, no browser tool: the evaluator is not spawned and the summary says so; it never guesses from code. |

## 3. Pipeline placement

```text
[V] finish → checks.json, changes (+ uiTriggers)
[E] in parallel: eval-code · eval-security (triggered) · eval-ui (triggered, preview available)
      FAIL → implementer → [V] → rerun every recorded code-state evaluation
[R] release: every recorded code-state evaluation, `ui` included, PASS on the fingerprint
```

`eval-ui` runs in the evaluate stage with the other code-state evaluators, on every
tier, because the trigger is the diff, not the tier. On a `trivial` run with a UI
trigger it still runs: a one-line CSS change is exactly the change no test catches.

## 4. Trigger (deterministic)

`changes` returns a new `uiTriggers` list next to `securityTriggers`, computed the
same way (paths and added lines in non-test files):

| Trigger | Signal |
| --- | --- |
| `markup` | `*.html`, `*.jsx`, `*.tsx`, `*.vue`, `*.svelte`, `*.astro`, templates (`*.hbs`, `*.ejs`, `*.erb`, `*.jinja*`) |
| `style` | `*.css`, `*.scss`, `*.sass`, `*.less`, Tailwind/theme config, design-token files |
| `native-ui` | Swift files with `: View`/`UIViewController`, `*.storyboard`, `*.xib`; Kotlin with `@Composable`; Android `res/layout`, `res/values` |
| `assets` | images, fonts and icons under the project's asset folders |
| `copy` | locale/string files (`*.strings`, `strings.xml`, `locales/**`, `i18n/**`) |

A `.tsx` file with no JSX in its added lines (a pure hook or util) does not trigger
`markup`. As with security, a match is a reason to look, not a finding.

The orchestrator spawns `eval-ui` when `uiTriggers` is not empty **or** a `ui`
evaluation was recorded earlier in the run, **and** a capture source (§5) is available.

## 5. Capture sources

The evaluator needs a rendered app. Two sources, chosen per project in the
configuration; a project may declare both.

### 5.1 Live preview (default for web)

New optional configuration block:

```json
"preview": {
  "kind": "web",
  "executable": "npm",
  "args": ["run", "dev", "--", "--port", "5173"],
  "url": "http://localhost:5173",
  "readyPath": "/",
  "timeoutMs": 60000,
  "viewports": [{ "name": "mobile", "width": 390, "height": 844 },
                { "name": "desktop", "width": 1280, "height": 800 }],
  "colorSchemes": ["light", "dark"]
}
```

- `url` must be a loopback origin (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`);
  the validator refuses anything else. This keeps the evaluator inside the
  authorization rule for project-owned loopback ports.
- `peos-run preview --run <run> start` starts the command in its own process group
  (the existing `process.mjs` supervision), waits until `url + readyPath` answers,
  records `pid`, `url` and the fingerprint in `<run>/preview.json` (ignored by Git),
  and returns the URL. `preview … stop` kills the group. `finish`, `advance --to
  release` and `stopped` stop a preview left running. Starting refuses if the port is
  already taken by a process the run did not start (an unrelated local service).
- `setup` proposes the block from the manifests (`dev`/`start`/`preview` script plus
  Vite/Next/Astro/etc. default ports) but writes it only when it can read the port
  deterministically; otherwise it lists it under `suggestedChecks` for the user.
- The evaluator drives the host's browser tools against that URL (§7).

### 5.2 Captured screenshots (headless, CI, Codex, native)

A configured check of a new kind `ui-capture`, owned by the project (Playwright,
Storybook test-runner, XCUITest/`swift-snapshot-testing`, Paparazzi, …). `record-checks`
passes `PEOS_UI_DIR=<run>/ui/` in its environment; the command writes PNGs and a
`manifest.json`:

```json
{ "shots": [{ "file": "checkout-empty-mobile-light.png", "screen": "checkout",
              "state": "empty", "viewport": "mobile", "scheme": "light" }],
  "a11y": [{ "screen": "checkout", "rule": "color-contrast", "impact": "serious",
             "target": "button.pay", "help": "…" }] }
```

`record-checks` binds the directory to the fingerprint like any check result and
rejects a manifest whose files are missing or outside `<run>/ui/`. The evaluator reads
the images with the Read tool, so it needs no browser at all. This is the only source
that leaves files behind, so it is also what `summary.md` links as screenshots.

Adding Playwright or another capture tool is a dependency change: PEOS proposes it,
never installs it.

### 5.3 None available

The orchestrator does not spawn `eval-ui`. It records `uiNotVerified` with the reason
(`no preview configured`, `browser tools unavailable in this host`, `preview failed to
start: <code>`) in the run, and `summary.md` shows it as the first line of "Not
verified" with the one-line fix (add `preview` or a `ui-capture` check). A preview that
is configured but fails to start is different: the run stops at evaluate and asks the
user, because a broken dev server is a real defect or environment problem.

## 6. Spec and plan inputs

The evaluator can only judge what the spec makes observable.

`templates/run/spec.md` gets a section, kept only when the request touches UI:

```markdown
## User interface
<!-- Screens or routes, the states each must show, and design references.
     | Screen / route | States | Viewports | Reference |
     States from: default, loading, empty, error, pending, success, disabled, destructive confirm.
     Reference: a design file path from `references.design`, a component, or "match <existing screen>". -->
```

UI acceptance criteria name the screen, the state and the observable result
("AC-3: on `/reports` with no reports, the empty state shows the 'Create report'
action on mobile and desktop"). `eval-spec` gets one rubric line: a UI criterion that
names no screen or state is not observable (blocking).

The planner adds, to each step that changes UI, the route or screen and how to reach
each state (fixture, query parameter, seeded data, feature flag). That is what lets the
evaluator reach `empty` or `error` without inventing data.

The profiler gains a "Design system" section in `project-profile.md`: component
library, token/theme files, icon set, breakpoints, and where `references.design`
points. `setup` fills `references.design` with existing design-token and Storybook
paths it detects; the user can add design exports (PNG/PDF) there.

## 7. The agent

```yaml
---
name: eval-ui
description: Independently evaluates the rendered user interface of a PEOS code change against its UI acceptance criteria and the project's design system, writing a JSON eval report. Invoked only by the PEOS orchestrator.
tools: Read, Grep, Glob, Write, <browser read/navigate/screenshot/resize/click tools>
disallowedTools: Agent, Edit, NotebookEdit, Bash
model: sonnet
---
```

Inputs from the orchestrator: spec or task path, plan path, `diffPath`, `checks.json`,
`uiTriggers`, the subject, the profile path, and either the preview URL with viewports
and schemes or `<run>/ui/manifest.json`.

Procedure:

1. From the spec's UI section and the plan, list the (screen, state, viewport, scheme)
   combinations the criteria need. Cap at 12 screenshots per round; when more are
   needed, cover every criterion once at its stated viewport and say what was skipped
   in `notAssessed`.
2. For each: reach the state the way the plan says, take a screenshot, read the
   accessibility tree of the main region, and read console errors.
3. Judge against the rubric (§8). Every finding names the screen, state, viewport and
   what is visibly wrong; a `criteria` entry is `met` only when a screenshot showed it.
4. Write the report (`evaluator: "ui"`, `pending-eval-ui.json`). `mode` is `full` when
   every listed combination was observed, otherwise `degraded`.

Tool restriction (host-enforced, not instruction-only): `state-guard` gets a second
matcher for `mcp__.*` tool calls. For `agent_type` `peos:eval-ui` it allows only
navigation to the run's `preview.json` origin, and denies typing into password or
payment fields, file uploads, downloads and any other origin. Other PEOS evaluators get
no MCP tool at all. The exact tool names differ per host (Claude desktop browser pane,
Claude in Chrome, a Playwright MCP); the guard matches on the URL argument, not the
tool name.

Clicking and typing in the local app may change local development data. That is
covered by the authorization rule for browser checks of the project's own app; the
plan's state-reaching instructions should prefer fixtures and query parameters over
data entry.

## 8. Rubric (`rules/eval-ui.md`)

Blocking (`high`):

- A UI criterion not visible in the stated screen, state or viewport.
- A required state from the spec's UI table missing or showing raw errors, `undefined`,
  placeholder text, or an endless spinner.
- Broken layout at a configured viewport: horizontal page scroll, clipped or
  overlapping text or controls, a primary action off-screen.
- An interactive element with no accessible name, or not reachable by keyboard (web)
  where the criterion involves it.
- Text unreadable in a configured color scheme (for example dark text on a dark
  surface) on content the change introduced.
- A new console error on load or on the criterion's interaction.
- A serious or critical `a11y` entry from a `ui-capture` manifest on a changed screen.

Medium: a component or value that bypasses the project's design system where the
profile names one (a new hard-coded color, spacing or font next to existing tokens; a
hand-built control where the library has one), inconsistency with the referenced
screen, missing focus indication.

Low: spacing and alignment nits, copy suggestions.

Not findings: taste, a redesign the spec did not ask for, states the spec does not
list, anything on screens the diff does not touch (unless the change broke them).
The shared rules of `rules/evaluation.md` apply: >80% confidence, no concrete case
(screen + state + viewport), no finding.

## 9. Files, state and release

- `eval-report.schema.json` and `eval-report.mjs`: `evaluator` gains `ui`; state key
  `ui`. `state-guard` already lets `peos:eval-ui` write only `pending-eval-ui.json`.
- Orchestrator: `peos:eval-ui` joins the spawn list; section 6 spawns it next to
  `eval-code` and passes the preview URL or manifest.
- `engineering.config.schema.json`: optional `preview`; check `kind` gains `ui-capture`.
- Run directory: `preview.json` (ignored), `ui/` (ignored except when the user commits
  screenshots with the summary).
- `advance --to release` already requires every recorded code-state evaluation to PASS
  on the fingerprint; `ui` is included because its subject is `fp:`. `uiNotVerified`
  does not block release, but `summary.md` must show it.
- `summary.md` gets a "User interface" block: screens and states observed, viewports,
  links to `ui/*.png` when captured, and the not-verified line otherwise.
- Loop control is unchanged: three rounds per key, plateau stop, `/peos:retry ui`.

## 10. Cost

- Screenshots are the main cost; 12 per round at the default two viewports keeps a
  round near the size of a `code-all` evaluation. Later rounds re-observe only the
  combinations behind earlier findings plus one smoke shot per changed screen.
- Sonnet by default; the open question below decides whether `large` uses Opus.
- `usage-record` attributes the agent like any other, so the cost shows in
  `peos-run status` and the reference measurements (increment 8).

## 11. Host assumptions to verify

| # | Assumption | Consequence if false |
| --- | --- | --- |
| U1 | A plugin agent can use MCP tools named in its `tools` frontmatter, and unknown names are ignored rather than failing the spawn | List no MCP tools; rely on inheritance plus the `mcp__.*` guard |
| U2 | PreToolUse hooks fire for MCP tool calls inside subagents with `agent_type` set | Without it, live preview is instruction-level only; prefer `ui-capture` |
| U3 | Browser screenshot tools return the image to the calling subagent, not only to the user's pane | Without it, only `ui-capture` works |
| U4 | The Read tool returns PNGs as images to a subagent | Without it, `ui-capture` needs a text-only manifest (a11y only) |

U1–U4 are tested on the fixture before any script work starts.

## 12. Increments

| Step | Content | Done when |
| --- | --- | --- |
| a | Host assumption tests U1–U4 | each recorded as confirmed or false in §11 |
| b | `uiTriggers` in `changes`; spec UI section; `eval-spec` line; profile "Design system" | trigger tests with negatives (hooks-only `.tsx`, test files); seeded spec without states FAILs |
| c | `ui-capture` kind, `PEOS_UI_DIR`, manifest validation; `eval-ui` agent and rubric; summary block | a seeded fixture with a broken empty state and a mobile overflow FAILs in round 1 and PASSes after the fix |
| d | `preview` config, `peos-run preview start/stop`, `mcp__.*` guard | the same fixture through live preview; guard denies a non-preview origin |
| e | iOS simulator and Android emulator previews (`kind: ios-simulator`, `android-emulator`) | with the platform profiles of increment 7 |

## 13. Open questions

- Should `large` runs use Opus for `eval-ui`?
- Should a `standard` run with UI criteria and no capture source stop and ask,
  instead of finishing with `uiNotVerified`?
- Should accepted screenshots become a baseline for later runs, or stay per run?

## 14. As implemented (increment 7e)

- The spec's "User interface" section, the `eval-spec` rule and the profile's "Design
  system" came with the design gate ([design-gate.md](design-gate.md)); `eval-ui` also
  judges against `design.md` when the run has one.
- `changes` and `delta` return `uiTriggers`. `next` adds the `ui` evaluation when the
  change has a trigger (or a `ui` evaluation or base exists) and a source is available:
  a `ui-capture` manifest recorded on the current checks, otherwise a configured
  `preview`. A UI evaluation recorded earlier without a source now stops the run.
- A `ui-capture` check gets `PEOS_UI_DIR` only through `record-checks` (`verify
  --ui-dir`), which empties `<run>/ui/` first and validates the manifest afterwards:
  image files directly inside the directory, at most 60 shots, `a11y` impacts from
  axe's scale. A passing capture with an invalid manifest is recorded as FAIL.
- The preview is driven by `peos-run preview-start` and `preview-stop` (`do: run` from
  `next` before `eval-ui` is spawned); `advance` to `release`, `done` or `stopped` stops
  it. `setup` does not propose a `preview` block yet; the user adds it.
- `uiNotVerified` is not stored in state: the summary action computes it from the
  configuration and `checks.json` and passes it as `sources.ui`.
- `peos:eval-ui` has no `tools` list (assumption U1 is not verified): it inherits the
  host's tools, with editing, shell and web tools denied by name. state-guard checks
  every `mcp__` call: other PEOS agents get none (the implementer keeps them). `eval-ui`
  gets only isolated browsers (`browser` or `playwright` in the server name; never
  Claude in Chrome, which acts in the user's signed-in tabs), only an allow-list of
  tools that look, navigate or click (also inside a batch; no typing), and every URL
  argument on the host and port of a preview an active run started and still runs.
- The preview's process group is what counts: a launcher that starts the server and
  exits is fine while its group lives, and a group whose leader has another start time
  than recorded (a reused ID) is never signalled.
- Still open: U1–U3 on a real host, a model run on the seeded fixture (§12 c, d), and
  §12 e (simulator and emulator previews; iOS and Android use `ui-capture` meanwhile).
