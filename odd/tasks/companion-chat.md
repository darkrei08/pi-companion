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

## Tasks

| ID | What | Route | Spec | Commit |
|---|---|---|---|---|
| T1 | Repo skeleton, package manifest, role file with the tutor contract, LICENSE, README | inline | S7 S8 | f5de4a8 |
| T2 | Extension: `/companion <question>` on a persistent read-only session, project-keyed history | builder | S1 S4 S6 | f5de4a8 |
| T3 | Model and effort resolution through alias + role, `/companion status` and `/companion model` | builder | S3 S9 | f5de4a8 |
| T4 | `pi -e` smoke and unit tests for the pure parts | builder | S6 | f5de4a8 |
| T5 | Publish: public GitHub repo, install instructions, verification transcript | inline | S7 | github.com/darkrei08/pi-companion |

## Log

L1. Operator request (verbatim): "benissimo allora procedi a crea una estensione di pi agent ceh faccia quetso con tutti i usgegriemtnio che hai trovato col video e ceh sia una mia repo personale e ceh sia pubblicata e che segua poi al lgoca di piworjlfow extensibvle e dei ruolia sseganti e del modello e fffort aseganto (quindi sencodo e cucinto col jio paino cli proxyapi e le mie sottoscrizioni)"

L2. Video findings that shaped the specs: the second chat must be read-only (S1); the answer style contract is the point, not an afterthought (S2); a cheaper model is legitimate because explaining existing code is easier than writing it (S3); a fork is rejected because it drags the whole context (S4); the companion drives a skill file so the contract is repeatable (S8).

L3. Comment findings that shaped the specs: the strongest objection in the thread is that a side chat "lacks the decision context of the main one" and only works if the operator is present in real time (@ttlcrl). Persistence across questions (S4) is the mitigation available here: the companion accumulates its own decision narrative instead of starting cold. The counter-position, that the companion deserves the strongest model (@alessiomarchionni), is why the model is configurable (S3, S9) rather than fixed to the cheapest.

L4. Harness constraints discovered by reconnaissance: extensions can create an isolated in-process agent session (`createAgentSession` + `SessionManager.open/inMemory`) with an explicit read-only tool allowlist and a `thinkingLevel`; in `pi -p` there is no UI, so output must be a session message; roles put effort on the model string (`provider/model:effort`) and forbid a separate `thinking:` field; model aliases live in a `modelAliases` map in the pi-ext-roles and pi-extensible-workflows settings files.
