# Architecture: <Title>

## Platforms and profile
<!-- web | ios | android | desktop | backend, and the peos profile used. -->

## Technology choices
<!-- Choice — reason — alternatives considered. Each durable choice also gets docs/decisions/NNN-<slug>.md. -->

## Components
<!-- Responsibilities; public contracts between components. -->

## Structure
<!-- The directory tree down to the level where a new file's place is unambiguous, one
     line per folder: what belongs there and what does not. In an existing project, only
     the folders this change adds or touches, following the profile's Structure. -->

## Boundaries
<!-- Which layer or module may depend on which, as a list of allowed directions
     (`ui -> domain -> data`; `domain` imports nothing from `ui`), and how each rule is
     enforced: by the compiler (packages, targets, crates, `internal/`) or by a lint rule
     the root `lint` command runs (name the rule and its config file). A rule nothing
     enforces is written as "not enforced: <why>". -->

## Quality gates
<!-- The root commands the walking skeleton declares, each a configured check from the
     first milestone on: test, lint (with the boundary rules), typecheck where the
     language has one, format check, build. With a user interface, also how the built
     screens are shown to the UI evaluator: on the web a `dev` script that pins its port
     (`--port 5173` and the tool's strict-port flag), which PEOS starts as the preview;
     on other platforms a `ui:capture` command (a UI test that writes screenshots and
     `manifest.json` into `$PEOS_UI_DIR`). Existing project: what already exists. -->

## Data model
<!-- Entities, ownership, persistence, migrations. -->

## External services and dependencies
<!-- Each new dependency or service requires approval at the architecture gate. -->

## Security and privacy
<!-- Authentication, authorization, data ownership, secrets handling. -->

## Risks
-
