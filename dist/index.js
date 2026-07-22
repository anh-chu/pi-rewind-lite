/**
 * pi-rewind-lite
 *
 * Claude Code-style /rewind for Pi.
 *
 * Design principles:
 * 1. Only snapshot files right BEFORE they are edited (tool_call interception)
 * 2. No git, no workspace scanning, no indexing
 * 3. Content-addressed flat file storage at ~/.pi/rewind-lite/<session>/
 * 4. 3-way restore: code only / conversation only / both
 * 5. Zero startup cost, minimal per-turn overhead
 *
 * Storage layout:
 *   ~/.pi/rewind-lite/<sessionId>/
 *     backups/          — content-addressed file copies (sha256-first12@vN)
 *     snapshots.jsonl   — append-only snapshot journal
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, stat, unlink, writeFile, appendFile, chmod, } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { DynamicBorder, } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, } from "@earendil-works/pi-tui";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const EXTENSION_NAME = "pi-rewind-lite";
const STORAGE_ROOT = join(homedir(), ".pi", "rewind-lite");
const DEFAULT_CLEANUP_DAYS = 30;
const DEFAULT_MAX_FILE_MB = 10;
const ENTRY_TYPE_SNAPSHOT = "rewind-lite-snapshot";
const ENTRY_TYPE_RESTORE = "rewind-lite-restore";
const CONFIG_PATH = join(homedir(), ".pi", "rewind-lite.json");
let config = {
    cleanupDays: DEFAULT_CLEANUP_DAYS,
    maxFileMB: DEFAULT_MAX_FILE_MB,
};
async function loadConfig() {
    try {
        const raw = await readFile(CONFIG_PATH, "utf-8");
        const parsed = JSON.parse(raw);
        if (typeof parsed.cleanupDays === "number" && parsed.cleanupDays > 0) {
            config.cleanupDays = parsed.cleanupDays;
        }
        if (typeof parsed.maxFileMB === "number" && parsed.maxFileMB > 0) {
            config.maxFileMB = parsed.maxFileMB;
        }
    }
    catch {
        // No config file or invalid JSON — use defaults
    }
}
// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let state = null;
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function toTrackingPath(filePath, cwd) {
    if (!isAbsolute(filePath))
        return filePath;
    const abs = resolve(filePath);
    if (abs.startsWith(cwd + "/") || abs.startsWith(cwd + "\\")) {
        return relative(cwd, abs);
    }
    return abs;
}
function toAbsolutePath(trackingPath, cwd) {
    if (isAbsolute(trackingPath))
        return trackingPath;
    return join(cwd, trackingPath);
}
function hashPath(trackingPath) {
    return createHash("sha256").update(trackingPath).digest("hex").slice(0, 16);
}
function backupFileName(trackingPath, version) {
    return `${hashPath(trackingPath)}@v${version}`;
}
async function fileExists(path) {
    try {
        await stat(path);
        return true;
    }
    catch {
        return false;
    }
}
async function getFileSize(path) {
    try {
        const s = await stat(path);
        return s.size;
    }
    catch {
        return null;
    }
}
function truncateLabel(text, max = 80) {
    if (!text)
        return "(empty)";
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean.length <= max)
        return clean;
    return clean.slice(0, max - 1) + "…";
}
// ---------------------------------------------------------------------------
// Core: Backup a file before edit
// ---------------------------------------------------------------------------
async function backupFile(trackingPath) {
    if (!state)
        return null;
    // Already backed up this file for the current turn
    if (state.pendingBackups.has(trackingPath))
        return null;
    state.pendingBackups.add(trackingPath);
    const absPath = toAbsolutePath(trackingPath, state.cwd);
    // Check file size — skip huge files
    const maxBytes = config.maxFileMB * 1024 * 1024;
    const size = await getFileSize(absPath);
    if (size !== null && size > maxBytes)
        return null;
    const version = (state.fileVersions.get(trackingPath) ?? 0) + 1;
    const bkName = backupFileName(trackingPath, version);
    const bkPath = join(state.backupsDir, bkName);
    let backupName;
    if (size === null) {
        // File doesn't exist yet — record null (it's a new file being created)
        backupName = null;
    }
    else {
        // Copy the file before it gets modified
        try {
            await copyFile(absPath, bkPath);
            // Preserve permissions
            const s = await stat(absPath);
            await chmod(bkPath, s.mode);
            backupName = bkName;
        }
        catch {
            // If copy fails, skip silently — don't block the tool
            return null;
        }
    }
    state.fileVersions.set(trackingPath, version);
    const backup = {
        trackingPath,
        backupFileName: backupName,
        version,
        timestamp: Date.now(),
    };
    return backup;
}
// ---------------------------------------------------------------------------
// Core: Snapshot management
// ---------------------------------------------------------------------------
async function createSnapshot(entryId, label) {
    if (!state)
        return;
    // Build file map from the latest snapshot + any new backups from this turn
    const prevSnapshot = state.snapshots.at(-1);
    const files = {};
    // Carry forward all previously tracked files
    if (prevSnapshot) {
        for (const [path, backup] of Object.entries(prevSnapshot.files)) {
            files[path] = backup;
        }
    }
    const snapshot = {
        entryId,
        files,
        timestamp: Date.now(),
        label,
    };
    state.snapshots.push(snapshot);
    // Persist to journal
    try {
        const journalPath = join(state.sessionDir, "snapshots.jsonl");
        await appendFile(journalPath, JSON.stringify(snapshot) + "\n");
    }
    catch {
        // Non-fatal
    }
}
function updateCurrentSnapshot(backup) {
    if (!state)
        return;
    const current = state.snapshots.at(-1);
    if (!current)
        return;
    current.files[backup.trackingPath] = backup;
    // Async persist update (fire-and-forget)
    const journalPath = join(state.sessionDir, "snapshots.jsonl");
    const lines = state.snapshots.map((s) => JSON.stringify(s)).join("\n") + "\n";
    writeFile(journalPath, lines).catch(() => { });
}
// ---------------------------------------------------------------------------
// Core: Restore
// ---------------------------------------------------------------------------
async function restoreFiles(targetSnapshot) {
    if (!state)
        return [];
    const changed = [];
    // Get all tracked files across all snapshots
    const allTrackedPaths = new Set();
    for (const snap of state.snapshots) {
        for (const path of Object.keys(snap.files)) {
            allTrackedPaths.add(path);
        }
    }
    for (const trackingPath of allTrackedPaths) {
        const absPath = toAbsolutePath(trackingPath, state.cwd);
        const targetBackup = targetSnapshot.files[trackingPath];
        if (!targetBackup) {
            // File wasn't tracked at the target point.
            // Check if it was first tracked AFTER the target — if so, it should be deleted.
            const firstTrackedSnapshot = state.snapshots.find((s) => s.files[trackingPath] && s.files[trackingPath].backupFileName === null);
            if (firstTrackedSnapshot &&
                firstTrackedSnapshot.timestamp > targetSnapshot.timestamp) {
                // File was created after target — delete it
                try {
                    await unlink(absPath);
                    changed.push(trackingPath);
                }
                catch {
                    // Already gone
                }
            }
            continue;
        }
        if (targetBackup.backupFileName === null) {
            // File shouldn't exist at this point — delete if present
            if (await fileExists(absPath)) {
                try {
                    await unlink(absPath);
                    changed.push(trackingPath);
                }
                catch { }
            }
            continue;
        }
        // Restore from backup
        const bkPath = join(state.backupsDir, targetBackup.backupFileName);
        if (!(await fileExists(bkPath)))
            continue;
        // Check if file actually differs
        try {
            const [currentContent, backupContent] = await Promise.all([
                readFile(absPath, "utf-8").catch(() => null),
                readFile(bkPath, "utf-8"),
            ]);
            if (currentContent === backupContent)
                continue;
        }
        catch {
            // If we can't read, try to restore anyway
        }
        try {
            await mkdir(dirname(absPath), { recursive: true });
            await copyFile(bkPath, absPath);
            const bkStats = await stat(bkPath);
            await chmod(absPath, bkStats.mode);
            changed.push(trackingPath);
        }
        catch {
            // Non-fatal
        }
    }
    return changed;
}
/** Capture current state as a pre-restore snapshot for undo. */
async function captureCurrentState() {
    if (!state)
        return null;
    const files = {};
    const allPaths = new Set();
    for (const snap of state.snapshots) {
        for (const p of Object.keys(snap.files))
            allPaths.add(p);
    }
    for (const trackingPath of allPaths) {
        const absPath = toAbsolutePath(trackingPath, state.cwd);
        const version = (state.fileVersions.get(trackingPath) ?? 0) + 1;
        const bkName = backupFileName(trackingPath, version);
        const bkPath = join(state.backupsDir, bkName);
        const exists = await fileExists(absPath);
        if (!exists) {
            files[trackingPath] = {
                trackingPath,
                backupFileName: null,
                version,
                timestamp: Date.now(),
            };
            state.fileVersions.set(trackingPath, version);
            continue;
        }
        try {
            await copyFile(absPath, bkPath);
            const s = await stat(absPath);
            await chmod(bkPath, s.mode);
            files[trackingPath] = {
                trackingPath,
                backupFileName: bkName,
                version,
                timestamp: Date.now(),
            };
            state.fileVersions.set(trackingPath, version);
        }
        catch {
            // Skip
        }
    }
    return {
        entryId: state.currentEntryId ?? "pre-restore",
        files,
        timestamp: Date.now(),
        label: "(pre-restore state)",
    };
}
// ---------------------------------------------------------------------------
// GC: Clean up old session data
// ---------------------------------------------------------------------------
async function garbageCollect() {
    let cleaned = 0;
    const maxAgeMs = config.cleanupDays * 24 * 60 * 60 * 1000;
    try {
        const sessions = await readdir(STORAGE_ROOT);
        const now = Date.now();
        for (const sessionDir of sessions) {
            const sessionPath = join(STORAGE_ROOT, sessionDir);
            try {
                const s = await stat(sessionPath);
                if (!s.isDirectory())
                    continue;
                if (now - s.mtimeMs > maxAgeMs) {
                    await rm(sessionPath, { recursive: true, force: true });
                    cleaned++;
                }
            }
            catch {
                // Skip
            }
        }
    }
    catch {
        // Storage root doesn't exist yet
    }
    return cleaned;
}
// ---------------------------------------------------------------------------
// State initialization
// ---------------------------------------------------------------------------
async function initState(sessionId, cwd) {
    await loadConfig();
    const sessionDir = join(STORAGE_ROOT, sessionId);
    const backupsDir = join(sessionDir, "backups");
    await mkdir(backupsDir, { recursive: true });
    // Try to restore from journal
    const snapshots = [];
    const fileVersions = new Map();
    const journalPath = join(sessionDir, "snapshots.jsonl");
    try {
        const data = await readFile(journalPath, "utf-8");
        for (const line of data.split("\n").filter(Boolean)) {
            try {
                const snap = JSON.parse(line);
                snapshots.push(snap);
                for (const [path, backup] of Object.entries(snap.files)) {
                    const current = fileVersions.get(path) ?? 0;
                    if (backup.version > current) {
                        fileVersions.set(path, backup.version);
                    }
                }
            }
            catch {
                // Skip corrupt lines
            }
        }
    }
    catch {
        // No journal yet
    }
    state = {
        sessionId,
        sessionDir,
        backupsDir,
        cwd,
        snapshots,
        fileVersions,
        pendingBackups: new Set(),
        currentEntryId: null,
    };
}
// ---------------------------------------------------------------------------
// Helpers for restore points display
// ---------------------------------------------------------------------------
function getRestorePoints(ctx) {
    if (!state)
        return [];
    const points = [];
    // Get unique entry IDs from snapshots
    const seen = new Set();
    for (const snapshot of state.snapshots) {
        if (seen.has(snapshot.entryId))
            continue;
        seen.add(snapshot.entryId);
        const entry = ctx.sessionManager.getEntry(snapshot.entryId);
        const fileCount = Object.keys(snapshot.files).filter((k) => snapshot.files[k].backupFileName !== null).length;
        const timeAgo = formatTimeAgo(snapshot.timestamp);
        const label = snapshot.label ?? "(unknown prompt)";
        points.push({
            entryId: snapshot.entryId,
            snapshot,
            label: truncateLabel(label),
            preview: `${fileCount} file(s) tracked · ${timeAgo}`,
        });
    }
    return points;
}
function formatTimeAgo(timestamp) {
    const diff = Date.now() - timestamp;
    const mins = Math.floor(diff / 60000);
    if (mins < 1)
        return "just now";
    if (mins < 60)
        return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24)
        return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}
/** Extract the text of a user message entry (string content or text blocks). */
function extractUserMessageText(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    return content
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");
}
/**
 * Find the user-message entry that is the child of `parentId` and matches the
 * snapshot's prompt text. Navigating to this entry rewinds to the prompt AND
 * restores the prompt text into the input editor (Claude Code-style).
 */
function findUserPromptEntry(ctx, parentId, expectedText) {
    const entries = ctx.sessionManager.getEntries();
    let fallback = null;
    for (const entry of entries) {
        if (entry.type === "message" &&
            entry.parentId === parentId &&
            entry.message?.role === "user") {
            const text = extractUserMessageText(entry.message.content);
            if (expectedText && text === expectedText)
                return entry.id;
            if (!fallback)
                fallback = entry.id;
        }
    }
    return fallback;
}
function getLastUserPrompt(ctx, entryId) {
    const branch = ctx.sessionManager.getBranch(entryId);
    for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (entry.type === "message" &&
            "message" in entry &&
            entry.message?.role === "user") {
            const msg = entry.message;
            if (typeof msg.content === "string")
                return msg.content;
            if (Array.isArray(msg.content)) {
                const textBlock = msg.content.find((b) => b.type === "text" && typeof b.text === "string");
                if (textBlock)
                    return textBlock.text;
            }
        }
    }
    return undefined;
}
// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------
export default function activate(pi) {
    // ------------------------------------------------------------------
    // Lifecycle: session_start — GC + init
    // ------------------------------------------------------------------
    pi.on("session_start", async (_event, ctx) => {
        // Fire-and-forget GC
        garbageCollect().catch(() => { });
        const sessionId = ctx.sessionManager.getSessionId();
        await initState(sessionId, ctx.cwd);
    });
    // ------------------------------------------------------------------
    // Lifecycle: agent_start — create snapshot for this turn
    // ------------------------------------------------------------------
    pi.on("agent_start", async (_event, ctx) => {
        if (!state) {
            return;
        }
        const entryId = ctx.sessionManager.getLeafId();
        if (!entryId) {
            return;
        }
        state.currentEntryId = entryId;
        state.pendingBackups.clear();
        // Get user prompt for labeling
        const prompt = getLastUserPrompt(ctx, entryId);
        await createSnapshot(entryId, prompt);
    });
    // ------------------------------------------------------------------
    // Lifecycle: tool_call — snapshot files BEFORE write/edit
    // ------------------------------------------------------------------
    pi.on("tool_call", async (event, _ctx) => {
        if (!state) {
            return;
        }
        if (event.toolName === "write" || event.toolName === "edit") {
            const filePath = event.input.path;
            if (!filePath)
                return;
            const trackingPath = toTrackingPath(filePath, state.cwd);
            const backup = await backupFile(trackingPath);
            if (backup) {
                updateCurrentSnapshot(backup);
            }
            else {
            }
        }
    });
    // ------------------------------------------------------------------
    // Lifecycle: agent_end — finalize turn, reset pending set
    // ------------------------------------------------------------------
    pi.on("agent_end", async (_event, _ctx) => {
        if (!state)
            return;
        state.pendingBackups.clear();
        state.currentEntryId = null;
    });
    // ------------------------------------------------------------------
    // Command: /rewind — 3-way restore
    // ------------------------------------------------------------------
    pi.registerCommand("rewind", {
        description: "Restore code and/or conversation to a previous point",
        handler: async (_args, ctx) => {
            if (!state) {
                ctx.ui.notify("Rewind not initialized", "error");
                return;
            }
            const points = getRestorePoints(ctx);
            if (points.length === 0) {
                ctx.ui.notify("No restore points available yet", "warning");
                return;
            }
            // Step 1: Pick a restore point.
            // Chronological order (oldest first, latest at the bottom) reads as a
            // natural timeline. Use a custom SelectList so we can move the cursor
            // to the latest point, which is the most commonly wanted target.
            const items = points.map((p, i) => ({
                value: String(i),
                label: p.label,
                description: p.preview,
            }));
            const latestIndex = items.length - 1;
            const selected = await ctx.ui.custom((tui, theme, _kb, done) => {
                const container = new Container();
                container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
                container.addChild(new Text(theme.fg("accent", theme.bold("Rewind to which point?"))));
                const selectList = new SelectList(items, Math.min(items.length, 10), {
                    selectedPrefix: (t) => theme.fg("accent", t),
                    selectedText: (t) => theme.fg("accent", t),
                    description: (t) => theme.fg("muted", t),
                    scrollInfo: (t) => theme.fg("dim", t),
                    noMatch: (t) => theme.fg("warning", t),
                });
                selectList.setSelectedIndex(latestIndex);
                selectList.onSelect = (item) => done(item.value);
                selectList.onCancel = () => done(null);
                container.addChild(selectList);
                container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel")));
                container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
                return {
                    render: (w) => container.render(w),
                    invalidate: () => container.invalidate(),
                    handleInput: (data) => {
                        selectList.handleInput(data);
                        tui.requestRender();
                    },
                };
            });
            if (selected === null)
                return;
            const selectedIndex = Number(selected);
            if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= points.length) {
                return;
            }
            const point = points[selectedIndex];
            // Step 2: Pick restore mode — only offer code restore when this
            // snapshot actually has backed-up file content to bring back.
            const canRestoreCode = Object.values(point.snapshot.files).filter((f) => f.backupFileName !== null).length > 0;
            const modeOptions = canRestoreCode
                ? [
                    "Restore code and conversation",
                    "Restore conversation only",
                    "Restore code only",
                    "Cancel",
                ]
                : ["Restore conversation only", "Cancel"];
            const modeChoice = await ctx.ui.select("How to restore?", modeOptions);
            if (!modeChoice || modeChoice === "Cancel")
                return;
            let mode;
            if (modeChoice.includes("code and conversation")) {
                mode = "both";
            }
            else if (modeChoice.includes("code only")) {
                mode = "code";
            }
            else {
                mode = "conversation";
            }
            // Step 3: Pick restore target — only relevant when rewinding the
            // conversation. "to output" (default, current behavior) lands at the
            // prior assistant output with an empty editor. "to prompt" additionally
            // restores the selected prompt into the input editor so it can be
            // re-sent/edited (Claude Code-style).
            let target = "output";
            if (mode === "conversation" || mode === "both") {
                const targetChoice = await ctx.ui.select("Restore conversation to?", ["Restore to output", "Restore to prompt (prefill input)", "Cancel"]);
                if (!targetChoice || targetChoice === "Cancel")
                    return;
                target = targetChoice.startsWith("Restore to prompt") ? "prompt" : "output";
            }
            // Step 4: Confirm
            const confirmed = await ctx.ui.confirm("Confirm restore", `Restore ${mode === "both" ? "code + conversation" : mode}${target === "prompt" ? " (to prompt)" : ""} to: "${point.label}"?`);
            if (!confirmed)
                return;
            // Step 5: Capture pre-restore state for undo
            const preRestoreEntryId = ctx.sessionManager.getLeafId();
            const preRestoreSnapshot = await captureCurrentState();
            // Step 6: Execute restore
            let filesChanged = [];
            if (mode === "code" || mode === "both") {
                filesChanged = await restoreFiles(point.snapshot);
            }
            let promptPrefilled = false;
            if (mode === "conversation" || mode === "both") {
                if (ctx.navigateTree) {
                    if (target === "prompt") {
                        // Navigate to the user-message child of the snapshot entry so
                        // the prompt text is restored into the input editor.
                        const promptEntryId = findUserPromptEntry(ctx, point.snapshot.entryId, point.snapshot.label);
                        await ctx.navigateTree(promptEntryId ?? point.snapshot.entryId);
                        promptPrefilled = !!promptEntryId;
                    }
                    else {
                        await ctx.navigateTree(point.snapshot.entryId);
                    }
                }
            }
            // Step 7: Record the restore event for undo
            const restoreEvent = {
                entryId: point.snapshot.entryId,
                mode,
                target,
                preRestoreEntryId: preRestoreEntryId ?? "",
                preRestoreSnapshot,
                timestamp: Date.now(),
                kind: "restore",
            };
            pi.appendEntry(ENTRY_TYPE_RESTORE, restoreEvent);
            // Step 8: Notify
            const parts = [];
            if (filesChanged.length > 0) {
                parts.push(`${filesChanged.length} file(s) restored`);
            }
            if (mode === "conversation" || mode === "both") {
                parts.push(target === "prompt" && promptPrefilled
                    ? "conversation rewound, prompt in input"
                    : "conversation rewound");
            }
            ctx.ui.notify(`✓ ${parts.join(", ")}`, "info");
        },
    });
    // ------------------------------------------------------------------
    // Command: /undo-rewind — undo the last restore
    // ------------------------------------------------------------------
    pi.registerCommand("undo-rewind", {
        description: "Undo the last /rewind restore",
        handler: async (_args, ctx) => {
            if (!state) {
                ctx.ui.notify("Rewind not initialized", "error");
                return;
            }
            // Find restore events. Only /rewind actions (kind "restore") are
            // undoable; /undo-rewind events (kind "undo") are not.
            const entries = ctx.sessionManager.getEntries();
            const restoreEntries = entries.filter((e) => e.customType === ENTRY_TYPE_RESTORE &&
                e.data.kind === "restore");
            if (restoreEntries.length === 0) {
                ctx.ui.notify("No restore to undo", "warning");
                return;
            }
            const lastRestore = restoreEntries.at(-1);
            const event = lastRestore.data;
            // Guard against repeated undo: if an undo entry for this restore
            // already exists, the restore has already been reversed.
            const entryId = lastRestore.id;
            const alreadyUndone = entries.some((e) => e.customType === ENTRY_TYPE_RESTORE &&
                e.data.kind === "undo" &&
                e.data.entryId === entryId);
            if (alreadyUndone) {
                ctx.ui.notify("Last restore already undone", "warning");
                return;
            }
            const confirmed = await ctx.ui.confirm("Undo restore", `Undo the last ${event.mode} restore?`);
            if (!confirmed)
                return;
            let filesChanged = [];
            // Restore code if we have a pre-restore snapshot
            if ((event.mode === "code" || event.mode === "both") &&
                event.preRestoreSnapshot) {
                filesChanged = await restoreFiles(event.preRestoreSnapshot);
            }
            // Restore conversation
            if ((event.mode === "conversation" || event.mode === "both") &&
                event.preRestoreEntryId &&
                ctx.navigateTree) {
                await ctx.navigateTree(event.preRestoreEntryId);
            }
            // Record the undo so a second /undo-rewind no-ops instead of
            // re-applying the pre-restore snapshot and clobbering new edits.
            pi.appendEntry(ENTRY_TYPE_RESTORE, {
                entryId,
                mode: event.mode,
                preRestoreEntryId: event.preRestoreEntryId,
                preRestoreSnapshot: event.preRestoreSnapshot,
                timestamp: Date.now(),
                kind: "undo",
            });
            const parts = [];
            if (filesChanged.length > 0) {
                parts.push(`${filesChanged.length} file(s) restored`);
            }
            if (event.mode === "conversation" || event.mode === "both") {
                parts.push("conversation restored");
            }
            ctx.ui.notify(`✓ Undo: ${parts.join(", ")}`, "info");
        },
    });
    // ------------------------------------------------------------------
    // Command: /rewind-status — show current state
    // ------------------------------------------------------------------
    pi.registerCommand("rewind-status", {
        description: "Show rewind snapshot status",
        handler: async (_args, ctx) => {
            if (!state) {
                ctx.ui.notify("Rewind not initialized", "error");
                return;
            }
            const points = getRestorePoints(ctx);
            const totalFiles = state.fileVersions.size;
            const totalVersions = Array.from(state.fileVersions.values()).reduce((a, b) => a + b, 0);
            const lines = [
                `Session: ${state.sessionId.slice(0, 8)}…`,
                `Restore points: ${points.length}`,
                `Tracked files: ${totalFiles}`,
                `Total backups: ${totalVersions}`,
                "",
                "Restore points:",
                ...points.map((p, i) => `  ${i + 1}. ${p.label}  (${p.preview})`),
            ];
            ctx.ui.notify(lines.join("\n"), "info");
        },
    });
    // ------------------------------------------------------------------
    // Command: /rewind-gc — manual garbage collection
    // ------------------------------------------------------------------
    pi.registerCommand("rewind-gc", {
        description: "Clean up old rewind snapshots (>7 days)",
        handler: async (_args, ctx) => {
            const cleaned = await garbageCollect();
            ctx.ui.notify(cleaned > 0
                ? `Cleaned up ${cleaned} old session(s)`
                : "Nothing to clean up", "info");
        },
    });
}
