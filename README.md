# pi-honcho

Persistent memory for Pi, powered by [Honcho](https://honcho.dev).

A Pi extension port of [zcode-honcho](https://github.com/bejo6/zcode-honcho)
(itself a port of [dsh-honcho](https://github.com/plastic-labs/dsh-honcho)) —
the same Hermes/dsh-aligned memory loop, in-process:

**Captures every turn.** User prompts (`before_agent_start`) and assistant
replies (`message_end`) are queued locally — secrets redacted first — and
flushed to Honcho when the agent settles. A failed upload is retried on the
next flush; nothing is sent twice after success.

**Injects memory each prompt** (Hermes / dsh / cursor-honcho / zcode-honcho):

| Turn | Behavior |
| --- | --- |
| First | Wait up to ~5s for `session.context()` (and dialectic when due) |
| Later | Serve the cached block; refresh in-process when the TTL expires |
| Dialectic | Periodic profile refresh (every N turns), bounded by its own budget |

`session_start` only bootstraps peers, optional directives, and a warm cache.
The reliable inject path is `before_agent_start`.

**Gives the model five tools** (registered via `pi.registerTool()`, not a
separate MCP server):

| Tool              | For                                                                        |
| ----------------- | -------------------------------------------------------------------------- |
| `honcho_search`   | Looking something up. Searches raw messages _and_ derived conclusions.     |
| `honcho_chat`     | Asking a question of judgment. Reasons over everything Honcho knows. Slow. |
| `honcho_remember` | Saving a durable fact, preference, or decision.                            |
| `honcho_status`   | Live status: peer, workspace, session, queue depth, last sync.             |
| `honcho_flush`    | Sync the capture queue now.                                                |

**`/honcho`** shows status and resolved config; `/honcho flush` forces a sync.

Zero dependencies — plain Node ESM, no build step, no MCP stdio server.

## Install

```sh
pi install ./pi-honcho
```

or as a one-off test:

```sh
pi -e ./pi-honcho
```

## Configuration

Reads the same `~/.honcho/config.json` as the other Honcho integrations
(claude-honcho, codex-honcho, dsh-honcho, zcode-honcho, cursor-honcho).
Identity and connection live at the root; behavior lives in `hosts.pi`:

```jsonc
{
  "peerName": "your-name",
  "workspace": "honcho",
  "baseUrl": "https://api.honcho.dev",
  "auth": { "apiKey": "${HONCHO_API_KEY}" },
  "enabled": true,

  "hosts": {
    "pi": {
      "workspace": "pi",               // isolation boundary — same workspace = shared memory
      "aiPeer": "pi",                  // defaults to the host name
      "observationMode": "unified",    // unified | directional
      "sessionStrategy": "per-directory",
      "sessionPeerPrefix": true,
      "sessionPrefix": "",             // literal prefix on every generated name
      "sessions": { "/path/to/repo": "pinned-session-name" },
      "injection": {
        "sessionStart": ["directives", "summary", "peerCard"],
        "perTurn": ["userContext", "dialectic"],
        "searchTopK": 10,
        "searchMaxDistance": 0.6,
        "maxConclusions": 15,
        "maxRenderedConclusions": 4,
        "contextTokens": 1500,
        "cadence": { "dialectic": 5, "ttlSeconds": 300 },
        "dialectic": { "reasoning": "low", "maxChars": 600 }
      },
      "capture": {
        "saveMessages": true,
        "saveToolUse": false,          // one-line summaries of tool activity
        "noisePatterns": []            // additive to the built-in secret patterns
      },
      "messageUpload": { "maxUserTokens": 6000, "maxAssistantTokens": 6000 }
    }
  }
}
```

`HONCHO_API_KEY` in the environment works on its own. Everything behavioral —
injection components, cadence, dialectic, capture, session naming strategies —
is identical to zcode-honcho / dsh-honcho; see their READMEs for the full
reference.

### Sharing memory with other integrations

Each integration defaults to its own Honcho `workspace`. Point two at the same
`workspace` (and keep `peerName` identical) to merge their memory:

```jsonc
"hosts": {
  "pi":    { "workspace": "shared" },
  "zcode": { "workspace": "shared" }
}
```

## Sessions

Same strategies as the other integrations: `per-directory` (default,
`<peer>-<dir>`), `per-repo`, `git-remote`, `git-branch`, `per-session`,
`global`. Pin per-path overrides via `sessions[cwd]`. Prefer the wider scopes:
Honcho's Deriver needs a single session to accumulate enough material.

## State

Everything on disk lives under `~/.honcho/pi/` (or `$HONCHO_CONFIG_DIR/pi`):

| Path | Purpose |
| --- | --- |
| `queue/*.jsonl` | Pending captured messages, deleted only after successful upload |
| `memory/<session>.json` | Per-session turn count, cached context, dialectic |
| `status.json` | Last sync/fetch times and errors (surfaced by `/honcho`) |
| `hook.log` | Injection/dialectic diagnostics |

## Develop / test

```sh
node tests/smoke.mjs
```

The smoke test mocks the Honcho REST surface at the `fetch` level and drives
the extension through a mock `ExtensionAPI` — no server needed.

## License

MIT
