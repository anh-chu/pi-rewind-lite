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
import {
	copyFile,
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	unlink,
	writeFile,
	appendFile,
	chmod,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import {
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SelectItem,
	SelectList,
	Text,
} from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXTENSION_NAME = "pi-rewind-lite";
const STORAGE_ROOT = join(homedir(), ".pi", "rewind-lite");
const DEFAULT_CLEANUP_DAYS = 30;
const DEFAULT_MAX_FILE_MB = 10;
const ENTRY_TYPE_SNAPSHOT = "rewind-lite-snapshot";
const ENTRY_TYPE_RESTORE = "rewind-lite-restore";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface RewindConfig {
	/** Days before session data is auto-cleaned. Default: 30. */
	cleanupDays: number;
	/** Skip files larger than this (MB). Default: 10. */
	maxFileMB: number;
}

const CONFIG_PATH = join(homedir(), ".pi", "rewind-lite.json");
let config: RewindConfig = {
	cleanupDays: DEFAULT_CLEANUP_DAYS,
	maxFileMB: DEFAULT_MAX_FILE_MB,
};

async function loadConfig(): Promise<void> {
	try {
		const raw = await readFile(CONFIG_PATH, "utf-8");
		const parsed = JSON.parse(raw);
		if (typeof parsed.cleanupDays === "number" && parsed.cleanupDays > 0) {
			config.cleanupDays = parsed.cleanupDays;
		}
		if (typeof parsed.maxFileMB === "number" && parsed.maxFileMB > 0) {
			config.maxFileMB = parsed.maxFileMB;
		}
	} catch {
		// No config file or invalid JSON — use defaults
	}
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A backup of a single file before it was modified. */
interface FileBackup {
	/** Relative path from cwd */
	trackingPath: string;
	/** Backup file name in the backups/ dir, or null if file didn't exist */
	backupFileName: string | null;
	/** Version counter for this file in this session */
	version: number;
	/** Unix timestamp */
	timestamp: number;
}

/** A snapshot captures the state of all tracked files at a conversation point. */
interface Snapshot {
	/** The session entry ID this snapshot is associated with */
	entryId: string;
	/** All file backups at this point */
	files: Record<string, FileBackup>;
	/** When this snapshot was created */
	timestamp: number;
	/** Human-readable label (first ~80 chars of user prompt) */
	label?: string;
}

/** In-memory state for the current session. */
interface RewindState {
	sessionId: string;
	sessionDir: string;
	backupsDir: string;
	cwd: string;
	/** All snapshots in chronological order */
	snapshots: Snapshot[];
	/** Files we've backed up and their current version */
	fileVersions: Map<string, number>;
	/** Set of files we've already backed up for the current turn */
	pendingBackups: Set<string>;
	/** Current turn's entry ID */
	currentEntryId: string | null;
}

interface RestoreEvent {
	entryId: string;
	mode: "code" | "conversation" | "both";
	preRestoreEntryId: string;
	preRestoreSnapshot: Snapshot | null;
	timestamp: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let state: RewindState | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toTrackingPath(filePath: string, cwd: string): string {
	if (!isAbsolute(filePath)) return filePath;
	const abs = resolve(filePath);
	if (abs.startsWith(cwd + "/") || abs.startsWith(cwd + "\\")) {
		return relative(cwd, abs);
	}
	return abs;
}

function toAbsolutePath(trackingPath: string, cwd: string): string {
	if (isAbsolute(trackingPath)) return trackingPath;
	return join(cwd, trackingPath);
}

function hashPath(trackingPath: string): string {
	return createHash("sha256").update(trackingPath).digest("hex").slice(0, 16);
}

function backupFileName(trackingPath: string, version: number): string {
	return `${hashPath(trackingPath)}@v${version}`;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function getFileSize(path: string): Promise<number | null> {
	try {
		const s = await stat(path);
		return s.size;
	} catch {
		return null;
	}
}

function truncateLabel(text: string | undefined, max = 80): string {
	if (!text) return "(empty)";
	const clean = text.replace(/\s+/g, " ").trim();
	if (clean.length <= max) return clean;
	return clean.slice(0, max - 1) + "…";
}

// ---------------------------------------------------------------------------
// Core: Backup a file before edit
// ---------------------------------------------------------------------------

async function backupFile(
	trackingPath: string,
): Promise<FileBackup | null> {
	if (!state) return null;

	// Already backed up this file for the current turn
	if (state.pendingBackups.has(trackingPath)) return null;
	state.pendingBackups.add(trackingPath);

	const absPath = toAbsolutePath(trackingPath, state.cwd);

	// Check file size — skip huge files
	const maxBytes = config.maxFileMB * 1024 * 1024;
	const size = await getFileSize(absPath);
	if (size !== null && size > maxBytes) return null;

	const version = (state.fileVersions.get(trackingPath) ?? 0) + 1;
	const bkName = backupFileName(trackingPath, version);
	const bkPath = join(state.backupsDir, bkName);

	let backupName: string | null;

	if (size === null) {
		// File doesn't exist yet — record null (it's a new file being created)
		backupName = null;
	} else {
		// Copy the file before it gets modified
		try {
			await copyFile(absPath, bkPath);
			// Preserve permissions
			const s = await stat(absPath);
			await chmod(bkPath, s.mode);
			backupName = bkName;
		} catch {
			// If copy fails, skip silently — don't block the tool
			return null;
		}
	}

	state.fileVersions.set(trackingPath, version);

	const backup: FileBackup = {
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

async function createSnapshot(entryId: string, label?: string): Promise<void> {
	if (!state) return;

	// Build file map from the latest snapshot + any new backups from this turn
	const prevSnapshot = state.snapshots.at(-1);
	const files: Record<string, FileBackup> = {};

	// Carry forward all previously tracked files
	if (prevSnapshot) {
		for (const [path, backup] of Object.entries(prevSnapshot.files)) {
			files[path] = backup;
		}
	}

	const snapshot: Snapshot = {
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
	} catch {
		// Non-fatal
	}
}

function updateCurrentSnapshot(backup: FileBackup): void {
	if (!state) return;
	const current = state.snapshots.at(-1);
	if (!current) return;
	current.files[backup.trackingPath] = backup;

	// Async persist update (fire-and-forget)
	const journalPath = join(state.sessionDir, "snapshots.jsonl");
	const lines = state.snapshots.map((s) => JSON.stringify(s)).join("\n") + "\n";
	writeFile(journalPath, lines).catch(() => {});
}

// ---------------------------------------------------------------------------
// Core: Restore
// ---------------------------------------------------------------------------

async function restoreFiles(targetSnapshot: Snapshot): Promise<string[]> {
	if (!state) return [];

	const changed: string[] = [];

	// Get all tracked files across all snapshots
	const allTrackedPaths = new Set<string>();
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
			const firstTrackedSnapshot = state.snapshots.find(
				(s) => s.files[trackingPath] && s.files[trackingPath].backupFileName === null,
			);
			if (
				firstTrackedSnapshot &&
				firstTrackedSnapshot.timestamp > targetSnapshot.timestamp
			) {
				// File was created after target — delete it
				try {
					await unlink(absPath);
					changed.push(trackingPath);
				} catch {
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
				} catch {}
			}
			continue;
		}

		// Restore from backup
		const bkPath = join(state.backupsDir, targetBackup.backupFileName);
		if (!(await fileExists(bkPath))) continue;

		// Check if file actually differs
		try {
			const [currentContent, backupContent] = await Promise.all([
				readFile(absPath, "utf-8").catch(() => null),
				readFile(bkPath, "utf-8"),
			]);
			if (currentContent === backupContent) continue;
		} catch {
			// If we can't read, try to restore anyway
		}

		try {
			await mkdir(dirname(absPath), { recursive: true });
			await copyFile(bkPath, absPath);
			const bkStats = await stat(bkPath);
			await chmod(absPath, bkStats.mode);
			changed.push(trackingPath);
		} catch {
			// Non-fatal
		}
	}

	return changed;
}

/** Capture current state as a pre-restore snapshot for undo. */
async function captureCurrentState(): Promise<Snapshot | null> {
	if (!state) return null;

	const files: Record<string, FileBackup> = {};
	const allPaths = new Set<string>();
	for (const snap of state.snapshots) {
		for (const p of Object.keys(snap.files)) allPaths.add(p);
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
		} catch {
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

async function garbageCollect(): Promise<number> {
	let cleaned = 0;
	const maxAgeMs = config.cleanupDays * 24 * 60 * 60 * 1000;
	try {
		const sessions = await readdir(STORAGE_ROOT);
		const now = Date.now();
		for (const sessionDir of sessions) {
			const sessionPath = join(STORAGE_ROOT, sessionDir);
			try {
				const s = await stat(sessionPath);
				if (!s.isDirectory()) continue;
				if (now - s.mtimeMs > maxAgeMs) {
					await rm(sessionPath, { recursive: true, force: true });
					cleaned++;
				}
			} catch {
				// Skip
			}
		}
	} catch {
		// Storage root doesn't exist yet
	}
	return cleaned;
}

// ---------------------------------------------------------------------------
// State initialization
// ---------------------------------------------------------------------------

async function initState(sessionId: string, cwd: string): Promise<void> {
	await loadConfig();
	const sessionDir = join(STORAGE_ROOT, sessionId);
	const backupsDir = join(sessionDir, "backups");

	await mkdir(backupsDir, { recursive: true });

	// Try to restore from journal
	const snapshots: Snapshot[] = [];
	const fileVersions = new Map<string, number>();
	const journalPath = join(sessionDir, "snapshots.jsonl");

	try {
		const data = await readFile(journalPath, "utf-8");
		for (const line of data.split("\n").filter(Boolean)) {
			try {
				const snap = JSON.parse(line) as Snapshot;
				snapshots.push(snap);
				for (const [path, backup] of Object.entries(snap.files)) {
					const current = fileVersions.get(path) ?? 0;
					if (backup.version > current) {
						fileVersions.set(path, backup.version);
					}
				}
			} catch {
				// Skip corrupt lines
			}
		}
	} catch {
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

function getRestorePoints(
	ctx: ExtensionContext,
): Array<{ entryId: string; snapshot: Snapshot; label: string; preview: string }> {
	if (!state) return [];

	const points: Array<{
		entryId: string;
		snapshot: Snapshot;
		label: string;
		preview: string;
	}> = [];

	// Get unique entry IDs from snapshots
	const seen = new Set<string>();
	for (const snapshot of state.snapshots) {
		if (seen.has(snapshot.entryId)) continue;
		seen.add(snapshot.entryId);

		const entry = ctx.sessionManager.getEntry(snapshot.entryId);
		const fileCount = Object.keys(snapshot.files).filter(
			(k) => snapshot.files[k].backupFileName !== null,
		).length;

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

function formatTimeAgo(timestamp: number): string {
	const diff = Date.now() - timestamp;
	const mins = Math.floor(diff / 60000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function getLastUserPrompt(
	ctx: ExtensionContext,
	entryId: string,
): string | undefined {
	const branch = ctx.sessionManager.getBranch(entryId);
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (
			entry.type === "message" &&
			"message" in entry &&
			(entry as any).message?.role === "user"
		) {
			const msg = (entry as any).message;
			if (typeof msg.content === "string") return msg.content;
			if (Array.isArray(msg.content)) {
				const textBlock = msg.content.find(
					(b: any) => b.type === "text" && typeof b.text === "string",
				);
				if (textBlock) return textBlock.text;
			}
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function activate(pi: ExtensionAPI): void {
	// ------------------------------------------------------------------
	// Lifecycle: session_start — GC + init
	// ------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		// Fire-and-forget GC
		garbageCollect().catch(() => {});

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
			const filePath = (event.input as { path?: string }).path;
			if (!filePath) return;

			const trackingPath = toTrackingPath(filePath, state.cwd);
			const backup = await backupFile(trackingPath);
			if (backup) {
				updateCurrentSnapshot(backup);
			} else {
			}
		}
	});

	// ------------------------------------------------------------------
	// Lifecycle: agent_end — finalize turn, reset pending set
	// ------------------------------------------------------------------

	pi.on("agent_end", async (_event, _ctx) => {
		if (!state) return;
		state.pendingBackups.clear();
		state.currentEntryId = null;
	});

	// ------------------------------------------------------------------
	// Command: /rewind — 3-way restore
	// ------------------------------------------------------------------

	pi.registerCommand("rewind", {
		description: "Restore code and/or conversation to a previous point",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
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
			const items: SelectItem[] = points.map((p, i) => ({
				value: String(i),
				label: p.label,
				description: p.preview,
			}));

			const latestIndex = items.length - 1;

			const selected = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
				container.addChild(
					new Text(theme.fg("accent", theme.bold("Rewind to which point?"))),
				);

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

				container.addChild(
					new Text(
						theme.fg("dim", "↑↓ navigate • enter select • esc cancel"),
					),
				);
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

			if (selected === null) return;

			const selectedIndex = Number(selected);
			if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= points.length) {
				return;
			}

			const point = points[selectedIndex];

			// Step 2: Pick restore mode
			const canRestoreCode = Object.keys(point.snapshot.files).length > 0;
			const modeOptions = canRestoreCode
				? [
						"Restore code and conversation",
						"Restore conversation only",
						"Restore code only",
						"Cancel",
				  ]
				: ["Restore conversation only", "Cancel"];

			const modeChoice = await ctx.ui.select("How to restore?", modeOptions);
			if (!modeChoice || modeChoice === "Cancel") return;

			let mode: "both" | "conversation" | "code";
			if (modeChoice.includes("code and conversation")) {
				mode = "both";
			} else if (modeChoice.includes("code only")) {
				mode = "code";
			} else {
				mode = "conversation";
			}

			// Step 3: Confirm
			const confirmed = await ctx.ui.confirm(
				"Confirm restore",
				`Restore ${mode === "both" ? "code + conversation" : mode} to: "${point.label}"?`,
			);
			if (!confirmed) return;

			// Step 4: Capture pre-restore state for undo
			const preRestoreEntryId = ctx.sessionManager.getLeafId();
			const preRestoreSnapshot = await captureCurrentState();

			// Step 5: Execute restore
			let filesChanged: string[] = [];

			if (mode === "code" || mode === "both") {
				filesChanged = await restoreFiles(point.snapshot);
			}

			if (mode === "conversation" || mode === "both") {
				if (ctx.navigateTree) {
					await ctx.navigateTree(point.entryId);
				}
			}

			// Step 6: Record the restore event for undo
			const restoreEvent: RestoreEvent = {
				entryId: point.entryId,
				mode,
				preRestoreEntryId: preRestoreEntryId ?? "",
				preRestoreSnapshot,
				timestamp: Date.now(),
			};
			pi.appendEntry(ENTRY_TYPE_RESTORE, restoreEvent);

			// Step 7: Notify
			const parts: string[] = [];
			if (filesChanged.length > 0) {
				parts.push(`${filesChanged.length} file(s) restored`);
			}
			if (mode === "conversation" || mode === "both") {
				parts.push("conversation rewound");
			}
			ctx.ui.notify(
				`✓ ${parts.join(", ")}`,
				"info",
			);
		},
	});

	// ------------------------------------------------------------------
	// Command: /undo-rewind — undo the last restore
	// ------------------------------------------------------------------

	pi.registerCommand("undo-rewind", {
		description: "Undo the last /rewind restore",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!state) {
				ctx.ui.notify("Rewind not initialized", "error");
				return;
			}

			// Find last restore event
			const entries = ctx.sessionManager.getEntries();
			const restoreEntries = entries.filter(
				(e: any) => e.customType === ENTRY_TYPE_RESTORE,
			);
			if (restoreEntries.length === 0) {
				ctx.ui.notify("No restore to undo", "warning");
				return;
			}

			const lastRestore = restoreEntries.at(-1)!;
			const event = (lastRestore as any).data as RestoreEvent;

			const confirmed = await ctx.ui.confirm(
				"Undo restore",
				`Undo the last ${event.mode} restore?`,
			);
			if (!confirmed) return;

			let filesChanged: string[] = [];

			// Restore code if we have a pre-restore snapshot
			if (
				(event.mode === "code" || event.mode === "both") &&
				event.preRestoreSnapshot
			) {
				filesChanged = await restoreFiles(event.preRestoreSnapshot);
			}

			// Restore conversation
			if (
				(event.mode === "conversation" || event.mode === "both") &&
				event.preRestoreEntryId &&
				ctx.navigateTree
			) {
				await ctx.navigateTree(event.preRestoreEntryId);
			}

			const parts: string[] = [];
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
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!state) {
				ctx.ui.notify("Rewind not initialized", "error");
				return;
			}

			const points = getRestorePoints(ctx);
			const totalFiles = state.fileVersions.size;
			const totalVersions = Array.from(state.fileVersions.values()).reduce(
				(a, b) => a + b,
				0,
			);

			const lines = [
				`Session: ${state.sessionId.slice(0, 8)}…`,
				`Restore points: ${points.length}`,
				`Tracked files: ${totalFiles}`,
				`Total backups: ${totalVersions}`,
				"",
				"Restore points:",
				...points.map(
					(p, i) => `  ${i + 1}. ${p.label}  (${p.preview})`,
				),
			];

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// ------------------------------------------------------------------
	// Command: /rewind-gc — manual garbage collection
	// ------------------------------------------------------------------

	pi.registerCommand("rewind-gc", {
		description: "Clean up old rewind snapshots (>7 days)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const cleaned = await garbageCollect();
			ctx.ui.notify(
				cleaned > 0
					? `Cleaned up ${cleaned} old session(s)`
					: "Nothing to clean up",
				"info",
			);
		},
	});
}
