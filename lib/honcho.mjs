/**
 * Honcho REST client — the `@honcho-ai/sdk` v3 HTTP surface reimplemented on
 * Node's built-in fetch, so the plugin ships with zero dependencies and runs
 * from any install with just `node` on PATH.
 *
 * Endpoints mirror the SDK 2.4.0 (`dist/client.js`): get-or-create for
 * workspace/peer/session via POST, auth via `Authorization: Bearer`, telemetry
 * via the `X-Honcho-*` identity headers.
 */

const API = "v3";
const DEFAULT_MAX_RETRIES = 1;

import { telemetryHeaders } from "./config.mjs";

export class HonchoRequestError extends Error {
  constructor(status, body, method, path) {
    super(`honcho ${method} ${path} failed: HTTP ${status}${body ? ` — ${String(body).slice(0, 200)}` : ""}`);
    this.name = "HonchoRequestError";
    this.status = status;
  }
}

export class HonchoClient {
  /**
   * @param config a ResolvedConfig from lib/config.mjs
   * @param options.timeoutMs caps every request (the hook budget, not just the
   *   configured client timeout); options.model lands on the agent-model header.
   */
  constructor(config, options = {}) {
    this.config = config;
    this.timeoutMs = options.timeoutMs ?? config.timeoutMs;
    this.model = options.model;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  headers() {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
      ...telemetryHeaders(this.model),
    };
    return headers;
  }

  async request(method, path, { body, query, retries } = {}) {
    const url = new URL(`${this.config.baseUrl}/${API}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }

    let attempts = retries ?? this.maxRetries;
    for (;;) {
      let response;
      try {
        response = await fetch(url, {
          method,
          headers: this.headers(),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        // Network-level failure (refused, DNS, timeout). Retrying a request
        // that never connected cannot duplicate anything.
        if (attempts > 0) {
          attempts -= 1;
          await new Promise((resolve) => setTimeout(resolve, 400));
          continue;
        }
        throw error;
      }

      if (response.ok) {
        const text = await response.text();
        return text ? JSON.parse(text) : null;
      }

      const retryable = response.status === 429 || response.status === 503;
      if (retryable && attempts > 0) {
        attempts -= 1;
        await new Promise((resolve) => setTimeout(resolve, 800));
        continue;
      }
      const text = await response.text().catch(() => "");
      throw new HonchoRequestError(response.status, text, method, path);
    }
  }

  // ── get-or-create ────────────────────────────────────────────────────────

  ensureWorkspace() {
    return this.request("POST", "/workspaces", { body: { id: this.config.workspace } });
  }

  ensurePeer(id) {
    return this.request("POST", `/workspaces/${enc(this.config.workspace)}/peers`, { body: { id } });
  }

  ensureSession(name) {
    return this.request("POST", `/workspaces/${enc(this.config.workspace)}/sessions`, { body: { id: name } });
  }

  /** Associate peers with a session: `{ "<peerId>": {}, … }`, the SDK's
   *  PeerAdditionToApi shape. Materializes the session server-side. */
  addSessionPeers(name, peerIds) {
    const peers = {};
    for (const id of peerIds) peers[id] = {};
    return this.request("POST", `/workspaces/${enc(this.config.workspace)}/sessions/${enc(name)}/peers`, {
      body: peers,
    });
  }

  // ── memory operations ────────────────────────────────────────────────────

  /** One call returning summary + representation + peer card together. */
  sessionContext(name, options = {}) {
    const query = {};
    if (options.tokens !== undefined) query.tokens = options.tokens;
    if (options.summary) query.summary = "true";
    if (options.peerTarget) query.peer_target = options.peerTarget;
    if (options.peerPerspective) query.peer_perspective = options.peerPerspective;
    if (options.searchQuery) {
      query.search_query = options.searchQuery.slice(0, 300);
      query.search_top_k = options.searchTopK;
      query.search_max_distance = options.searchMaxDistance;
      query.max_conclusions = options.maxConclusions;
    }
    return this.request("GET", `/workspaces/${enc(this.config.workspace)}/sessions/${enc(name)}/context`, { query });
  }

  addMessages(name, messages) {
    return this.request("POST", `/workspaces/${enc(this.config.workspace)}/sessions/${enc(name)}/messages`, {
      body: { messages },
    });
  }

  /** Reasoned dialectic answer. `{content: string}` or `{}` when nothing. */
  chat(query, { from, target, sessionId, reasoningLevel } = {}) {
    return this.request("POST", `/workspaces/${enc(this.config.workspace)}/peers/${enc(from)}/chat`, {
      body: {
        query,
        stream: false,
        ...(target ? { target } : {}),
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(reasoningLevel ? { reasoning_level: reasoningLevel } : {}),
      },
      retries: 0,
    });
  }

  /** Full-text/semantic search over messages in the whole workspace. */
  search(query, limit) {
    return this.request("POST", `/workspaces/${enc(this.config.workspace)}/search`, {
      body: { query, limit },
    });
  }

  /** Semantic search over derived conclusions. */
  conclusionsQuery(query, topK, { observer, observed, distance } = {}) {
    return this.request("POST", `/workspaces/${enc(this.config.workspace)}/conclusions/query`, {
      body: {
        query,
        top_k: topK,
        ...(distance !== undefined ? { distance } : {}),
        filters: { observer_id: observer, observed_id: observed },
      },
    });
  }

  conclusionsCreate(conclusions) {
    return this.request("POST", `/workspaces/${enc(this.config.workspace)}/conclusions`, {
      body: { conclusions },
    });
  }
}

function enc(value) {
  return encodeURIComponent(value);
}
