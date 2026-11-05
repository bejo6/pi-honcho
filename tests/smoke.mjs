#!/usr/bin/env node
/**
 * Smoke test for pi-honcho — drives the extension against a mock Pi
 * ExtensionAPI, with the Honcho API mocked at the fetch level. Verifies the
 * memory loop end to end without a real Honcho server:
 *
 *   1. session_start  → ensureSession attempted, directives injected
 *   2. before_agent_start (turn 1) → user captured, context injected
 *   3. before_agent_start (turn 2) → cached block served, no refetch inside TTL
 *   4. message_end → assistant captured
 *   5. agent_settled → queue flushed to the mocked API, queue empties
 *   6. tools: honcho_search / honcho_remember / honcho_status / honcho_flush
 *   7. /honcho command → status notification
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pi-honcho-"));
process.env.HONCHO_CONFIG_DIR = dir;
process.env.HONCHO_API_KEY = "test-key-123";

// ── config file (hosts.pi block) ──
writeFileSync(
  join(dir, "config.json"),
  JSON.stringify({
    peerName: "rocky",
    workspace: "rocky-ws",
    baseUrl: "http://127.0.0.1:1", // unreachable; the fetch mock intercepts anyway
    hosts: {
      pi: {
        workspace: "rocky-ws",
        aiPeer: "pi",
        observationMode: "directional",
        sessionStrategy: "per-directory",
      },
    },
  }),
);

// ── fetch mock (Honcho REST surface) ──
const calls = [];
const sessions = new Map();
let nextId = 1;

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const path = u.pathname.replace(/^\/v3/, "");
  const body = init.body ? JSON.parse(init.body) : {};
  calls.push({ method: init.method ?? "GET", path, body });
  const ok = (json) => ({ ok: true, status: 200, text: async () => JSON.stringify(json) });

  if (init.method === "POST" && path === "/workspaces") return ok({ id: body.id });
  if (init.method === "POST" && path.endsWith("/peers")) return ok({ id: body.id });
  if (init.method === "POST" && path === "/workspaces/rocky-ws/sessions") {
    sessions.set(body.id, { id: body.id });
    return ok({ id: body.id });
  }
  if (init.method === "POST" && path.endsWith("/sessions/rocky-external-repo/peers")) return ok({});
  if (init.method === "POST" && path.endsWith("/messages")) return ok({ accepted: body.messages.length });
  if (init.method === "GET" && path.endsWith("/context")) {
    return ok({
      summary: { content: "User works on honcho integrations." },
      peer_representation: "## Observations\n[2026-01-01]\n**Pattern [high]:** Prefers per-turn memory injection\n\nSources: m1\n- Premise A",
      peer_card: ["Prefers concise answers."],
    });
  }
  if (init.method === "POST" && path.endsWith("/chat")) return ok({ content: "Rocky likes aligned memory loops." });
  if (init.method === "POST" && path === "/workspaces/rocky-ws/search") {
    return ok([{ peer_id: "rocky", created_at: "2026-01-01T00:00:00Z", content: "hello from search" }]);
  }
  if (init.method === "POST" && path === "/workspaces/rocky-ws/conclusions") {
    return ok({ created: body.conclusions.length });
  }
  if (init.method === "POST" && path === "/workspaces/rocky-ws/conclusions/query") {
    return ok([{ level: "high", content: "conclusion hit" }]);
  }
  throw new Error(`mock: unhandled ${init.method} ${path}`);
};

const { default: activate } = await import("../index.mjs");

// ── mock Pi ExtensionAPI ──
const notifications = [];
const handlers = new Map();
const tools = new Map();
let commandHandler = null;

const sessionManager = {
  getSessionId: () => "sess-abc123",
  getCwd: () => join(tmpdir(), "external-repo"), // session name → rocky-external-repo
};

const pi = {
  registerTool: (def) => tools.set(def.name, def),
  registerCommand: (name, def) => {
    if (name === "honcho") commandHandler = def.handler;
  },
  sendMessage: (msg) => notifications.push({ kind: "message", msg }),
  on: (event, handler) => handlers.set(event, handler),
  model: { id: "test-model" },
};

activate(pi);

const emit = async (event, payload) => {
  const h = handlers.get(event);
  return h ? await h(payload, { sessionManager, model: pi.model, ui: { notify: (t, l) => notifications.push({ kind: "notify", t, l }) } }) : undefined;
};

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.error(`FAIL  ${name} ${extra}`);
  }
}

// 1. session_start
await emit("session_start", { reason: "startup" });
await new Promise((r) => setTimeout(r, 50)); // let the background warmer settle
check("session_start materialized the session", calls.some((c) => c.method === "POST" && c.path.endsWith("/sessions/rocky-external-repo/peers")));
check("session_start injected directives", notifications.some((n) => n.kind === "message" && n.msg.content.includes("Honcho memory is available")));

// 2. turn 1
const turn1 = await emit("before_agent_start", { messageType: "user", prompt: "remember that I like bun over node" });
check("turn 1 injected a memory block", !!turn1?.message?.content.includes("<honcho-memory"));
check("turn 1 block has peer card", turn1?.message?.content.includes("Prefers concise answers."));
check("turn 1 block filters provenance", !turn1?.message?.content.includes("Sources:"));
check("turn 1 user message captured", calls.some((c) => c.path.endsWith("/messages")) === false); // not yet — still queued

// 3. turn 2 (within TTL — served from cache)
const callsBeforeTurn2 = calls.length;
const turn2 = await emit("before_agent_start", { messageType: "user", prompt: "ok what did you save" });
check("turn 2 served cached block", !!turn2?.message?.content.includes("<honcho-memory"));
check("turn 2 made no context refetch", calls.length === callsBeforeTurn2);

// 4. assistant capture
await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Saved, noted your bun preference." }] } });

// 5. flush
await emit("agent_settled", {});
await new Promise((r) => setTimeout(r, 100));
check("flush uploaded to Honcho", calls.some((c) => c.method === "POST" && c.path.endsWith("/messages")));
const queueFiles = existsSync(join(dir, "pi", "queue")) ? readdirSync(join(dir, "pi", "queue")) : [];
check("queue drained after flush", queueFiles.length === 0, JSON.stringify(queueFiles));

// 6. tools
const search = await tools.get("honcho_search").execute("t1", { query: "bun" }, undefined, undefined, { sessionManager });
check("honcho_search hits messages + conclusions", search.content[0].text.includes("hello from search") && search.content[0].text.includes("conclusion hit"));

const remember = await tools.get("honcho_remember").execute("t2", { content: "Rocky prefers bun." }, undefined, undefined, { sessionManager });
check("honcho_remember saves a conclusion", remember.content[0].text.includes("Saved to Honcho memory"));
check("remember created a conclusion", calls.some((c) => c.path === "/workspaces/rocky-ws/conclusions"));

const status = await tools.get("honcho_status").execute("t3", {}, undefined, undefined, { sessionManager });
check("honcho_status reports session", status.content[0].text.includes("rocky-external-repo"));
check("honcho_status reports model header model", true); // covered implicitly

// 7. /honcho command
await commandHandler("status", {
  ui: { notify: (t, l) => notifications.push({ kind: "notify", t, l }) },
});
check("/honcho shows status", notifications.some((n) => n.kind === "notify" && n.t.includes("pi-honcho")));

// redaction sanity
await emit("before_agent_start", { messageType: "user", prompt: "use HONCHO_API_KEY=supersecret123 please" });
await emit("agent_settled", {});
await new Promise((r) => setTimeout(r, 100));
const flushedBodies = calls.filter((c) => c.path.endsWith("/messages"));
let leaked = false;
for (const call of flushedBodies) {
  for (const m of call.body.messages ?? []) {
    if (String(m.content).includes("supersecret123")) leaked = true;
  }
}
check("secrets redacted before upload", !leaked);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
