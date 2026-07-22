# pi config

My personal config for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent),
kept in git so it survives machine wipes — and so anyone else can lift the parts they like.

pi reads its config from `~/.pi/agent/`, so this repo *is* `~/.pi`.

## What's in here

| Path | What it does |
| --- | --- |
| `agent/settings.json` | Global pi settings. Currently just selects the theme. |
| `agent/themes/one-dark-pro.json` | One Dark Pro colour theme. |
| `agent/extensions/statusline/index.ts` | Custom footer. Line 1: model / cwd / git branch / diff stat / pi version. Line 2: context-window bar and token totals. Line 3: subscription limit meters, when the provider reports any. |
| `agent/extensions/statusline/usage.ts` | Helper module (not a standalone extension) that reads ChatGPT subscription limits for the `openai-codex` provider. |
| `agent/extensions/web-search.ts` | Registers a `web_search` tool backed by [Exa](https://exa.ai). Requires `EXA_API_KEY`. |

Not tracked (see `.gitignore`): `agent/auth.json` (credentials), `agent/sessions/` (transcripts),
and `agent/skills/` (symlinks into `~/.agents/skills`, which is shared with other agents and lives elsewhere).

## Install on a new machine

```sh
git clone https://github.com/OysterD3/dotpi.git ~/.pi
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
- **Statusline** — every knob lives in the `CONFIG` block at the top of
  `agent/extensions/statusline/index.ts`: bar width, whether to show the limit meters, reset
  formatting (`"clock"` → `resets 04:51 Wed`, `"relative"` → `2d 6h left`), the warn/error
  thresholds, and per-segment colours. Each colour is either one of pi's semantic theme roles
  (follows the active theme) or a `#rrggbb` literal (pinned, ignores the theme). Roles are
  typed against pi's own `ThemeColor` union, so a typo is a compile error rather than a silent
  mis-render.
- **Limit meters** — shown only when the provider actually reports limit windows, and each is
  labelled from the duration the API returns rather than from its position in the response.
  A ChatGPT/Codex account reports a single weekly window, so you get `Weekly:` and nothing else.
  Set `CONFIG.showLimits` to `false` to drop the line entirely.
- **Web search** — needs an Exa key. Get one at <https://dashboard.exa.ai/api-keys> and put
  `export EXA_API_KEY="..."` in your shell profile; the extension reads it from the environment
  and nowhere else. **Do not put it in `settings.json`** — that file is committed to this public
  repo. Tunables (result count, snippet length, search mode, timeout) live in the `CONFIG` block
  at the top of `agent/extensions/web-search.ts`. Note that Exa bills per search, and `CONFIG.searchType`
  values `deep`/`deep-reasoning` cost substantially more than the default `auto`.
- **Multi-file extensions** — note the subdirectory. pi auto-loads *every* top-level
  `extensions/*.ts` as its own extension, so a helper module sitting next to an extension would
  be loaded as one and fail. Inside a directory only `index.ts` is loaded; siblings are plain
  modules. Import them with an explicit `.ts` extension.
- **Disable an extension** — remove or rename the file out of `agent/extensions/`.

`agent/settings.json` also gains machine-local keys as you use pi (e.g. `lastChangelogVersion`).
Harmless to commit, but expect churn there.
