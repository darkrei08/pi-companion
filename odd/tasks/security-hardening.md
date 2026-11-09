# security-hardening

Apply the Strix security recommendations to pi-companion, verify the result, and deliver a GitHub release without exposing credentials.

## Specs

S1. The user request is: "Applica le evidenze del reort dinsicurezza e poi comkit puab github e rilascio  ed eseui prina tuttini north test del caso usa workflow".

S2. From the Strix report: "Restrict `reason` length (e.g., maximum 300 characters), collapse whitespace, and filter out ANSI escape sequences and non-printable control characters before rendering in terminal dialogs."

S3. From the Strix report: "In `boundedSnapshotText`, expand regular expression patterns to match `Basic` authentication credentials (`Authorization: Basic <token>`), AWS Access Key identifiers (`AKIA[0-9A-Z]{16}`), and arbitrary URI scheme credentials (such as `redis://` or `amqp://`) to provide comprehensive defense-in-depth sanitization of host chat transcripts."

S4. From the Strix report: "Expand `normalizeDirective` validation from ASCII C0 control characters to also reject C1 control codes (`\\u0080-\\u009F`) and Unicode Bidirectional Override characters (such as `\\u202E`) to maintain visual integrity across internationalized terminal environments."

S5. Preserve the existing explicit confirmation gate, read-only companion boundary, snapshot bounds, and public package compatibility. Do not add credentials or generated audit state to the release commit.

S6. Verify with focused regression tests, the complete repository test/typecheck/packaging matrix, applicable container rows, and a fresh Strix scan through the local CLIProxyAPI gateway before delivery.

## Tasks

| ID | What | Route | Spec | Commit |
|---|---|---|---|---|
| T1 | Record the security-hardening scope and acceptance gates | inline | S1-S6 | pending |
| T2 | Add reason normalization and Unicode control rejection with tests | workflow writer | S2 S4 | pending |
| T3 | Expand snapshot credential redaction with tests | workflow writer | S3 | pending |
| T4 | Run focused and full verification, packaging, and container checks | workflow verifier | S5-S6 | pending |
| T5 | Run fresh Strix through CLIProxyAPI and inspect findings | workflow security | S6 | pending |
| T6 | Commit the work unit, push the authorized branch, and create the GitHub release | inline delivery | S1 S5-S6 | pending |

## Log

L1. Operator request (verbatim): "Applica le evidenze del reort dinsicurezza e poi comkit puab github e rilascio  ed eseui prina tuttini north test del caso usa workflow".

L2. Strix 1.7.0 baseline report `strix_runs/pi-companion_9bb6/penetration_test_report.md` reported zero exploitable vulnerabilities and four defense-in-depth recommendations: normalize directive reasons, broaden snapshot redaction, reject C1/bidirectional controls, and add dependency auditing.

L3. Delivery note: the repository has no lockfile, so `npm audit` remains a separately blocked decision and is not silently solved by this feature.
