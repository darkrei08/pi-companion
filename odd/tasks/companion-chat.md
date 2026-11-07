# companion-chat

A Pi extension that gives a second, read-only chat on the same project: the tutor you talk to while another agent does the work. It exists because the chat driving the project must not spend its context on the operator's comprehension.

Built from antirez's video "Un trucco per evitare di non capirci più nulla" (2026-10-31) and the 172 comments under it, then adapted to this host: Pi extensions, pi-ext-roles, model aliases over CLIProxyAPI.

## Specs

S1. A second chat on the same project, opened while the project keeps moving, with the contract stated by the video: "Sei in questo progetto, qui tu non devi scrivere e toccare niente, c'è un'altra gente [agente] che sta lavorando a questo progetto ma questa chat serve a me per approfondire dei dettagli architetturali del progetto". Read-only by construction: no edit, no write, no bash tool at all.

S2. The companion's answers serve building a mental model in the human, in the operator's own words: "le tue risposte non devono essere mai jargon, devono essere utili a creare un modello mentale nell'essere umano che ti chiede queste cose. Se pensi che una cosa è un dettaglio molto specialistico, metti un trafiletto in cui spieghi, non ti perdere invece negli inutili dettagli di comprensione" and "io conosco molto bene questo, questo, questo e questo, per cui non mi devi stare a spiegare magari i dettagli su questo, se non te lo chiedo esplicitamente".

S3. Because it only explains code that already exists, it runs on a cheaper model than the working chat: "Possiamo usare per questa chat anche un modello che è molto più economico". The model and its thinking effort are configured, not hardcoded, and resolve through the same alias mechanism this host already uses for roles.

S4. The companion keeps its own history across questions, separate from the main session. A fork of the main chat is explicitly rejected by the video's author because "Col fork vi portate appresso tutto il contesto, diventa costoso nell'utilizzo del piano". So: one persistent tutor transcript per project, keyed by project root, never merged into the working conversation.

S5. It also knows it is looking at a moving target: another agent edits the same project, so when a file does not match what the conversation assumed, it re-reads instead of contradicting itself.

S6. It works in an interactive session and also in `pi -p` print mode, where `ctx.hasUI` is false and no overlay or select is available, so the answer must reach the transcript as a message rather than only through a custom TUI component.

S7. A public repository of its own, installable with `pi install git:github.com/<owner>/pi-companion`, following the Pi package conventions: `pi` field in package.json, `pi-package` keyword, and every `@earendil-works/*` module plus `typebox` in `peerDependencies`, never in `dependencies`.

S8. The tutor contract is a role file the operator can read and edit, not a string buried in TypeScript, so the same contract can be reused by pi-ext-roles and by pi-extensible-workflows.

S9. Cheap by default and never silent about cost drift: the current model, effort and transcript size are inspectable with one command, and the model can be changed per project without editing JSON by hand.

S10. `/companion open` starts the same tutor as a real interactive Pi session in a pane beside the calling one: same working directory, read-only through `--tools read,grep,find,ls`, plus the gated `dispatch_directive` tool, the role body as the appended system prompt, the same resolved model and effort, its own persisted session file. Focus stays in the calling pane. Without Herdr, or without the `herdr` binary, it prints the exact command to run by hand and one line saying why.

S11. Pane mode must not be limited by the length of a shell command. The role body travels as a launcher script written into the project's companion state directory, not as an inline argument, because the inline form is near the canonical shell command limit on macOS even though it works on Linux. The launcher is removed when the pane closes or reused in place, never left as a growing pile of scripts.

S12. A new interactive session must not start without a companion beside it: "soprattutto quando si avvia una nuova sessione agents allora ci deve essere sempre a fianco una sessione companion quindi questa è una direttiva da implementare". Auto-open is therefore the default when the session is interactive and inside Herdr, and it must be defensible: the companion session it launches must never open a companion of its own, a headless or non-interactive run must never split a pane, and one setting turns it off.

S13. The interface and the feature set improve from evidence, not from taste: "prova anche online a ricercare con la mia suite data search se esiste qualcosa per migliorare il companion sia graficamente che con interfaccia e sia in funzionalità". Findings are ranked by what Pi can actually support today, with the source for each.

S14. The dispatch bridge is gated: "a gated dispatch bridge, so a companion pane can hand the caller pane a directive instead of the operator copy-pasting it." The companion may request work, but it never receives write or shell tools.

S15. The bridge carries the caller pane id through the generated launcher: `HERDR_PANE_ID` becomes `PI_COMPANION_CALLER_PANE`, and the dispatch path uses `herdr pane run <PANE_ID> <TEXT>` so the directive is submitted once.

S16. `dispatch_directive({ prompt, reason })` is registered only for a companion session with a known caller pane. Before sending, the extension shows the collapsed directive and reason through `ctx.ui.confirm`; declining sends nothing and returns a failed tool result.

S17. Dispatch input collapses whitespace and newlines to single spaces, trims the result, rejects empty text and control characters, and caps the directive at 1,000 characters. The normalized payload is passed to `herdr` through an argv array, never a shell string.

S18. `/companion send <text>` reuses the same validation, confirmation, and `herdr pane run` path as `dispatch_directive`. The README and companion role describe the one-line rule, human gate, and operator-controlled handoff.

S19. The tutor must be able to consult what the MCP servers know, not only the files: "senza codemode né tool_search gli MCP server (codegraph, context7, engram, browseros, firecrawl) sono irraggiungibili". The pane therefore carries `tool_search` beside the read-only tools, which silences the unreachable-MCP warning without granting arbitrary script execution; `codemode` stays out, and the role tells the tutor that a search may surface MCP tools which write and that those stay out of contract.

S20. A workflow worker pane must never open a companion of its own. `@piewf/herdr` launches every worker as a full interactive TUI session (`@piewf/herdr/dist/index.js:289` prefixes the environment onto the command it runs) and marks it only through `PI_EXTENSIBLE_WORKFLOWS_HERDR_OWNER=1`, never through `GENTLE_PI_AGENTS_CHILD`, so the delegated-child check alone misses it and the worker's `autoOpenDecision` came back eligible. Auto-open therefore stands down for that marker too, which the README already promised.

S21. The companion pane carries its own one-line footer badge, published through `ctx.ui.setStatus("companion", ...)` so the built-in footer is never replaced: `tutor <idle|working> | <provider>/<model>:<effort> | <tokens> ctx | <n> entries`, in `dim` when idle and `accent` while a turn runs, refreshed on `session_start`, `turn_start` and `turn_end`. It exceeds 80 columns only when the pane allows it: the string is cut to the budget in code points with a trailing `...`. It appears in a companion session only, because `ctx.getContextUsage()` reports the calling session's tokens and a badge in the operator's pane would show someone else's number. Superseded by S22.

S22. The usage line lives in a widget band below the editor, not in the footer badge: Pi 1.5.0 has only `aboveEditor` and `belowEditor` placements, so a right-aligned band is the reachable approximation of the operator's columns. The band is registered as `ctx.ui.setWidget("companion-usage", factory, { placement: "belowEditor" })` and renders the single line S21 describes, extended with the context window and its percent (`<tokens>/<window> (<percent>%) ctx`, tokens-only when the percent is unknown), right-aligned by padding to the rendered width, in `dim` when idle and `accent` while a turn runs. Below 40 columns the model segment is dropped rather than overflowing. The `setStatus` publishing path is gone: one pane shows those numbers once. It still appears in a companion session only.

## Tasks

| ID | What | Route | Spec | Commit |
|---|---|---|---|---|
| T1 | Repo skeleton, package manifest, role file with the tutor contract, LICENSE, README | inline | S7 S8 | f5de4a8 |
| T2 | Extension: `/companion <question>` on a persistent read-only session, project-keyed history | builder | S1 S4 S6 | f5de4a8 |
| T3 | Model and effort resolution through alias + role, `/companion status` and `/companion model` | builder | S3 S9 | f5de4a8 |
| T4 | `pi -e` smoke and unit tests for the pure parts | builder | S6 | f5de4a8 |
| T5 | Publish: public GitHub repo, install instructions, verification transcript | inline | S7 | github.com/darkrei08/pi-companion |
| T6 | `/companion open`: Herdr split plus interactive read-only Pi session from the same role and model resolution | builder | S10 | 5c74b99 |
| T7 | Publish to npm, install from the registry, PRs to pi-companion and pi-ext-roles | inline | S7 | pi-companion@0.1.0 |
| T8 | Launcher script instead of an inline prompt body, so pane mode is not length-limited on macOS | builder | S11 | this branch |
| T9 | Auto-open a companion pane when an interactive session starts, with no recursion and an off switch | builder | S12 | this branch |
| T10 | Online research on how other tools present a side chat, and what is worth adopting | researcher | S13 | this branch |
| T11 | Gated caller-pane dispatch through the launcher, tool, and `/companion send` | builder | S14-S18 | this branch |
| T12 | Reach the MCP servers from the companion through `tool_search`, with `codemode` still off | inline | S19 | this branch |
| T13 | Stand down auto-open for workflow worker panes through the `@piewf/herdr` environment marker | inline | S20 | this branch |
| T14 | Footer badge for the companion pane: tutor state, model, context tokens, transcript size | developer | S21 | this branch |
| T15 | Specialist-sidebar answer rule so hyper-specialistic detail leaves the main pass | developer | S2 | this branch |
| T16 | Right-aligned usage band below the editor, replacing the footer badge | developer | S22 | this branch |

## Research: what to steal from the field (S13)

Ranked by value against what Pi can support today. Sources as reported by the researcher; the two most load-bearing ones were re-checked, the rest were not.

1. **Asymmetric model routing with the working chat's context.** The best explanation engine here is not a second cold agent but a cheap model answering against a pruned view of the working conversation. Pi already exposes the branch and a non-agent completion path.
2. **A real pane, never a modal overlay.** Confirmed by prior art: Claude Code's side questions are an ephemeral overlay, `pi-better-btw-plus` puts a side chat in `ctx.ui.custom`, and both hide the streaming work underneath. The pane is the only presentation that lets you read while the agent writes.
3. **Diff and symbol anchoring.** Grounding a question in `git diff` or in the symbol under the cursor removes the copy-paste step that makes people stop asking.
4. **Promotion hatch.** One keystroke that turns an explanation into a directive in the working chat's editor is the cheapest way to close the loop the video cares about.
5. **Read-only enforcement by construction.** Already done here through the tool allowlist; the field agrees that giving a side chat write access to the same worktree is the failure mode to avoid.

Recorded as future work, not implemented: items 1, 3 and 4 need their own spec, and item 1 changes the cost model enough to deserve a measurement first.

## Log

L1. Operator request (verbatim): "benissimo allora procedi a crea una estensione di pi agent ceh faccia quetso con tutti i usgegriemtnio che hai trovato col video e ceh sia una mia repo personale e ceh sia pubblicata e che segua poi al lgoca di piworjlfow extensibvle e dei ruolia sseganti e del modello e fffort aseganto (quindi sencodo e cucinto col jio paino cli proxyapi e le mie sottoscrizioni)"

L2. Video findings that shaped the specs: the second chat must be read-only (S1); the answer style contract is the point, not an afterthought (S2); a cheaper model is legitimate because explaining existing code is easier than writing it (S3); a fork is rejected because it drags the whole context (S4); the companion drives a skill file so the contract is repeatable (S8).

L3. Comment findings that shaped the specs: the strongest objection in the thread is that a side chat "lacks the decision context of the main one" and only works if the operator is present in real time (@ttlcrl). Persistence across questions (S4) is the mitigation available here: the companion accumulates its own decision narrative instead of starting cold. The counter-position, that the companion deserves the strongest model (@alessiomarchionni), is why the model is configurable (S3, S9) rather than fixed to the cheapest.

L4. Harness constraints discovered by reconnaissance: extensions can create an isolated in-process agent session (`createAgentSession` + `SessionManager.open/inMemory`) with an explicit read-only tool allowlist and a `thinkingLevel`; in `pi -p` there is no UI, so output must be a session message; roles put effort on the model string (`provider/model:effort`) and forbid a separate `thinking:` field; model aliases live in a `modelAliases` map in the pi-ext-roles and pi-extensible-workflows settings files.

L5. Pane mode design notes: `herdr pane split --current --direction <right|down> --cwd <root> --no-focus` returns the new pane as `.result.pane.pane_id`; `herdr pane run <pane> <command>` queues text and Enter, so the role body is shell-quoted into one argument. `pi --append-system-prompt` takes inline text or a path and reads the file when the argument exists, so the body is passed inline to keep the role frontmatter out of the prompt. A wide pane splits right, anything else down, which keeps both panes usable.

L6. Distribution facts: the npm package is `pi-companion@0.1.0`, installed with `pi install npm:pi-companion` (verified in an isolated agent dir); the git source stays available for unreleased branches. The local supply-chain policy blocks mutating `npm` commands, so publishing goes through `pnpm publish --access public`. Two PRs are open: darkrei08/pi-companion#1 (pane mode) and darkrei08/pi-ext-roles#1 (the role in the starter set). The role now exists twice on purpose: the packaged copy drives the extension, and the pi-ext-roles copy makes it dispatchable by workflows and subagents.

L7. Operator request (verbatim): "E esegui il push del pull request rispetto ai commit che abbiamo emergiato nei nostri fork e che sono appunto poi correttamente installati e funzionanti su questo host, dopodiché, procedi a sviluppare e a correggere i fix che hai individuato, ad esempio, per Mac OS o per Linux, e dopodiché, prova anche online a ricercare con la mia suite data search se esiste qualcosa per migliorare il companion sia graficamente che con interfaccia e sia in funzionalità e soprattutto quando si avvia una nuova sessione agents allora ci deve essere sempre a fianco una sessione companion quindi questa è una direttiva da implementare esegui lo sviluppo di queste ultime delle ricerche attraverso Workflow Extensible."

L8. Both earlier PRs are merged on main (pi-companion#1 squash-merged as 1915010, pi-ext-roles#1 as 81180b1) and the host runs the npm build, so the starting point for this round is merged main, not a branch.

L9. Round two shipped on the branch that this document describes: the launcher script removes the macOS command-length limit, and `session_start` now auto-opens the companion with a marker guard against recursion, an `alreadyOpened` guard, a `ctx.hasUI` check and an `autoOpen` setting. The research in the section above comes from the operator's local data stack (Firecrawl on loopback) plus general web search.

L10. Publication note, corrected after the fact: `pnpm publish` reports success before the registry's dist-tags move, so the first reads of `npm view` showed `latest: 0.1.0` while 0.2.0 and 0.2.1 were still propagating. Both landed; `latest` is now 0.2.1 and the host installs the registry build (`pi install npm:pi-companion`), not the git checkout.

L11. Auto-open was verified live and works: a fresh interactive session in its own pane opened the companion pane eight seconds later, with its own session file and the title `π - companion - pi-companion`. An earlier reading of the same run looked like the pane had vanished; it was a pane listing taken before the companion had been created. Recorded because the wrong conclusion had already reached a debugging brief: the suspected split-before-shell-ready race was never observed, and no speculative fix was shipped for it. It remains a plausible flake worth watching if a launch ever appears to do nothing.

L12. Operator report (verbatim): "Running /reload in an interactive session triggered auto-open and printed companion opened in pane w8F:p7 / launcher: /root/.pi/agent/companion/0d3583b84dd72bb1/launcher.sh ... A second reload must not spawn another companion." Investigation on the shipped build (`npm:pi-companion` 0.2.1, whose `session_start` guard is the module flag plus a `companion_auto_opened` transcript entry) did not reproduce a second spawn: two `/reload`s in a fresh Herdr pane left exactly one companion pane, because the transcript marker lives in the running session manager and survives the module reload. What the report did catch is the other half: a session started before auto-open shipped has no marker, so its first reload does auto-open, and once the marker exists a companion closed by hand can never come back. Both depend on state that is not the truth (a module variable and a transcript entry), so the fix persists the decision instead: `open.json` in the project state directory holds `{sessionId, paneId, timestamp}`, and `shouldSkipAutoOpen` skips only when that recorded pane is still in `herdr pane list` or when a pane in this workspace already is this project's companion. The companion cannot be recognised by its command (the launcher execs pi, so `herdr pane process-info` reports `pi`); `--name companion` puts the session name in the pane title, so `isCompanionPane` matches `companion - <project basename>` exactly. A substring test was rejected: it skips every session in a directory called `pi-companion`, which is this repository. Live evidence: shipped build two reloads / one pane; fixed build two reloads / one pane, record deleted and reload / still one pane (title fallback), companion closed by hand and reload / a new pane plus a rewritten record; operator panes w8F:p1 and w8F:p7 untouched throughout. The host keeps running the registry build, so the operator sees this only after the next release.

L12. The reload spawn was not a duplicate. The operator's session had started before the extension shipped auto-open, so the reload at 07:28 was the first `session_start` that could fire: the transcript marker appears at line 813 of 819, fifteen hours into that session. The fix still stands, because the guard was made from state that was not the pane: `open.json` now records session and pane id, and a title check covers a lost record. It also removed a latent regression, an `includes("companion")` test that would have skipped every session in a directory named `pi-companion`.

L13. Answer contract, from researched style evidence rather than taste: lead with the answer, mechanism before file list, one term per concept, verbs over nominalisations, one hedge per claim with its reason, no closing summary, every behavioural claim with a path. Three shapes cover the operator's three verbs: describe (what it is, how, why, where, not covered), summarise (one line, grouped scope, before and after, must-check, dropped), deep (bounded question, answer with confidence, evidence trail, hypotheses, conflicts, stop rule). Each shape lists what disqualifies an answer in it. Sources included BLUF, the expertise-reversal effect, Chi on self-explanation, Diataxis on explanation as a distinct mode, Google and Microsoft style guides on voice and terminology, and CodeRabbit's structural summary as shipped prior art. Paywalled or abstract-only sources are marked as such in the research, so no rule rests on an unread paper.

L14. Operator request (verbatim): "Implement a feature in the repo /root/git/personale/pi-companion ... FEATURE: a gated dispatch bridge, so a companion pane can hand the caller pane a directive instead of the operator copy-pasting it." The implementation preserves the read-only companion tools, adds a confirmation gate, normalizes to one line, and caps directives at 1,000 characters.

L15. Operator request (verbatim): "Aggiungi in extensions/companion.ts la guardia per saltare l'auto-open del companion quando sono presenti marker di workflow o sottoagenti come PI_EXTENSIBLE_WORKFLOWS_HERDR_OWNER" ... "Quando un workflow esegue un task tramite @piewf/herdr, il processo secondario viene avviato in un riquadro Herdr interattivo con TUI attivo. Tale ambiente non imposta GENTLE_PI_AGENTS_CHILD, ma valorizza variabili specifiche come PI_EXTENSIBLE_WORKFLOWS_HERDR_OWNER=\"1\"" ... "Di conseguenza autoOpenDecision restituisce esito positivo e genera un riquadro companion ridondante anche per il worker del workflow." Verified in the source: the marker is prefixed onto the command run in the created pane, so the worker session carries it. The README already stated this behaviour, so the defect was documentation ahead of code.
