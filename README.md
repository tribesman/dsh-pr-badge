# @dsh-plugins/pr-badge

A pull-request badge on every Session row of the DSH Web GUI.

Each Session remembers the directory it was started in. This plugin resolves the
Git repository and the checked-out branch from that directory, asks the GitHub
CLI for the pull request whose head is that branch, and paints the number in the
Session list — green open, grey draft, violet merged, red closed. The number,
state, and title travel in the tooltip and the accessible name.

## What you see

| Place | Element |
| --- | --- |
| Left sidebar, Session row trailing strip | `#123` pill, colour = PR state |

The badge is absent when the Session's directory is not a repository, when the
branch has no pull request, or when `gh` cannot answer. It never blocks the row:
the pill is only rendered once a state exists.

## Install

```bash
# 1. install the package into the profile
dsh plugin --profile web add "git+https://github.com/tribesman/dsh-pr-badge.git"
# or from a checkout, for development (symlink, no copy)
ln -s /path/to/dsh-pr-badge ~/.dsh/profiles/web/node_modules/@dsh-plugins/pr-badge

# 2. add one Loader row to the profile patch layer
#    ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: pr-badge
      name: '@dsh-plugins/pr-badge'
```

The profile reload is live: the row mounts without restarting `dsh web`.

Prebuilt tarball: `npm pack` in this directory, then
`dsh plugin --profile web add ./dsh-plugins-pr-badge-0.2.0.tgz`.

## Requirements

- **`git`** on `PATH` — resolves the repository root and branch.
- **`gh`** on `PATH`, authenticated — `gh auth status` must succeed for the
  account that can see the pull requests. The plugin stores no credentials: it
  runs the operator's own `gh`.

## Host route

```
GET /pr-badge/api/states
-> { "states": { "<sessionId>": { "branch": "feat/x", "pr": { "number": 12,
     "state": "OPEN", "url": "https://github.com/…", "title": "…",
     "draft": false } } } }
```

`pr` is `null` for a Session without a pull request; `branch` is `null` when the
directory is not a repository or the checkout is detached.

The route takes no input beyond the Session ids the harness already knows, so
the browser cannot name a path or a branch of its own. Like the other community
plugins it uses `ctx.webServer.register` (a raw node handler) rather than the
authenticated `connection.fetch` fence — see the note in
[the file-download README](../file-download/README.md) for that tradeoff. The
route is read-only and exposes only pull-request metadata that the operator's
own `gh` login can already see.

## Behaviour details

- **Caching.** One `git rev-parse` per Session directory per 5 minutes, one
  `gh pr list` per branch per minute. A sidebar with many Sessions therefore
  costs a handful of subprocesses, not one per row.
- **Polling.** The browser refreshes the snapshot every 45 s while the tab is
  visible, and once more when the page becomes visible again. All rows share a
  single request.
- **Isolation.** A failure in one Session (missing directory, detached HEAD,
  unauthenticated `gh`, timeout) yields `pr: null` for that Session only.
- **Bounds.** At most 80 Sessions are asked about per request, and commands time
  out after 10 s.

## Development

```bash
npm run check   # syntax of both halves
npm test        # host route against a stub context
```

## License

MIT
