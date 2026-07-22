# pi config

My personal config for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent),
kept in git so it survives machine wipes — and so anyone else can lift the parts they like.

pi reads its config from `~/.pi/agent/`, so this repo *is* `~/.pi`.

## What's in here

| Path | What it does |
| --- | --- |
| `agent/settings.json` | Global pi settings. Currently just selects the theme. |
| `agent/themes/one-dark-pro.json` | One Dark Pro colour theme. |
| `agent/extensions/statusline.ts` | Two-line custom footer: model / cwd / git branch / diff stat / pi version, plus a context-window bar and token totals. |

Not tracked (see `.gitignore`): `agent/auth.json` (credentials), `agent/sessions/` (transcripts),
and `agent/skills/` (symlinks into `~/.agents/skills`, which is shared with other agents and lives elsewhere).

## Install on a new machine

```sh
git clone https://github.com/OysterD3/<repo>.git ~/.pi
```

If `~/.pi` already exists, clone elsewhere and copy `agent/themes`, `agent/extensions`,
and whatever you want out of `agent/settings.json` into your own `~/.pi/agent/`.

Extensions and themes are picked up automatically by filename — no registration step.

## Customising

- **Theme** — drop a JSON file in `agent/themes/`, then set `"theme"` in `agent/settings.json` to
  its `name`. Copy `one-dark-pro.json` as a starting point. A theme is two layers: `vars` is the raw
  palette (`blue: "#61afef"`, …) and `colors` maps semantic roles (`accent`, `error`, `success`,
  `muted`, `mdCode`, …) onto those vars. The statusline and the rest of the UI only ever reference
  roles, so retargeting a role restyles everything that uses it. The file's `$schema` points at
  pi's theme schema, so an editor will autocomplete the valid role names.
- **Statusline** — edit `agent/extensions/statusline.ts`. The two `render()` return values are
  line 1 and line 2; delete a `parts1.push(...)` to drop a segment, or change `bar(pct, cells)`
  to resize the context meter. Colours go through `theme.fg("<role>", …)`, so keep using role
  names rather than literal hex if you want it to follow the active theme.
- **Disable an extension** — remove or rename the file out of `agent/extensions/`.

`agent/settings.json` also gains machine-local keys as you use pi (e.g. `lastChangelogVersion`).
Harmless to commit, but expect churn there.
