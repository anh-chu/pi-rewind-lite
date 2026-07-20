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
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function activate(pi: ExtensionAPI): void;
