/**
 * On-disk state: the capture queue, the flush status file, and per-session
 * turn state. Everything lives under `$HONCHO_CONFIG_DIR/pi` (default
 * `~/.honcho/pi`), beside the config the other Honcho integrations read.
 *
 * The hook processes are short-lived, so unlike dsh-honcho — which re-derives
 * the unsent slice from the harness's durable event log — the queue IS the
 * durability: append inline at capture time, delete the file only after a
 * successful upload. A crash or failed upload leaves the file in place and the
 * next flush retries it.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, appendFileSync } from "node:fs";

export function stateDir() {
  const base = process.env.HONCHO_CONFIG_DIR || join(homedir(), ".honcho");
  return join(base, "pi");
}

export function queueDir() {
  return join(stateDir(), "queue");
}

function queuePath(sessionId) {
  const safe = String(sessionId ?? "unknown").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "unknown";
  return join(queueDir(), `${safe}.jsonl`);
}

/** Append one captured message. Inline and synchronous — the hook must not
 *  hang the turn on network I/O, so nothing here touches the API. */
export function appendMessage(sessionId, entry) {
  const path = queuePath(sessionId);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf-8");
}

export function readQueueFile(path) {
  const lines = [];
  try {
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object") lines.push(parsed);
      } catch {
        // A torn write on the last line loses one message, not the flush.
      }
    }
  } catch {
    // File vanished between listing and reading: another flusher took it.
  }
  return lines;
}

/** All pending queue files. `.uploading` temp files from a crashed flusher are
 *  left to expire naturally; they are not retried from here. */
export function listQueueFiles() {
  try {
    return readdirSync(queueDir()).filter((f) => f.endsWith(".jsonl")).map((f) => join(queueDir(), f));
  } catch {
    return [];
  }
}

/** Total pending messages, for status. */
export function pendingCount() {
  let count = 0;
  for (const file of listQueueFiles()) count += readQueueFile(file).length;
  return count;
}

/**
 * Atomically take a queue file for upload: rename it out of the queue so a
 * concurrent flusher can't see it, hand back its contents, and let the caller
 * `commit` (delete) or `release` (rename back) it. Windows renames fail over
 * existing targets, so the temp name carries pid + timestamp.
 */
export function takeQueueFile(path) {
  const temp = `${path}.uploading-${process.pid}-${Date.now()}`;
  try {
    renameSync(path, temp);
  } catch {
    return null; // Taken by another flusher, or already gone.
  }
  const messages = readQueueFile(temp);
  return {
    temp,
    messages,
    commit() {
      try {
        rmSync(temp);
      } catch {
        // Already gone is fine.
      }
    },
    release() {
      try {
        renameSync(temp, path);
      } catch {
        // Release failure keeps the payload only in temp; never throw from a
        // failure path — the next flush's status report will show the error.
      }
    },
  };
}

// ── status ─────────────────────────────────────────────────────────────────

function statusPath() {
  return join(stateDir(), "status.json");
}

export function readStatus() {
  try {
    return JSON.parse(readFileSync(statusPath(), "utf-8"));
  } catch {
    return {};
  }
}

export function writeStatus(patch) {
  try {
    const next = { ...readStatus(), ...patch };
    mkdirSync(dirname(statusPath()), { recursive: true });
    writeFileSync(statusPath(), JSON.stringify(next, null, 2), "utf-8");
  } catch {
    // Status is advisory; never fail an operation over it.
  }
}

// ── per-session memory state (Hermes/dsh per-turn cache + cadence) ─────────

function memoryStatePath(sessionId) {
  const safe = String(sessionId ?? "unknown").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "unknown";
  return join(stateDir(), "memory", `${safe}.json`);
}

function emptyMemoryState(sessionId) {
  return {
    sessionId: sessionId || "",
    turnCount: 0,
    lastFetchAt: 0,
    lastError: null,
    context: null,
    dialecticText: null,
    dialecticStartedAt: 0,
    refreshingUntil: 0,
  };
}

export function readMemoryState(sessionId) {
  try {
    const parsed = JSON.parse(readFileSync(memoryStatePath(sessionId), "utf-8"));
    return { ...emptyMemoryState(sessionId), ...parsed, sessionId: sessionId || parsed.sessionId || "" };
  } catch {
    return emptyMemoryState(sessionId);
  }
}

export function writeMemoryState(sessionId, state) {
  try {
    const path = memoryStatePath(sessionId);
    mkdirSync(dirname(path), { recursive: true });
    const next = `${path}.next`;
    writeFileSync(next, JSON.stringify({ ...state, sessionId }, null, 2), "utf-8");
    renameSync(next, path);
  } catch {
    // Losing memory state only costs one cache recompute.
  }
}

/** @deprecated Use readMemoryState — kept for any leftover callers. */
export function readTurnState(sessionId) {
  const state = readMemoryState(sessionId);
  return { turns: state.turnCount, dialectic: state.dialecticText, dialecticAt: state.dialecticStartedAt };
}

/** @deprecated Use writeMemoryState. */
export function writeTurnState(sessionId, state) {
  const current = readMemoryState(sessionId);
  writeMemoryState(sessionId, {
    ...current,
    turnCount: state.turns ?? current.turnCount,
    dialecticText: state.dialectic ?? current.dialecticText,
    dialecticStartedAt: state.dialecticAt ?? current.dialecticStartedAt,
  });
}
