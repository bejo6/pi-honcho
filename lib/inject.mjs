/**
 * Hermes / dsh / cursor-honcho / zcode-honcho aligned per-turn injection,
 * ported to Pi's in-process extension model.
 *
 * Turn 1 may wait ~5s for session.context() (+ dialectic when due). Later
 * turns serve the cached block and refresh when the TTL expires. Because the
 * extension lives inside the Pi process, refresh/dialectic are awaited
 * promises bounded by `withTimeout` rather than detached background Node
 * processes — same budgets, no spawn.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { Gateway } from "./gateway.mjs";
import { renderMemory, DIRECTIVES } from "./render.mjs";
import {
  loadConfig,
  FIRST_TURN_BUDGET_MS,
  REFRESH_BUDGET_MS,
  DIALECTIC_BUDGET_MS,
} from "./config.mjs";
import { readMemoryState, writeMemoryState, stateDir } from "./state.mjs";

const TRIVIAL_PROMPT = /^(y|n|yes|no|ok|okay|sure|thanks|thank you|thx|\.|\,)$/i;

export async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function logLine(message) {
  try {
    const path = join(stateDir(), "hook.log");
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${new Date().toISOString()} ${message}\n`, "utf-8");
  } catch {
    // Logging is advisory.
  }
}

function wantsPerTurnRefresh(config) {
  return config.injection.perTurn.includes("userContext");
}

function wantsDialectic(config) {
  return config.injection.perTurn.includes("dialectic");
}

function isStale(state, config) {
  if (!state.lastFetchAt) return true;
  return Date.now() - state.lastFetchAt > config.injection.cadence.ttlSeconds * 1000;
}

function shouldRunDialectic(state, config) {
  if (!wantsDialectic(config)) return false;
  const every = Math.max(1, config.injection.cadence.dialectic);
  return state.turnCount % every === 1 % every;
}

function isTrivial(prompt) {
  return TRIVIAL_PROMPT.test(String(prompt || "").trim());
}

function injectText(config, state) {
  const block = renderMemory(config, state.context, [], state.dialecticText);
  if (!block?.text) return null;
  if (config.injection.sessionStart.includes("directives")) {
    return `${DIRECTIVES}\n\n${block.text}`;
  }
  return block.text;
}

/**
 * Per-turn inject: capture already queued by the caller; fetch (or serve from
 * cache) the memory block like Hermes/dsh. Returns the block text or null.
 *
 * `cwd`/`sessionId` come from the extension context, not hook stdin.
 */
export async function handlePerTurnInject(config, { cwd, sessionId, model }, prompt) {
  if (!config.enabled || !config.apiKey) return null;
  if (!wantsPerTurnRefresh(config) && !wantsDialectic(config)) return null;

  const state = readMemoryState(sessionId);
  state.sessionId = sessionId;
  state.turnCount += 1;
  const first = state.turnCount === 1;
  const trivial = isTrivial(prompt);
  const stale = isStale(state, config);
  const refresh = wantsPerTurnRefresh(config);
  const gateway = new Gateway(config, { timeoutMs: Math.min(config.timeoutMs, REFRESH_BUDGET_MS), model });

  try {
    if (first && !trivial) {
      await withTimeout(
        (async () => {
          state.context = await gateway.fetchContext(cwd, sessionId, prompt);
          state.lastFetchAt = Date.now();
          state.lastError = null;
          if (shouldRunDialectic(state, config)) {
            const answer = await gateway.backgroundDialectic(cwd, sessionId, prompt);
            if (answer) state.dialecticText = answer;
            state.dialecticStartedAt = Date.now();
          }
        })(),
        FIRST_TURN_BUDGET_MS,
      );
    } else if (!trivial && refresh && stale) {
      // In-process refresh with a hard budget — later turns never block past
      // the budget, and a slow Honcho only delays the reply once per TTL.
      try {
        const context = await withTimeout(
          gateway.fetchContext(cwd, sessionId, prompt),
          REFRESH_BUDGET_MS,
        );
        state.context = context;
        state.lastFetchAt = Date.now();
        state.lastError = null;
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error);
        logLine(`refresh turn ${state.turnCount} failed: ${state.lastError}`);
      }
    }
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
    logLine(`inject turn ${state.turnCount} failed: ${state.lastError}`);
  }

  const dialecticCooldown = Date.now() - (state.dialecticStartedAt || 0) < 60_000;
  if (!trivial && shouldRunDialectic(state, config) && !dialecticCooldown) {
    try {
      const answer = await withTimeout(
        gateway.backgroundDialectic(cwd, sessionId, prompt),
        DIALECTIC_BUDGET_MS,
      );
      if (answer) state.dialecticText = answer;
      state.dialecticStartedAt = Date.now();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logLine(`dialectic turn ${state.turnCount} failed: ${message}`);
    }
  }

  writeMemoryState(sessionId, state);
  const additional = injectText(config, state);
  if (additional) {
    logLine(
      `inject turn ${state.turnCount} ${additional.length} chars` +
        (first ? " (first)" : stale && refresh ? " (stale-cache)" : ""),
    );
  }
  return additional;
}

/**
 * Session bootstrap: ensure peers, optionally emit static directives, and
 * warm the per-turn memory cache. Mirrors zcode-honcho's SessionStart hook.
 */
export async function handleSessionStart(config, { cwd, sessionId, model }) {
  if (!config.enabled || !config.apiKey) return null;

  const gateway = new Gateway(config, { timeoutMs: Math.min(config.timeoutMs, 12_000), model });

  try {
    await withTimeout(gateway.ensureSession(cwd, sessionId), 12_000);
  } catch (error) {
    logLine(`sessionStart ensure failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const state = readMemoryState(sessionId);
  state.sessionId = sessionId;
  writeMemoryState(sessionId, state);

  // Warm the cache in the background; turn 1 serves it or fetches itself.
  handlePerTurnRefreshBackground(config, { cwd, sessionId, model }).catch(() => {});

  if (config.injection.sessionStart.includes("directives")) {
    return DIRECTIVES;
  }
  return null;
}

/** Fire-and-forget cache warmer for session start (does not bump turnCount). */
async function handlePerTurnRefreshBackground(config, { cwd, sessionId, model }) {
  if (!config.enabled || !config.apiKey) return;
  if (!wantsPerTurnRefresh(config)) return;

  const state = readMemoryState(sessionId);
  if (state.context && !isStale(state, config)) return; // cache is warm

  const gateway = new Gateway(config, { timeoutMs: Math.min(config.timeoutMs, REFRESH_BUDGET_MS), model });
  try {
    const context = await withTimeout(gateway.fetchContext(cwd, sessionId, ""), REFRESH_BUDGET_MS);
    state.context = context;
    state.lastFetchAt = Date.now();
    state.lastError = null;
    writeMemoryState(sessionId, state);
    logLine(`warm cache ok ${sessionId}`);
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
    writeMemoryState(sessionId, state);
    logLine(`warm cache failed: ${state.lastError}`);
  }
}
