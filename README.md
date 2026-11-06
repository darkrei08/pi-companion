# pi-companion

A second, read-only chat on the same project: the tutor you talk to while another agent does the work.

## The problem it solves

When an AI agent writes most of your code, the chat driving the project becomes the scarcest resource you have. Every question that only serves *your* understanding, like "how is this feature implemented" or "why was it done this way", spends context that the next implementation step needs. So you stop asking, and your mental model of your own software quietly rots. You notice at 3am, when nothing works and you no longer know which component to suspect.

`/companion` keeps a separate conversation open on the same project for exactly that purpose. It reads the code, it cannot change anything, and its context is its own.

This is the trick Salvatore Sanfilippo describes in [Un trucco per evitare di non capirci più nulla](https://youtu.be/r7KH74DtMnM) (2026-10-31, Italian), plus the parts the 172 comments under it argued for: a persistent transcript instead of a fork, and a model you choose instead of the most expensive one.

## Install

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

## Commands

| Command | What it does |
|---|---|
| `/companion <question>` | Ask the tutor and post its answer into the transcript |
| `/companion status` | Model, effort, which source it came from, transcript path, entries, bytes, project key |
| `/companion model <alias\|provider/model[:effort]>` | Validate a model and pin it for this project |
| `/companion reset` | Archive the current transcript and start clean |

## What it deliberately does not do

- **No writing.** The session is created with `read`, `grep`, `find`, `ls`. There is no `edit`, no `write`, no shell, and no argument that adds one.
- **No fork of your working chat.** A fork drags the whole implementation context along, which is exactly the cost this tool exists to avoid. The companion has its own transcript per project.
- **No streaming overlay.** It shows a working indicator, then posts the answer as a message, which is why it behaves the same in `pi -p`.

## Where it keeps state

```
~/.pi/agent/companion/<project-key>/
├── session.jsonl   # the tutor transcript, one per project root
└── meta.json       # the model pinned for this project
```

`<project-key>` is the first 16 hex characters of the SHA-256 of the resolved project root, so two clones of the same repo do not share a tutor.

## Verification

```sh
node --test tests/*.test.mjs   # 17 tests, no network, no Pi runtime
npm run typecheck              # needs typescript, declared as a devDependency
```

Live check against a real model:

```sh
pi -e ./extensions/companion.ts -p "/companion status"
```

Design notes and the decisions behind them live in [`odd/tasks/companion-chat.md`](odd/tasks/companion-chat.md).

## License

MIT
