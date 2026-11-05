/**
 * The flush routine: upload the capture queue to Honcho and clear what made it.
 *
 * Failures are the expected case — Honcho can be down, the key can be wrong —
 * so the only invariant is the one durability needs: a queue file is deleted
 * ONLY after its upload succeeded, and every failure lands in status.json
 * where `/honcho` surfaces it.
 */

import { takeQueueFile, listQueueFiles, writeStatus, readStatus } from "./state.mjs";
import { loadConfig } from "./config.mjs";
import { Gateway } from "./gateway.mjs";

export async function flushAll(options = {}) {
  const config = options.config ?? loadConfig();
  const files = listQueueFiles();
  if (!files.length) return { files: 0, uploaded: 0, failed: 0 };

  // The hook budget, not just the client timeout: a flush that outlives its
  // hook is killed mid-upload and retries next turn.
  const gateway = new Gateway(config, {
    timeoutMs: Math.min(config.timeoutMs, options.timeoutMs ?? 25_000),
  });

  let uploaded = 0;
  let failed = 0;
  let lastError;
  const uploadedNames = new Set();

  for (const file of files) {
    const taken = takeQueueFile(file);
    if (!taken) continue;
    const { messages, commit, release } = taken;

    if (!messages.length) {
      commit();
      continue;
    }
    if (!config.enabled || !config.apiKey || !config.capture.saveMessages) {
      // Plugin turned off after capture: drop the queue rather than grow it.
      commit();
      continue;
    }

    // One file may span several cwd→session mappings if the user switched
    // projects mid-session; upload each group to its own session.
    const groups = new Map();
    for (const message of messages) {
      const name = gateway.currentSessionName(message.cwd, message.session_id);
      if (!groups.has(name)) groups.set(name, { cwd: message.cwd, sessionId: message.session_id, messages: [] });
      groups.get(name).messages.push(message);
    }

    try {
      for (const [name, group] of groups) {
        if (!uploadedNames.has(name)) {
          await gateway.ensureSession(group.cwd, group.sessionId);
          uploadedNames.add(name);
        }
        await gateway.upload(name, group.messages);
      }
      commit();
      uploaded += messages.length;
      writeStatus({ lastFlushedAt: Date.now(), lastError: undefined });
    } catch (error) {
      release();
      failed += messages.length;
      lastError = error instanceof Error ? error.message : String(error);
      writeStatus({ lastError, lastFailedAt: Date.now() });
      // Keep going: one dead session name must not starve the others.
    }
  }

  return { files: files.length, uploaded, failed, error: lastError };
}

/** One-line summary for status output. */
export function lastSyncLine() {
  const status = readStatus();
  const at = status.lastFlushedAt;
  const when = at ? ago(at) : "never";
  return { when, lastError: status.lastError, lastFetchAt: status.lastFetchAt, lastFetchError: status.lastFetchError };
}

function ago(at) {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}
