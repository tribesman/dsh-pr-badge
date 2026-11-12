# @dsh-plugins/pr-badge

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin:
every chat in the sidebar whose own work has a pull request (GitHub) or merge
request (GitLab) gets the octicon next to its title, colored by the state of
that request, and clicking the icon opens it in a new tab. The request is the
chat's own — its worktree's, the one its title points at, or the one it names —
never just the branch a shared checkout happens to be left on.

```
 sidebar                                          colors
┌───────────────────────────────────────┐
│ ▸ dating-golang                       │   green  #3fb950  open, nothing blocking
│    ⬡ Refactor the parser        5min  │   orange #d29922  open but blocked
│    ● Fix the auth race          1h    │   purple #a371f7  merged
│ ▸ hlrd2021                            │   grey   #8b949e  closed without merge
│    ⬡ Bump the deps              2d    │
└───────────────────────────────────────┘
     ↑ octicon, click-through to the PR        no PR → no icon at all
```

## Behavior

1. **Host half** resolves, once per session, which pull request belongs to that
   chat, from four sources in strict priority order:

   | Priority | `source` | How it is read |
   | --- | --- | --- |
   | 1 | `binding` | the chat's own worktree, from `<repo>/.dsh/worktrees/bindings.json` (written by `@dsh-plugins/worktree-launcher`) |
   | 2 | `reference` | the pull request the chat *names* in its opening message — `/code-review pr 335`, `PR 331`, a `…/pull/75` URL |
   | 3 | `task` | the request whose branch or title carries the tracker id the chat's title opens with (`434 …` → `tk-434` / `#434 …`) — `gh pr list` for GitHub, `glab api …search` for GitLab |
   | 4 | `cwd` | the branch of the chat's *own* checkout: a linked worktree always, the primary checkout only when the chat corroborates the request |

   ```
   branch   ──git rev-parse --show-toplevel / --abbrev-ref HEAD──▶ repository + branch
   default  ──git symbolic-ref refs/remotes/origin/HEAD──────────▶ the branch nobody owns
   checkout ──git rev-parse --git-common-dir─────────────────────▶ primary checkout or linked worktree
   remote   ──git config --get-regexp '^remote\..*\.url$'────────▶ host → gh (github) or glab (gitlab)
   binding  ──<repo>/.dsh/worktrees/bindings.json────────────────▶ the chat's own worktree branch
   message  ──titleInput projection checkpoint───────────────────▶ PR named in the opening message
   index    ──gh pr list --state all --limit 200─────────────────▶ PRs by tracker id (GitHub)
   both     ──gh pr view <branch | number | url> --json …────────▶ PR view (GitHub, cwd = repository top)
   task     ──glab api projects/<path>/merge_requests?search=…──▶ MR view (GitLab)
   ```

   The priority exists because each source is weaker than the one above it:

   - a **worktree binding** is the chat's own isolated checkout: that is its work;
   - a chat's **own words** — the pull request it names, or the tracker id its
     title opens with — name its subject even when it works in a shared
     checkout, where the directory says nothing about the chat;
   - a **linked worktree** is somebody's isolated checkout, so its branch is
     trusted as-is;
   - the **primary checkout's branch is the weakest witness**: every chat started
     in that directory reports the same branch, so that branch may only badge a
     chat that *corroborates* the request (the chat names the branch, its
     tracker id is the one the request carries, or it is titled after the
     request). A brand-new chat with no text of its own corroborates nothing and
     stays clean — the badge never appears merely because the chat was opened in
     a directory whose checkout happens to sit on a PR branch;
   - the repository's own **default branch** (`origin/HEAD`, e.g. `v2/master`) is
     skipped along with the configured integration branches and detached HEADs:
     their requests belong to somebody else. Only an id at the very start of the
     title or opening message counts as a tracker id, so a number in prose cannot
     borrow somebody else's request.

   `gh`/`glab` run with the *repository top* as their working directory, so they
   resolve the session's own repository. The opening message is read from the
   harness's projection checkpoint — the same `titleInput` fold the session title
   is derived from — so it costs one in-memory lookup per session, never a
   session-log decompression. A chat that only mentions an issue
   (`приступай к выполнению issue 336`) yields nothing: only explicit
   pull-request wording and pull URLs count.
2. **Browser half** polls `GET /pr-badge/api/states` and paints one badge per
   matching sidebar row: an `<a class="dsh-pr-badge">` carrying the octicon,
   inserted directly left of the row title. Clicking it opens the PR in a new
   tab (`target="_blank" rel="noopener noreferrer"`) and **does not** switch the
   chat — the click is stopped before the row's own handler sees it.
3. Hovering shows `owner/repo#123 · <state>` — or `group/project!1660 · <state>`
   for GitLab, which keeps its own `!` sigil and `MR` wording.

## States

| Color | When | Meaning |
| --- | --- | --- |
| green `#3fb950` | `OPEN` with nothing blocking: review not requested or approved, checks green/pending, no conflicts | ready to merge |
| orange `#d29922` | `OPEN` and blocked — conflicts with the base branch, `CHANGES_REQUESTED`, a failing check, or a draft | needs you |
| purple `#a371f7` | `MERGED` | landed |
| grey `#8b949e` | `CLOSED` without a merge | abandoned |
| *nothing* | no PR, not a git repository, detached HEAD, or an integration branch (`main`, `master`, `develop`, `trunk`, `development`) | — |

Pending checks and `REVIEW_REQUIRED` are deliberately **green**: they are the
normal state of a healthy open PR, not a problem to fix. A `gh`/`glab` failure
produces **no badge** — never a misleading green one.

GitLab merge requests are mapped onto the same faces: `opened`/`merged`/`closed`
→ `OPEN`/`MERGED`/`CLOSED`, `draft` → orange, `has_conflicts` or
`detailed_merge_status: conflict` → conflicts, and `head_pipeline.status`
(`failed`/`success`/`running`/…) → failing / passing / pending checks.

Integration branches are skipped because their pull requests belong to somebody
else's fork: `gh pr view main` in a fork returns a stranger's PR.

## Endpoint

```
GET /pr-badge/api/states          → { entries: [ … ], generatedAt: <ms> }
GET /pr-badge/api/states?debug=1  → adds { diagnostics: [ … ] }   (only with debug: true)
```

One entry per session whose branch carries a PR:

```json
{
  "sessionId": "session-…",
  "title": "Refactor the parser",
  "branch": "dsh-brisk-harbor-bold",
  "root": "/root/dating-app",
  "source": "binding",
  "worktree": "/root/dating-app/.dsh/worktrees/dsh-brisk-harbor-bold",
  "reference": null,
  "task": null,
  "forge": "github",
  "repo": "tribesman/dating-golang",
  "number": 75,
  "url": "https://github.com/tribesman/dating-golang/pull/75",
  "state": "MERGED",
  "color": "purple",
  "reason": "merged"
}
```

`source` names the winning source — `binding` (the chat's own worktree),
`reference` (the pull request its opening message names), `task` (the request
that carries the tracker id from the chat title) or `cwd` (the branch of the
chat's own checkout — always trusted in a linked worktree, and only with the
chat's corroboration in the primary checkout). A reference-sourced badge carries `reference`
as `#<n>`, a task-sourced one carries `task` as the tracker id, and both leave
`branch`/`worktree` null. `reason` is a stable code
(`open`, `merged`, `closed`, `conflicts`, `changes-requested`, `checks-failing`,
`draft`); the browser half owns the tooltip wording. With `debug: true` each
session also gets a diagnostic row with the `cwd` it resolved, its
repository/branch/source/forge, the opening message it read, and why it produced
no badge (`no-cwd`, `not-a-repository`, `base-branch`, `detached-head`, `no-pr`,
`no-remote`, `ambient-branch`, `gh-error`, `gh-missing`, `glab-error`,
`glab-missing`, `bad-json`, `unknown-state`).
`ambient-branch` is the shared-checkout case: the branch carries a request, but
the chat never corroborates it, so the badge is withheld.

Every route is loopback-only behind a Host allowlist (`localhost` / `127.0.0.1`
/ `::1`) and takes **no parameters**: paths and command arguments come from
session headers, never from the request. `git` and `gh` execute with the full
privileges of the harness process.

## Caching

The sidebar polls once a minute; the host keeps the work off the wire and off
the forge CLIs' rate limits:

| Layer | TTL |
| --- | --- |
| session corpus listing | 15 s |
| worktree bindings (`bindings.json`) | 15 s |
| opening messages | immutable; read from the projection checkpoint each listing |
| `cwd` → repository/branch | 30 s |
| PR state while `OPEN` | 60 s |
| PR state once merged/closed | 10 min |
| "no PR on this branch" | 2 min |
| repository PR index (GitHub tracker ids) | 2 min |
| failures (`gh`/`glab` missing, network, bad JSON) | 30 s |

Concurrent `git`/`gh`/`glab` processes are capped (default 3); sessions sharing one
`cwd` or one branch share a single resolution, and simultaneous client polls
share one in-flight feed.

## Install

```bash
git clone https://github.com/tribesman/dsh-pr-badge.git
ln -s "$PWD/dsh-pr-badge" ~/.dsh/profiles/<profile>/node_modules/@dsh-plugins/pr-badge
```

(or install it as a package: `dsh plugin --profile <profile> add
"git+https://github.com/tribesman/dsh-pr-badge.git"`)

then add a Loader row to the profile patch:

```yaml
insert:
  - id: pr-badge
    name: '@dsh-plugins/pr-badge'
```

**A new Loader row mounts at the next harness start** — the web surface disables
the config watcher, so editing the patch on a running instance changes nothing.

Requires the `gh` CLI for GitHub repositories and the `glab` CLI for GitLab ones,
each authenticated for the repositories the sessions work in (`gh auth status`,
`glab auth status`), and the optional `sessionQuery` host service, which supplies
the session list. Without the client for a repository's forge, the plugin simply
paints nothing for it — and with `debug: true` it says why.

## Config

Row config is optional; every field has a default.

| Field | Default | Meaning |
| --- | --- | --- |
| `debug` | `false` | accept `?debug=1` and log warnings to the harness console |
| `ghPath` | `gh` from `PATH` | explicit `gh` binary |
| `forge` | auto | force `github` (`gh`) or `gitlab` (`glab`) when the remote host name does not say which |
| `gitTimeoutMs` / `ghTimeoutMs` | 10 s / 15 s | per-process budget |
| `locationTtlMs` | 30 s | `cwd` → repository/branch cache |
| `bindingsTtlMs` | 15 s | worktree-bindings registry cache |
| `references` | `true` | read a pull request out of a session's opening message |
| `sessionsTtlMs` | 15 s | session listing cache |
| `openTtlMs` / `terminalTtlMs` | 60 s / 10 min | PR cache while open / finished |
| `absentTtlMs` / `errorTtlMs` | 2 min / 30 s | negative and failure cache |
| `maxConcurrency` | 3 | concurrent `git`/`gh`/`glab` processes |
| `maxSessions` | 200 | sessions considered per feed pass |
| `skipBranches` | `main`, `master`, `develop`, `trunk`, `development` | integration branches never badged; the repository's own `origin/HEAD` branch is always added |

## How it is wired

The stock session list exposes **no per-row slot** — `sidebar.workspaces` is a
single-registration seat covering the whole tree — so the badge is painted into
the DOM from a headless `shell.overlay` entry, exactly like
`@dsh-plugins/worktree-launcher` does for its git glyph. Two details are worth
knowing:

- **Row identity.** Rows carry no session id in the DOM, so the plugin walks the
  row element's React fiber chain up to the component whose props hold the
  session node and reads its `node.id`. If that ever stops working the plugin
  falls back to normalized title matching — but only for titles no other chat
  shares, because a shared title is not an identity. If neither resolves, the
  row simply keeps no badge; the shell is never broken.
- **Ownership.** The plugin only ever inserts and removes its own `<a>` nodes;
  it never rewrites React-managed children, and unmounting restores the stock
  shell exactly.

## Test

```bash
node test/run.mjs          # host half, real git repos + stub gh/glab
node test/client-check.mjs # browser bundle in a stubbed DOM
```
