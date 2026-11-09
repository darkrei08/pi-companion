# pi-companion

A second, read-only chat on the same project: the tutor you talk to while another agent does the work.

## The problem it solves

When an AI agent writes most of your code, the chat driving the project becomes the scarcest resource you have. Every question that only serves *your* understanding, like "how is this feature implemented" or "why was it done this way", spends context that the next implementation step needs. So you stop asking, and your mental model of your own software quietly rots. You notice at 3am, when nothing works and you no longer know which component to suspect.

`/companion` keeps a separate conversation open on the same project for exactly that purpose. It reads the code, it cannot change anything, and its context is its own.

This is the trick Salvatore Sanfilippo describes in [Un trucco per evitare di non capirci più nulla](https://youtu.be/r7KH74DtMnM) (2026-10-31, Italian), plus the parts the 172 comments under it argued for: a persistent transcript instead of a fork, and a model you choose instead of the most expensive one.

## Install

```sh
pi install npm:pi-companion
```

Or straight from the repository:

```sh
pi install git:github.com/darkrei08/pi-companion
```

Or try it without installing:

```sh
pi -e ./extensions/companion.ts
```

## Wire it to your roles and model aliases

The tutor contract is a role file, `roles/companion.md`, not a string buried in TypeScript. Make it visible to the rest of your harness:

```sh
ln -sfn "$PWD/roles/companion.md" ~/.pi/agent/pi-ext-roles/roles/companion.md
```

Its frontmatter declares `model: companion-model`, an alias, so the model is chosen once and inherited everywhere:

```json
// ~/.pi/agent/pi-ext-roles/settings.json and ~/.pi/agent/pi-extensible-workflows/settings.json
{ "modelAliases": { "companion-model": "cliproxyapi/gemini-3.8-flash-high:medium" } }
```

Explaining code that already exists is easier than writing it, so this chat is where a cheap model belongs. Effort travels on the model string, exactly as it does for every other role here.

Resolution order, first hit wins:

1. the model this project last set with `/companion model`
2. `~/.pi/agent/companion/settings.json`, `{"model": "..."}`, as a global default
3. the `model:` line of `roles/companion.md`
4. `cliproxyapi/gemini-3.8-flash-high:medium`

Automatic pane opening is off by default. Run `/companion auto on` or set
`~/.pi/agent/companion/settings.json` to `{"autoOpen": true}` to opt in; `/companion auto off`
disables it again. Auto-open runs only for interactive TUI sessions inside Herdr, never for
RPC, print, JSON, delegated child, workflow child, or companion sessions.

`/companion open` is idempotent: it reuses a live matching pane instead of opening a
second one. `/companion close` records an intentional close, so opt-in auto-open does not
immediately recreate it. A later explicit `/companion open` can open it again.

## Commands

| Command | What it does |
|---|---|
| `/companion <question>` | Ask the tutor and post its answer into the transcript |
| `/companion open` | Open or reuse the persistent tutor pane |
| `/companion new` | Open a temporary tutor with a fresh transcript; close the active tutor first |
| `/companion close` | Close the active tutor pane without deleting its transcript |
| `/companion snapshot` | Show a bounded snapshot of the current host session for follow-up |
| `/companion status` | Model, lifecycle, pane, transcript path, entries, bytes, project key |
| `/companion model <alias\|provider/model[:effort]>` | Validate a model and pin it for this project |
| `/companion send <prompt>` | Ask the companion to dispatch a confirmed directive to its caller pane |
| `/companion reset` | Archive the current transcript and start clean; close the active tutor first |
| `/companion auto on\|off` | Enable or disable automatic companion pane opening |

### `/companion open`

```sh
/companion open
```

Inside Herdr this splits the calling pane, keeps focus where it is, and starts a full interactive Pi session in the new pane. It is a sibling chat, not a sub-process: same working directory, an explicit `--session` path, `--name companion`, the read-only tools plus `host_snapshot` and `dispatch_directive`, the tutor contract as the appended system prompt, and the model and effort `/companion status` reports. The split follows the pane shape: a wide pane splits right, a tall one splits down. Auto-open is opt-in; when enabled, the `session_start` handler uses the same idempotent path. The launcher sets `PI_COMPANION_SESSION=1` so the companion cannot recursively open another pane.

Outside Herdr, or with no `herdr` binary on `PATH`, it prints the exact launcher command to run by hand plus one line saying why the pane was not opened. `/companion status` reports whether pane mode is available here.

`/companion new` uses a separate `session-temporary-*.jsonl` transcript and refuses to create another pane while one is active. `/companion close` closes only the recorded companion pane and preserves its transcript.

The companion pane also carries a usage band below the editor, right-aligned, showing the tutor state, the resolved model, the context tokens against the window with its percent, and the transcript entry count (`tutor idle | cliproxyapi/gemini-3.8-flash-high:medium | 12.3k/200k (6%) ctx | 7 entries`). It renders in a companion session only, because `ctx.getContextUsage()` reports the calling session's tokens.

When the companion was launched from a caller pane, it also exposes `dispatch_directive` to the model. After the operator confirms the target, the tool collapses the directive to one line and types it into the caller's prompt with `herdr pane run`; it rejects control characters and directives longer than 1,000 characters.

The pane companion does not expose MCP discovery or arbitrary script execution. This keeps the read-only boundary enforceable instead of relying on the model to avoid write-capable tools. The companion can still inspect the repository through `read`, `grep`, `find`, `ls`, and the bounded `host_snapshot` tool.

`/companion snapshot` is deliberately bounded and on demand. The host does not write snapshot state on every turn. The explicit command creates a versioned resume capsule with the host session id, project, phase, model, entry count, latest bounded user and assistant messages, recent tool names, freshness, and provenance. Credential-shaped values are redacted before normalization; the capsule does not dump environment variables, credentials, or unrestricted terminal history. The pane companion can request the same cached capsule through its read-only `host_snapshot` tool.

## Which chat for which prompt

The working chat and the companion are not interchangeable. The rule is what the answer should end with.

| If the answer should end with | Ask |
|---|---|
| a diff, a commit, a command run | the working chat, which has `edit`, `write` and a shell |
| your understanding of how something works | the companion |
| a bounded investigation across many files, with evidence | the companion, in deep shape |
| a compressed view of a change before you review it | the companion, in summarise shape |

Typical companion questions: how is this feature implemented, why was it done this way, where is the limit of this approach, what would break if I changed it, if this fails at 3am where do I look, which assumptions here are verified and which are guesses.

Typical working-chat prompts: implement, fix, refactor, run the tests, commit.

The companion cannot write, and that is not a limitation to route around: when its answer implies a change, it says what the change is and the human carries that sentence to the working chat.

## What it deliberately does not do

- **No writing.** The session is created with `read`, `grep`, `find`, `ls`. There is no `edit`, no `write`, no shell, and no argument that adds one.
- **No fork of your working chat.** A fork drags the whole implementation context along, which is exactly the cost this tool exists to avoid. The companion has its own transcript per project.
- **No streaming overlay.** It shows a working indicator, then posts the answer as a message, which is why it behaves the same in `pi -p`.

## Where it keeps state

```
~/.pi/agent/companion/<project-key>/
├── session.jsonl   # the tutor transcript, one per project root
├── meta.json       # the model pinned for this project
├── launcher.sh     # reusable pane launcher, including the recursion guard
├── open.json       # active or intentionally closed companion lifecycle record
├── open.lock       # short-lived atomic pane-open claim
└── host-snapshot.json # bounded snapshot exposed to the companion
```

`<project-key>` is the first 16 hex characters of the SHA-256 of the resolved project root, so two clones of the same repo do not share a tutor.

## Verification

```sh
node --test tests/*.test.mjs   # lifecycle, snapshot, decision matrix, and pane helpers
npm run typecheck              # needs typescript, declared as a devDependency
npm pack --dry-run             # verify the published file set
```

Live check against a real model:

```sh
pi -e ./extensions/companion.ts -p "/companion status"
```

Design notes and the decisions behind them live in [`odd/tasks/companion-chat.md`](odd/tasks/companion-chat.md).

## License

MIT
