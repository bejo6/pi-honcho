#!/usr/bin/env node
/**
 * pi-honcho — persistent memory for Pi, powered by Honcho (honcho.dev).
 *
 * A Pi extension port of zcode-honcho (itself a port of dsh-honcho), keeping
 * the same memory loop aligned across integrations:
 *
 *   capture every turn → queue on disk (secrets redacted) → flush at turn
 *   boundaries → inject a memory block per prompt with TTL refresh + dialectic
 *   cadence → expose honcho_search / honcho_chat / honcho_remember /
 *   honcho_status / honcho_flush as agent tools → `/honcho` command.
 *
 * Reads the same `~/.honcho/config.json` as the other Honcho integrations
 * (hosts.pi block). Everything is in-process — no detached hook processes, no
 * stdio MCP server.
 */

import { loadConfig, sessionUrl, SESSION_STRATEGIES } from "./lib/config.mjs";
import { Gateway } from "./lib/gateway.mjs";
import { flushAll } from "./lib/flush.mjs";
import {
  appendMessage,
  pendingCount,
  readStatus,
  writeStatus,
} from "./lib/state.mjs";
import { redactSecrets } from "./lib/redact.mjs";
import { isHarnessInjected, summarizeTool } from "./lib/capture-helpers.mjs";
import {
  handlePerTurnInject,
  handleSessionStart,
  withTimeout,
} from "./lib/inject.mjs";

const PLUGIN_VERSION = "0.1.0";
const FLUSH_BUDGET_MS = 25_000;

/** The extension API shape of `pi` (loose, .mjs — no build step). */
let pi = null;
/** One config load per process; re-read on demand after /honcho config edits. */
let cachedConfig = null;

function config(force = false) {
  if (!cachedConfig || force) {
    try {
      cachedConfig = loadConfig();
    } catch (error) {
      // e.g. unknown sessionStrategy — report it through status surfaces.
      cachedConfig = { enabled: false, configError: error instanceof Error ? error.message : String(error) };
    }
  }
  return cachedConfig;
}

function captureReady(c) {
  return c.enabled && c.apiKey && c.capture?.saveMessages;
}

function ago(at) {
  if (!at) return "never";
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/** Model id for the telemetry header, from whatever context is at hand. */
function modelId(ctx) {
  return ctx?.model?.id ?? pi?.model?.id ?? undefined;
}

// ── capture ────────────────────────────────────────────────────────────────

function captureUser(c, { sessionId, cwd }, text) {
  if (!captureReady(c)) return;
  if (!text.trim() || isHarnessInjected(text)) return;
  const cap = c.messageUpload.maxUserTokens * 4;
  appendMessage(sessionId, {
    role: "user",
    peerId: c.peerName,
    content: redactSecrets(text.slice(0, cap), c.capture.noisePatterns),
    cwd,
    session_id: sessionId,
    at: Date.now(),
  });
}

function captureAssistant(c, { sessionId, cwd }, text) {
  if (!captureReady(c) || !text.trim()) return;
  const cap = c.messageUpload.maxAssistantTokens * 4;
  appendMessage(sessionId, {
    role: "assistant",
    peerId: c.aiPeer,
    content: redactSecrets(text.slice(0, cap), c.capture.noisePatterns),
    cwd,
    session_id: sessionId,
    at: Date.now(),
  });
}

function captureTool(c, { sessionId, cwd }, name, args) {
  if (!c.enabled || !c.apiKey || !c.capture.saveToolUse || !c.capture.saveMessages) return;
  const summary = summarizeTool(name, args && typeof args === "object" ? args : {});
  if (!summary) return;
  const cap = c.messageUpload.maxAssistantTokens * 4;
  appendMessage(sessionId, {
    role: "assistant",
    peerId: c.aiPeer,
    content: redactSecrets(`[tool] ${summary}`.slice(0, cap), c.capture.noisePatterns),
    cwd,
    session_id: sessionId,
    at: Date.now(),
  });
}

async function flush(c) {
  if (!c.enabled || !c.apiKey) return;
  try {
    await withTimeout(flushAll({ config: c, timeoutMs: FLUSH_BUDGET_MS }), FLUSH_BUDGET_MS + 2_000);
  } catch {
    // Flushing must never break a turn; the queue retries next boundary.
  }
}

// ── tools ──────────────────────────────────────────────────────────────────

function text(result) {
  return { content: [{ type: "text", text: result.text ?? String(result) }], details: {} };
}

function statusText(c, cwd = process.cwd()) {
  const name = new Gateway(c).currentSessionName(cwd);
  const status = readStatus();
  const dashboard = sessionUrl(c.workspace, name, c.guiBase);
  const lines = [
    `pi-honcho ${PLUGIN_VERSION}`,
    `enabled: ${c.enabled ? "yes" : "no (config.enabled)"}`,
    ...(c.configError ? [`config error: ${c.configError}`] : []),
    `api key: ${c.apiKey ? "configured" : "MISSING — set HONCHO_API_KEY or auth.apiKey in the config"}`,
    `peer: ${c.peerName} · ai peer: ${c.aiPeer} · mode: ${c.observationMode}`,
    `workspace: ${c.workspace}`,
    `server: ${c.baseUrl}`,
    `session: ${name} (strategy ${c.sessionStrategy}; cwd ${cwd})`,
    ...(dashboard ? [`dashboard: ${dashboard}`] : []),
    `capture: ${c.capture?.saveMessages ? `on${c.capture?.saveToolUse ? " +tools" : ""}` : "off"} · ${pendingCount()} message(s) pending`,
    `injection: sessionStart [${c.injection?.sessionStart?.join(", ")}] · perTurn [${c.injection?.perTurn?.join(", ") || "none"}]`,
    `last memory fetch: ${ago(status.lastFetchAt)}${status.lastFetchError ? ` — error: ${status.lastFetchError}` : ""}`,
    `last sync: ${ago(status.lastFlushedAt)}${status.lastError ? ` — error: ${status.lastError}` : ""}`,
    `config file: ${c.configFile ?? "~/.honcho/config.json"}`,
    `session strategies available: ${SESSION_STRATEGIES.join(", ")}`,
  ];
  return lines.join("\n");
}

/**
 * Plain JSON Schema parameter definitions. Pi validates tool arguments as
 * JSON Schema regardless of what built them, so there is no typebox import —
 * the extension stays zero-dependency under plain `node`.
 */
const schema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const QUERY_SCHEMA = schema({
  query: { type: "string", description: "The search query to find relevant information from past sessions." },
  limit: { type: "number", description: "Results per source (default 5, max 10)." },
}, ["query"]);
const CHAT_SCHEMA = schema(
  { query: { type: "string", description: "The question to ask about the user based on their history." } },
  ["query"],
);
const REMEMBER_SCHEMA = schema(
  { content: { type: "string", description: "The information to remember about the user for future sessions." } },
  ["content"],
);
const EMPTY_SCHEMA = schema({});

function registerTools() {
  const c = config();

  pi.registerTool({
    name: "honcho_search",
    label: "Honcho Search",
    description:
      "Search the user's Honcho memory across all past sessions. Returns both raw messages and derived " +
      "conclusions. Use when you need history beyond what was already injected into context.",
    promptSnippet: "Search Honcho memory (messages + conclusions)",
    promptGuidelines: [
      "Use honcho_search when you need history about the user beyond what was already injected into context.",
    ],
    parameters: QUERY_SCHEMA,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const query = String(params?.query ?? "").trim();
      if (!query) return text({ text: "Search query was empty." });
      const limit = Math.min(Math.max(Number(params?.limit) || 5, 1), 10);
      const cfg = config();
      if (!cfg.enabled || !cfg.apiKey) return text({ text: "Honcho memory is disabled or has no API key." });
      const gateway = new Gateway(cfg, { timeoutMs: cfg.timeoutMs, model: modelId(ctx) });
      // Both layers, in parallel. Messages alone miss everything the Deriver
      // and Dreamer inferred; conclusions alone miss what was actually said.
      const [messages, conclusions] = await Promise.allSettled([
        gateway.searchMessages(query, limit),
        gateway.searchConclusions(query, limit),
      ]);
      const lines = [];
      if (messages.status === "fulfilled") lines.push(...messages.value);
      else lines.push(`[message search failed: ${messages.reason?.message ?? messages.reason}]`);
      if (conclusions.status === "fulfilled") lines.push(...conclusions.value);
      else lines.push(`[conclusion search failed: ${conclusions.reason?.message ?? conclusions.reason}]`);
      return text({ text: lines.length ? lines.join("\n") : "No results in messages or conclusions." });
    },
  });

  pi.registerTool({
    name: "honcho_chat",
    label: "Honcho Chat",
    description:
      "Ask Honcho a reasoned question about the user, answered over everything it has learned across all " +
      "sessions. Use for questions of judgment or preference — how they like to work, what they would " +
      "prefer — rather than for looking up something that was said. Slow: 30s to minutes.",
    promptSnippet: "Reasoned question about the user over all Honcho memory",
    promptGuidelines: [
      "Use honcho_chat for questions of judgment about the user (preferences, working style), not for looking up facts.",
    ],
    parameters: CHAT_SCHEMA,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const query = String(params?.query ?? "").trim();
      if (!query) return text({ text: "Question was empty." });
      const cfg = config();
      if (!cfg.enabled || !cfg.apiKey) return text({ text: "Honcho memory is disabled or has no API key." });
      const gateway = new Gateway(cfg, { timeoutMs: cfg.timeoutMs, model: modelId(ctx) });
      const answer = await gateway.chat(query);
      return text({ text: answer || "Honcho has nothing relevant on that yet." });
    },
  });

  pi.registerTool({
    name: "honcho_remember",
    label: "Honcho Remember",
    description:
      "Save a durable fact, preference, or decision about the user to Honcho so it survives into future " +
      "sessions. Use when the user states something worth carrying forward, not for transient task detail. " +
      "One fact per call, phrased to still make sense months from now.",
    promptSnippet: "Save a durable fact about the user to Honcho",
    promptGuidelines: [
      "Use honcho_remember when the user states a durable preference, decision, or fact worth carrying to a future session.",
    ],
    parameters: REMEMBER_SCHEMA,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const content = String(params?.content ?? "").trim();
      if (!content) return text({ text: "Nothing to remember — `content` was empty." });
      const cfg = config();
      if (!cfg.enabled || !cfg.apiKey) return text({ text: "Honcho memory is disabled or has no API key." });
      const gateway = new Gateway(cfg, { timeoutMs: cfg.timeoutMs, model: modelId(ctx) });
      const cwd = ctx?.sessionManager?.getCwd() ?? process.cwd();
      const session = await gateway.remember(content, cwd);
      return text({ text: `Saved to Honcho memory (session ${session}).` });
    },
  });

  pi.registerTool({
    name: "honcho_status",
    label: "Honcho Status",
    description:
      "Report the Honcho memory integration's live status: enabled state, peer and workspace, the resolved " +
      "session for the current directory, capture queue depth, and the last sync/fetch with any errors.",
    parameters: EMPTY_SCHEMA,
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      return text({ text: statusText(config(true), ctx?.sessionManager?.getCwd() ?? process.cwd()) });
    },
  });

  pi.registerTool({
    name: "honcho_flush",
    label: "Honcho Flush",
    description: "Upload everything currently queued by turn capture to Honcho immediately.",
    parameters: EMPTY_SCHEMA,
    async execute() {
      const cfg = config();
      const result = await flushAll({ config: cfg });
      if (!result.files) return text({ text: "Nothing pending — the capture queue is empty." });
      const parts = [`uploaded ${result.uploaded} message(s)`];
      if (result.failed) parts.push(`${result.failed} deferred (will retry): ${result.error ?? "unknown error"}`);
      return text({ text: parts.join("; ") + "." });
    },
  });
}

// ── extension ──────────────────────────────────────────────────────────────

export default function activate(extensionApi) {
  pi = extensionApi;

  pi.registerCommand("honcho", {
    description: "Honcho memory: status, resolved config, or force a sync",
    handler: async (args, ctx) => {
      const sub = String(args ?? "").trim().split(/\s+/)[0] || "status";
      const c = config(true);
      if (!c.enabled || !c.apiKey) {
        ctx.ui.notify(
          `Honcho memory is OFF — ${c.configError ?? "set HONCHO_API_KEY or auth.apiKey in ~/.honcho/config.json"}`,
          "warning",
        );
        return;
      }
      if (sub === "flush") {
        ctx.ui.setStatus("honcho", "flushing…");
        const result = await flushAll({ config: c });
        ctx.ui.setStatus("honcho", undefined);
        ctx.ui.notify(
          result.files
            ? `Honcho: uploaded ${result.uploaded} message(s)` +
                (result.failed ? `, ${result.failed} deferred — ${result.error ?? "unknown error"}` : "")
            : "Honcho: nothing pending — capture queue is empty.",
          result.failed ? "warning" : "info",
        );
        return;
      }
      // status / config — show the same resolved view either way.
      ctx.ui.notify(statusText(c), "info");
    },
  });

  registerTools();

  // ── session lifecycle ──

  pi.on("session_start", async (event, ctx) => {
    const c = config(true);
    if (!c.enabled || !c.apiKey) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const cwd = ctx.sessionManager.getCwd();
    writeStatus({ lastSession: sessionId });
    try {
      const directives = await handleSessionStart(c, { cwd, sessionId, model: modelId(ctx) });
      if (directives) {
        pi.sendMessage({
          customType: "honcho-memory",
          content: directives,
          display: false,
        });
      }
    } catch (error) {
      writeStatus({ lastFetchError: error instanceof Error ? error.message : String(error) });
    }
  });

  // ── per-turn capture + inject ──
  // before_agent_start is the UserPromptSubmit equivalent: it sees the user's
  // prompt and its returned message lands in context ahead of the run.

  pi.on("before_agent_start", async (event, ctx) => {
    const c = config();
    if (event.messageType !== "user") return;
    const sessionId = ctx.sessionManager.getSessionId();
    const cwd = ctx.sessionManager.getCwd();

    captureUser(c, { sessionId, cwd }, event.prompt ?? "");

    const injected = await handlePerTurnInject(c, { cwd, sessionId, model: modelId(ctx) }, event.prompt ?? "");
    if (injected) {
      return {
        message: {
          customType: "honcho-memory",
          content: injected,
          display: false,
        },
      };
    }
  });

  // ── assistant capture ──
  // message_end sees every finalized message; take assistant text only.

  pi.on("message_end", async (event, ctx) => {
    const c = config();
    if (event.message?.role !== "assistant") return;
    const blocks = Array.isArray(event.message.content) ? event.message.content : [];
    const textOut = blocks
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
    if (!textOut.trim()) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const cwd = ctx.sessionManager.getCwd();
    captureAssistant(c, { sessionId, cwd }, textOut);
  });

  // ── tool capture (optional, capture.saveToolUse) ──

  pi.on("tool_execution_start", async (event, ctx) => {
    const c = config();
    const sessionId = ctx.sessionManager.getSessionId();
    const cwd = ctx.sessionManager.getCwd();
    captureTool(c, { sessionId, cwd }, event.toolName, event.args);
  });

  // ── flush at turn boundaries ──
  // agent_settled is final idle: no more retries or continuations follow.

  pi.on("agent_settled", async (_event, ctx) => {
    const c = config();
    writeStatus({ lastSession: ctx.sessionManager.getSessionId() });
    // Non-blocking: fire and forget so settling is never delayed.
    flush(c);
  });

  // Drain what's left when the session goes away.
  pi.on("session_shutdown", async (_event, ctx) => {
    const c = config();
    await flush(c);
  });
}
