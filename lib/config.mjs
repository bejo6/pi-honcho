/**
 * Canonical `~/.honcho/config.json` resolution — the same contract read by
 * claude-honcho, codex-honcho, dsh-honcho and zcode-honcho. The `hosts.pi`
 * block holds behavior; root holds identity and connection. One file
 * configures every integration, and pointing two of them at the same
 * `workspace` merges their memory.
 *
 * Ported from zcode-honcho's `hooks/lib/config.mjs` (itself ported from
 * dsh-honcho's `src/core-shim.ts`); the only differences are the host key
 * (`pi` instead of `zcode`) and the version manifest source.
 */

import { homedir, platform } from "node:os";
import { basename, join } from "node:path";
import { readFileSync } from "node:fs";
import { currentBranch, originRemote, repoRoot } from "./git.mjs";

export const HOST_DEFAULT = "pi";
export const PLUGIN_ID = "pi-honcho";

/**
 * How a session maps to a Honcho session. Honcho's guidance is not to scope
 * sessions too thin — the background Deriver needs one session to accumulate
 * enough material to reason over — so prefer the wider strategies.
 */
export const SESSION_STRATEGIES = [
  "per-directory",
  "per-repo",
  "git-remote",
  "git-branch",
  "per-session",
  "global",
];

export const SESSION_START_COMPONENTS = ["directives", "summary", "peerCard", "representation"];
export const PER_TURN_COMPONENTS = ["userContext", "dialectic"];

const DEFAULT_BASE_URL = "https://api.honcho.dev";

/**
 * Defaults match dsh-honcho / Hermes / zcode-honcho: per-turn inject with TTL
 * refresh + dialectic cadence. As an in-process Pi extension there is no hook
 * budget — refresh and dialectic are plain awaited promises bounded by the
 * same budgets, applied through withTimeout.
 */
export const FIRST_TURN_BUDGET_MS = 5_000;
export const REFRESH_BUDGET_MS = 8_000;
export const DIALECTIC_BUDGET_MS = 12_000;

const BUILTIN = {
  workspace: HOST_DEFAULT,
  timeoutMs: 30_000,
  sessionStrategy: "per-directory",
  sessionPeerPrefix: true,
  sessionPrefix: "",
  injection: {
    sessionStart: ["directives", "summary", "peerCard"],
    perTurn: ["userContext", "dialectic"],
    tools: true,
    searchTopK: 10,
    searchMaxDistance: 0.6,
    maxConclusions: 15,
    contextTokens: 1500,
    maxRenderedConclusions: 4,
    cadence: { dialectic: 5, ttlSeconds: 300 },
    dialectic: {
      template:
        "In two or three sentences, what should I know about this user to work with them well? " +
        "Durable preferences, current projects, working style. Third person, factual, no questions.",
      reasoning: "low",
      maxChars: 600,
    },
  },
  capture: {
    saveMessages: true,
    saveToolUse: false,
    writeFrequency: "async",
    noisePatterns: [],
  },
  messageUpload: {
    // ~25k characters at the usual 4 chars/token.
    maxUserTokens: 6_000,
    maxAssistantTokens: 6_000,
  },
};

const BUCKET_OBSERVATION = "unified";

function readPath(root, path) {
  let node = root;
  for (const part of path.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = node[part];
  }
  return node;
}

export function configPath(override) {
  if (override) return override.replace(/^~(?=$|\/)/, homedir());
  const dir = process.env.HONCHO_CONFIG_DIR || join(homedir(), ".honcho");
  return join(dir, "config.json");
}

function readFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // Missing or malformed: fall through to env + defaults rather than
    // refusing to start. A missing API key is what disables the plugin.
    return {};
  }
}

/** `${ENV_VAR}` interpolation. An unset variable yields "" so the caller's
 *  "no API key" path handles it rather than throwing at load. */
export function interpolateEnv(value) {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] ?? "");
}

/** Accept a bare host, any casing, with or without a trailing `/v3`. The
 *  client appends the version segment itself, so the normal form has none. */
export function normalizeBaseUrl(raw) {
  let url = raw.trim();
  if (!url) return DEFAULT_BASE_URL;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url);
    url = `${local ? "http" : "https"}://${url}`;
  }
  try {
    const parsed = new URL(url);
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/(?:\/v3)+\/?$/i, "").replace(/\/+$/, "");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return DEFAULT_BASE_URL;
  }
}

function resolveApiKey(file, host) {
  const candidates = [process.env.HONCHO_API_KEY, host?.auth?.apiKey, file.auth?.apiKey, file.apiKey];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = interpolateEnv(candidate).trim();
    if (resolved) return resolved;
  }
  return "";
}

function resolveBaseUrl(file) {
  if (process.env.HONCHO_BASE_URL) return normalizeBaseUrl(process.env.HONCHO_BASE_URL);
  if (file.baseUrl) return normalizeBaseUrl(file.baseUrl);
  if (file.endpoint?.baseUrl) return normalizeBaseUrl(file.endpoint.baseUrl);
  if (file.endpoint?.environment) {
    return normalizeBaseUrl(file.endpoint.environment === "local" ? "http://localhost:8000" : DEFAULT_BASE_URL);
  }
  return DEFAULT_BASE_URL;
}

function resolvePeerName(file, host) {
  return process.env.HONCHO_PEER_NAME || host?.peerName || file.peerName || process.env.USER || process.env.USERNAME || "user";
}

/**
 * Resolution order: env → hosts.<host> → root (identity + connection + switches
 * only) → bucket default → built-in.
 */
export function loadConfig(options = {}) {
  const hostKey = options.host || process.env.HONCHO_HOST || HOST_DEFAULT;
  const path = configPath(options.configPath);
  const file = readFile(path);
  const host = file.hosts?.[hostKey];

  const strategy = host?.sessionStrategy ?? BUILTIN.sessionStrategy;
  if (!SESSION_STRATEGIES.includes(strategy)) {
    throw new Error(
      `[honcho] unknown sessionStrategy ${JSON.stringify(strategy)} — expected one of ${SESSION_STRATEGIES.join(", ")}.`,
    );
  }

  return {
    rawHost: host ?? undefined,
    configFile: path,
    apiKey: process.env.HONCHO_API_KEY?.trim() || resolveApiKey(file, host),
    peerName: resolvePeerName(file, host),
    workspace: host?.workspace ?? file.workspace ?? BUILTIN.workspace,
    aiPeer: host?.aiPeer ?? hostKey,
    baseUrl: resolveBaseUrl(file),
    guiBase: host?.guiBase ?? "",
    timeoutMs: file.timeoutMs ?? BUILTIN.timeoutMs,
    enabled: file.enabled !== false,
    observationMode: host?.observationMode ?? BUCKET_OBSERVATION,
    sessionStrategy: strategy,
    sessionPeerPrefix: host?.sessionPeerPrefix ?? BUILTIN.sessionPeerPrefix,
    sessionPrefix: host?.sessionPrefix ?? file.sessionPrefix ?? BUILTIN.sessionPrefix,
    sessions: host?.sessions ?? file.sessions ?? {},
    injection: {
      ...BUILTIN.injection,
      ...(host?.injection ?? {}),
      cadence: { ...BUILTIN.injection.cadence, ...(host?.injection?.cadence ?? {}) },
      dialectic: { ...BUILTIN.injection.dialectic, ...(host?.injection?.dialectic ?? {}) },
    },
    capture: { ...BUILTIN.capture, ...(host?.capture ?? {}) },
    messageUpload: { ...BUILTIN.messageUpload, ...(host?.messageUpload ?? {}) },
  };
}

// ── session naming ─────────────────────────────────────────────────────────

function sanitize(value) {
  return value.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
}

/**
 * A remote URL reduced to `host/owner/repo`, so the two ways of cloning the
 * same repo — `git@github.com:you/web.git` and `https://github.com/you/web` —
 * produce one name. Credentials in the URL go with the `user@` part.
 */
function normalizeRemote(url) {
  let value = url.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i;
  value = scheme.test(value) ? value.replace(scheme, "") : value.replace(":", "/");
  return value.replace(/^[^/]*@/, "").replace(/^([^/]+):\d+(?=\/|$)/, "$1");
}

/** An explicit `sessions[cwd]` override always wins, used exactly as written. */
export function sessionName(config, cwd, sessionId) {
  if (cwd) {
    const override = config.sessions[cwd];
    if (override) return override;
  }
  return sanitize(config.sessionPrefix) + derivedName(config, cwd, sessionId);
}

function derivedName(config, cwd, sessionId) {
  const peer = sanitize(config.peerName);
  const prefix = (rest) => (config.sessionPeerPrefix ? `${peer}-${rest}` : rest);

  switch (config.sessionStrategy) {
    case "global":
      return config.sessionPeerPrefix ? peer : "honcho";

    case "per-repo": {
      const root = cwd ? repoRoot(cwd) : undefined;
      return prefix(sanitize(basename(root ?? cwd ?? "unknown")));
    }

    case "git-remote": {
      const remote = cwd ? originRemote(cwd) : undefined;
      // No remote collapses to the per-directory name rather than inventing a
      // placeholder that would fork memory.
      return prefix(remote ? sanitize(normalizeRemote(remote)) : sanitize(basename(cwd ?? "unknown")));
    }

    case "git-branch": {
      const dir = sanitize(basename(cwd ?? "unknown"));
      const branch = cwd ? currentBranch(cwd) : undefined;
      return prefix(branch ? `${dir}-${sanitize(branch)}` : dir);
    }

    case "per-session": {
      // Session ids are opaque; keep them whole up to a sane length.
      const raw = sessionId ? sanitize(sessionId).replace(/^(session|chat)[-_]/, "") : "";
      const id = raw.length > 24 ? raw.slice(0, 24) : raw;
      return id ? prefix(`chat-${id}`) : prefix(sanitize(basename(cwd ?? "unknown")));
    }

    case "per-directory":
    default:
      return prefix(sanitize(basename(cwd ?? "unknown")));
  }
}

/** Deep link into a Honcho GUI. There is no hardcoded hosted URL — this
 *  package is not affiliated with any hosted dashboard. The GUI base comes
 *  from the config (`guiBase` under the host block); unset/empty means the
 *  user has no GUI (the common self-hosted case) and the dashboard line
 *  simply never appears. */
export function sessionUrl(workspace, session, guiBase) {
  if (!guiBase) return null;
  const base = String(guiBase).replace(/\/+$/, "");
  return `${base}/explore?workspace=${encodeURIComponent(workspace)}&view=sessions&session=${encodeURIComponent(session)}`;
}

// ── telemetry identity ─────────────────────────────────────────────────────

export const HEADER_HOST = "X-Honcho-Host";
export const HEADER_PLUGIN = "X-Honcho-Plugin";
export const HEADER_AGENT_MODEL = "X-Honcho-Agent-Model";

/** The extension's own version, declared inline (no manifest to read). */
export function pluginVersion() {
  return "0.1.0";
}

/** `X-Honcho-Host: pi (linux)` — the host version is not exposed to extensions. */
export function telemetryHeaders(model) {
  const headers = {};
  headers[HEADER_HOST] = `${HOST_DEFAULT} (${platform()})`;
  headers[HEADER_PLUGIN] = `${PLUGIN_ID}/${pluginVersion()}`;
  if (model) headers[HEADER_AGENT_MODEL] = String(model).replace(/[\r\n]+/g, " ").trim();
  return headers;
}
