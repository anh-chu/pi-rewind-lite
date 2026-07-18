# pi-rewind-lite

**Claude Code-style `/rewind` for [Pi](https://pi.dev).**

Snapshot files before they change. Restore code, conversation, or both. No git required, no workspace scanning, no startup cost.

```
/rewind
├─ Restore code and conversation
├─ Restore conversation only
├─ Restore code only
└─ Cancel
```

## The Problem

Every existing Pi rewind extension makes the same mistake: they snapshot your **entire workspace** on every turn, then diff it to find what changed. That's backwards.

| Extension | What it does per turn | Cost |
|---|---|---|
| pi-chrono | 2× full workspace walk + SHA256 hash every file | O(all files) |
| pi-rewind | Full workspace checkpoint | O(all files) |
| pi-code-rollback | `git add -A` + `git write-tree` | O(all files), requires git |
| pi-undo-redo | Shadow git commit | O(all files), requires git |

Claude Code figured this out: just copy each file *right before the agent modifies it*. That's it. No scanning, no indexing, no git.

**pi-rewind-lite does the same thing.**

## How It Works

```
agent writes to file ──► tool_call event fires ──► copy file to backup ──► tool executes
                              (before execution)        (~1ms)
```

1. Hooks into Pi's `tool_call` event for `write` and `edit` tools
2. Copies the target file **before** the tool executes
3. Stores backups externally at `~/.pi/rewind-lite/<sessionId>/backups/`
4. On `/rewind`, pick a restore point → choose code / conversation / both

That's the entire design. No filesystem walks, no git operations, no indices.

## Benchmarks

Measured on real Pi sessions (not mocks):

```
Session startup ··········· 0.6 – 2.5 ms
Snapshot per file write ···  0.4 – 3.3 ms
10 files in one turn ······ ~11 ms total
agent_end cleanup ·········  0.0 ms
Disk per session ··········  5 – 9 KB (for 3–10 file backups)
```

### Scaling

| Workspace size | pi-rewind-lite | pi-code-rollback | pi-chrono |
|---|---|---|---|
| 100 files, 1 changed | **~1ms** | ~5ms | ~50ms+ |
| 2,000 files, 1 changed | **~1ms** | ~6ms | ~200ms+ |
| 10,000 files, 1 changed | **~1ms** | ~15ms+ | ~500ms+ |

pi-rewind-lite is O(changed files). Everything else is O(all files).

## Install

```bash
pi install npm:pi-rewind-lite
```

Or from source:

```bash
pi install /path/to/pi-rewind-lite
```

## Commands

| Command | Description |
|---|---|
| `/rewind` | Pick a restore point, choose how to restore |
| `/undo-rewind` | Undo the last `/rewind` |
| `/rewind-status` | Show tracked files and restore points |
| `/rewind-gc` | Clean up sessions older than 7 days |

## 3-Way Restore

When you run `/rewind`, you choose a restore point and then pick a mode:

- **Code + conversation** — restores files on disk and navigates to that point in the session tree
- **Conversation only** — rewinds the session tree without touching files (useful when the code is fine but you want to re-prompt)
- **Code only** — restores files without touching the conversation (useful when you want to keep the chat context but undo file changes)

Every restore can be undone with `/undo-rewind`.

## Design Decisions

**Why not git?**
Git is great, but `git add -A` walks the entire worktree. On large monorepos that's measurable. It also means the extension breaks in non-git directories, and stores refs inside your `.git/` (visible via `git for-each-ref`, pushable via `--mirror`).

**Why not content-addressed dedup?**
Claude Code uses `{hash}@v{N}` naming but doesn't actually deduplicate by content — each version is a separate copy. We do the same. The files being backed up are typically small (source code), and the simplicity of "one file = one backup" means zero overhead for hash comparisons or refcounting.

**Why external storage?**
Backups live at `~/.pi/rewind-lite/` instead of inside your project. Your project directory stays clean. No `.git/refs/pi/*` cruft, no `.pi-checkpoints/` directory, nothing.

**Why 10MB file size limit?**
Files over 10MB are silently skipped (configurable). These are almost never source code — they're build artifacts, binaries, or data files. Backing them up would blow up disk usage for no practical benefit.

**Why auto-GC at 30 days?**
Session data older than 30 days is cleaned up on startup (matching Claude Code's default). This keeps `~/.pi/rewind-lite/` from growing unbounded while still letting you `/rewind` sessions from weeks ago.

## Configuration

Optionally create `~/.pi/rewind-lite.json`:

```json
{
  "cleanupDays": 30,
  "maxFileMB": 10
}
```

| Key | Default | Description |
|---|---|---|
| `cleanupDays` | `30` | Days before session data is auto-cleaned |
| `maxFileMB` | `10` | Skip files larger than this (MB) |

## Storage Layout

```
~/.pi/rewind-lite/
└── <sessionId>/
    ├── backups/
    │   ├── 95dc6dbe572a6d7f@v1    ← fileA.txt before first edit
    │   ├── 95dc6dbe572a6d7f@v2    ← fileA.txt before second edit
    │   └── 9ffe1d8ba035655e@v1    ← fileB.txt before first edit
    └── snapshots.jsonl             ← append-only snapshot journal
```

Each backup filename is `sha256(relativePath).slice(0,16) + @v{version}`. The journal maps entry IDs to file states for restore.

## Requirements

- **Pi** ≥ 0.6.0
- **No git required** — works in any directory
- **No dependencies** — zero runtime deps, just Node.js built-ins

## License

MIT
