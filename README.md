# pi config

My personal config for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent),
kept in git so it survives machine wipes — and so anyone else can lift the parts they like.

pi reads its config from `~/.pi/agent/`, so this repo *is* `~/.pi`.

## What's in here

| Path | What it does |
| --- | --- |
| `agent/settings.json` | Global pi settings. Currently just selects the theme. |
| `agent/themes/one-dark-pro.json` | One Dark Pro colour theme. |
| `agent/.env.example` | Template for `agent/.env`, which holds your keys and is gitignored. |

Each extension is a folder whose `index.ts` is the entry point; every sibling file is a plain
helper module. That is pi's documented multi-file layout, and it's required here — pi auto-loads
*every* top-level `extensions/*.ts` as its own extension, so a helper sitting beside an entry point
would be loaded as an extension and fail.

**`agent/extensions/statusline/`** — custom footer. Line 1: model / cwd / branch / diff stat /
version. Line 2: context bar and token totals. Line 3: subscription limit meters, when the
provider reports any.

| File | Role |
| --- | --- |
| `index.ts` | Footer wiring and layout |
| `config.ts` | Tunables, colours, bar glyphs |
| `render.ts` | Colours, number formatting, meters (pure) |
| `git.ts` | Working-tree diff counts |
| `usage.ts` | Subscription limit windows via the Codex endpoint |

**`agent/extensions/web-search/`** — registers a `web_search` tool backed by
[Exa](https://exa.ai). Requires `EXA_API_KEY`.

| File | Role |
| --- | --- |
| `index.ts` | Tool registration and orchestration |
| `config.ts` | Tunables and endpoint constants |
| `client.ts` | Request building, filter validation, HTTP |
| `format.ts` | Dedupe and markdown rendering (pure) |
| `types.ts` | Exa response shapes |

**`agent/extensions/web-fetch/`** — registers a `web_fetch` tool that reads pages by URL via Exa's
`/contents`. Pairs with `web_search`, which finds the URLs. Requires `EXA_API_KEY`.

| File | Role |
| --- | --- |
| `index.ts` | Tool registration and orchestration |
| `config.ts` | Tunables and fence markers |
| `client.ts` | URL validation, request building, HTTP |
| `sanitize.ts` | Injection defenses (pure) |
| `format.ts` | Fenced, labelled rendering (pure) |
| `types.ts` | Exa `/contents` response shapes |

**`agent/extensions/env/`** — loads `.env` files into `process.env` at session start. pi has no
built-in dotenv support.

| File | Role |
| --- | --- |
| `index.ts` | Extension wiring |
| `config.ts` | Tunables |
| `parse.ts` | dotenv text → key/value pairs (pure) |
| `load.ts` | File discovery, permission check, applying to `process.env` |

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
- **Web search** — needs an Exa key from <https://dashboard.exa.ai/api-keys>; put it in
  `agent/.env` (see below). Tunables (result count, snippet length, search mode, timeout) live in
  the `CONFIG` block at the top of `agent/extensions/web-search.ts`. Exa bills per search, and
  `CONFIG.searchType` values `deep`/`deep-reasoning` cost substantially more and are far slower than
  the default `auto` (~1s vs 4–40s). Highlights-only is the default content mode because it keeps
  token cost predictable; set `CONFIG.includeText` to also pull page text. Categories `company` and
  `people` disable `excludeDomains` and both date filters — the tool rejects that combination up
  front rather than letting Exa 400. Canonical API reference:
  <https://exa.ai/docs/reference/search-api-guide-for-coding-agents>
- **Secrets / env vars** — pi has no built-in dotenv support, so `agent/extensions/env.ts` adds it:

  ```sh
  cp ~/.pi/agent/.env.example ~/.pi/agent/.env
  chmod 600 ~/.pi/agent/.env
  ```

  Put `EXA_API_KEY=...` (and anything else) in there. Precedence is **most specific wins**: a var
  already exported in your shell beats `<cwd>/.pi/.env`, which beats `~/.pi/agent/.env`. Nothing
  already set is ever overwritten. `.env` is gitignored — **never** put a key in `settings.json`
  or `.env.example`, both of which are committed to this public repo.

  Caveat: the loader runs at `session_start`, so it reliably serves anything read at call time
  (like `EXA_API_KEY`, which `web-search.ts` reads inside `execute()`). Whether it lands early
  enough for pi's *own* provider credentials (`ANTHROPIC_API_KEY` etc.) is untested — keep
  provider keys in your shell profile or use `/login`.
- **Web fetch, and its trust boundary** — `web_fetch` returns third-party content, which is
  attacker-controlled by definition. Defenses: invisible/bidi/tag characters, terminal escapes and
  markup are stripped; content is wrapped in fence markers randomised per process (so a page can't
  forge the closing marker) with any copy inside neutralised; and an explicit untrusted-data notice
  precedes it. Instruction-like prose is **not** censored — blocklisting phrases is trivially
  bypassed and mangles legitimate pages, so the design is containment plus labelling. **This raises
  the bar; it does not make reading hostile pages safe.** Nothing fetched is ever executed.
  Because Exa performs the fetch, SSRF against localhost and private ranges is impossible by
  construction — which also means intranet URLs don't work.
- **Keeping fetches cheap** — pass a `query` to `web_fetch` and it returns a focused summary plus
  targeted excerpts instead of the whole page. Measured: **1,604 chars vs 6,571 — 75.6% smaller**
  on the same document. Text mode is capped at `CONFIG.maxCharsPerPage` (6k) and reports truncation
  rather than silently cutting. Note that Exa's documented `text.verbosity: "compact"` knob had
  **no measurable effect** in testing (identical 18,668 chars vs `"full"`), so the character cap is
  the only control that actually works.
- **Adding an extension** — create `agent/extensions/<name>/index.ts` with a default-exported
  factory, and put helpers in sibling files. Import them with an explicit `.ts` extension
  (`from "./config.ts"`), which is what pi's own examples do — extensions load through jiti, so
  TypeScript runs uncompiled and no build step is involved.
- **Disable an extension** — remove or rename the file out of `agent/extensions/`.

`agent/settings.json` also gains machine-local keys as you use pi (e.g. `lastChangelogVersion`).
Harmless to commit, but expect churn there.
