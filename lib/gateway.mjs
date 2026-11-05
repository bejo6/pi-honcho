/**
 * Honcho gateway — the operation layer the tools and hooks call, mirroring
 * dsh-honcho's `src/honcho.ts`. `observationMode` routing lives here:
 * unified (the default for a coding-assistant bucket) the user observes
 * themselves through their own peer; directional, the AI peer observes the
 * user and operations run from the AI peer with the user as target.
 */

import { HonchoClient } from "./honcho.mjs";
import { sessionName } from "./config.mjs";

const BATCH_LIMIT = 50;

export class Gateway {
  constructor(config, options = {}) {
    this.config = config;
    this.clientOptions = options;
    this.directional = config.observationMode === "directional";
    /** Memoized per Honcho session name, per process. */
    this.ensured = new Set();
  }

  client() {
    if (!this._client) {
      this._client = new HonchoClient(this.config, this.clientOptions);
    }
    return this._client;
  }

  currentSessionName(cwd, sessionId) {
    return sessionName(this.config, cwd, sessionId);
  }

  /** Create the session and associate both peers. Idempotent per process. */
  async ensureSession(cwd, sessionId) {
    const name = this.currentSessionName(cwd, sessionId);
    if (this.ensured.has(name)) return name;
    const c = this.client();
    await c.ensureWorkspace();
    await Promise.all([c.ensurePeer(this.config.peerName), c.ensurePeer(this.config.aiPeer)]);
    // addPeers materializes the session server-side and associates both peers.
    await c.addSessionPeers(name, [this.config.peerName, this.config.aiPeer]);
    this.ensured.add(name);
    return name;
  }

  /** One call: summary + representation + peer card, shaped for injection.
   *  Deliberately NOT limitToSession — that drops the peer card and confines
   *  recall to explicit-only conclusions, discarding exactly the cross-session
   *  synthesis the Deriver and Dreamer produce.
   *
   *  ensureSession first: on a shared workspace (or a first-ever run) the AI
   *  peer and session may not exist yet, and the server answers a bare context
   *  call with `404 Peer <aiPeer> not found`. Materializing is idempotent, so
   *  the injection self-heals instead of failing on a fresh workspace. */
  async fetchContext(cwd, sessionId, searchQuery) {
    const c = this.client();
    const name = await this.ensureSession(cwd, sessionId);
    const result = await c.sessionContext(name, {
      summary: true,
      tokens: this.config.injection.contextTokens,
      peerTarget: this.config.peerName,
      ...(this.directional ? { peerPerspective: this.config.aiPeer } : {}),
      ...(searchQuery
        ? {
            searchQuery,
            searchTopK: this.config.injection.searchTopK,
            searchMaxDistance: this.config.injection.searchMaxDistance,
            maxConclusions: this.config.injection.maxConclusions,
          }
        : {}),
    });
    return {
      summary: result?.summary ? { content: result.summary.content ?? result.summary } : null,
      peerRepresentation: result?.peer_representation ?? null,
      peerCard: result?.peer_card ?? null,
    };
  }

  /** User + assistant turns, batched inside the API's per-request cap. */
  async upload(name, messages) {
    const c = this.client();
    await c.ensureWorkspace();
    await c.addMessages(
      name,
      messages.map((m) => ({ peer_id: m.peerId, content: m.content })),
    );
  }

  /** The periodic background dialectic, shaped by `injection.dialectic`. */
  async backgroundDialectic(cwd, sessionId, userQuery) {
    const cfg = this.config.injection.dialectic;
    const query = cfg.template.replace(/%\{user_query\}/g, userQuery);
    const c = this.client();
    const from = this.directional ? this.config.aiPeer : this.config.peerName;
    const response = await c.chat(query, {
      from,
      ...(this.directional ? { target: this.config.peerName } : {}),
      sessionId: this.currentSessionName(cwd, sessionId),
      reasoningLevel: cfg.reasoning,
    });
    return (response?.content ?? "").trim().slice(0, cfg.maxChars);
  }

  /** Reasoned chat about the user. Slow — 30s to minutes is normal. */
  async chat(query) {
    const c = this.client();
    const from = this.directional ? this.config.aiPeer : this.config.peerName;
    const response = await c.chat(query, {
      from,
      ...(this.directional ? { target: this.config.peerName } : {}),
    });
    return (response?.content ?? "").trim();
  }

  formatMessage(r) {
    const when = String(r.created_at ?? "").slice(0, 16).replace("T", " ");
    return `[message ${r.peer_id ?? "?"} ${when}] ${String(r.content ?? "").slice(0, 400)}`;
  }

  async searchMessages(query, limit) {
    const results = await this.client().search(query, limit);
    return (results ?? []).map((r) => this.formatMessage(r));
  }

  /** The observer/observed pair follows the observation mode, same as chat. */
  async searchConclusions(query, limit) {
    const observer = this.directional ? this.config.aiPeer : this.config.peerName;
    const conclusions = await this.client().conclusionsQuery(query, limit, {
      observer,
      observed: this.config.peerName,
    });
    return (conclusions ?? []).map((c) => `[conclusion:${c.level ?? "?"}] ${String(c.content ?? "").slice(0, 400)}`);
  }

  /** Persist a durable fact about the user, anchored to this session. */
  async remember(content, cwd) {
    const c = this.client();
    await c.ensureWorkspace();
    const name = this.currentSessionName(cwd);
    // Get-or-create first: a conclusion pointing at a session the server has
    // never seen would be orphaned.
    const created = await c.ensureSession(name);
    const observer = this.directional ? this.config.aiPeer : this.config.peerName;
    await c.conclusionsCreate([
      {
        content,
        session_id: created?.id ?? name,
        observer_id: observer,
        observed_id: this.config.peerName,
      },
    ]);
    return name;
  }
}
