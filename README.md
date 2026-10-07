# itonami-agent

A Hermes-compatible agent written in kotoba (`.cljk` on kbb), with peer-to-peer
execution of agent turns. No dependencies beyond the kbb engine; no JVM, no
Python, no npm packages.

```
bin/itonami-agent -p hiraku-soudan -z "質問"            # one turn, like `hermes -p … -z`
bin/itonami-agent -p hiraku-kyozai cron run <job-id>    # a Hermes cron job, same files
bin/itonami-agent peer serve --port 7420                # run turns for trusted peers
bin/itonami-agent peer run -p hiraku-soudan -z "質問"   # run this turn on a peer
```

## Compatibility with Hermes Agent

itonami-agent reads and writes the Hermes profile layout in place
(`~/.hermes/profiles/<name>/`). Hermes keeps working on every profile, and
the two can be swapped per profile.

| Hermes surface | itonami-agent |
|---|---|
| `SOUL.md`, `profile.yaml`, `config.yaml`, `.env`, `secrets.command` | read the same way. YAML reader is checked against PyYAML on all 1,954 host files: 0 differences |
| `model` / `providers` / `fallback_providers`, job pin disables fallback | same resolution order (`cron/scheduler.py`, `runtime_provider_custom.py`) |
| `agent.max_turns`, `agent.run_budget_seconds` (80 % wrap-up notice, hop timeout ≤ ½ remaining budget) | same; plus up to 3 rounds over the chain with backoff when every hop failed transiently (429 / 5xx / transport) |
| tools `terminal read_file write_file patch search_files web_search web_extract skill_view memory`; toolsets `hermes-cli`, `hermes-cron`, `terminal`, `file`, `web`, `skills`, `memory` | same names and argument shapes; results are JSON strings |
| `cron/jobs.json` (all fields), 5-field cron / interval / once schedules | read and written in Hermes' format; Hermes' own `cron.jobs.load_jobs()` / `get_due_jobs()` read what itonami writes |
| cron prompt: `_CRON_HINT`, `## Script Output` / `## Script Error` block, empty stdout and `{"wakeAgent": false}` skip, `[SILENT]`, `[CRON_FAILURE]` | identical text and semantics |
| `cron/output/<id>/<YYYY-MM-DD_HH-MM-SS>.md`, newest 50, mode 0600 | identical layout (adds `**Engine:**` / `**Peer:**` lines) |
| `usage_audit.jsonl`, `ticker_heartbeat`, `ticker_last_success` | written |
| `-p`, `-z` (stdout = final text, exit 1 + `… -z: reason` on stderr), `-m`, `--provider`, `-t`, `cron list/create/run/tick/runs/status`, `profile list/show`, `chat` | same flags |
| `executions.db`, incidents, notepad, messaging gateway adapters, `delegate_task`, browser tools, MCP | **not implemented**; itonami logs runs to `cron/itonami-runs.jsonl` |

## itonami profile

`profile itonamify <p>|--all` adds `itonami.edn` (schema
`cloud.itonami.profile.v1`) next to the Hermes files. Hermes ignores it;
deleting it returns the profile to plain Hermes.

```clojure
{:itonami/schema "cloud.itonami.profile.v1"
 :profile/id "hiraku-soudan"
 :runtime   {:engine :itonami-agent :scheduler :hermes}   ; who ticks cron
 :placement {:mode :p2p :order [:peer :local] :peers :trusted :inference-rail :murakumo}
 :state     {:workspace :host-local :results :cid-receipts :secrets :never-leave-host}
 :bundle    {:cid "bafkrei…" :files 5 :skills []}          ; content address of the definition
 :capabilities [...]}                                       ; copied from yakuwari.edn, grants nothing
```

Exactly one scheduler ticks a profile:

- `profile adopt <p>` sets `:scheduler :itonami` and writes Hermes'
  `gateway.parked` marker, so the Hermes gateway stops ticking it;
  `gateway run` then ticks it.
- `profile release <p>` reverses both.

## Peer-to-peer execution

Every node runs the same program. There is no coordinator.

```
requester (node A)                               peer (node B)
  itonami.edn :placement [:peer :local]
  discover: peers.edn + one gossip hop  ── GET /itonami/v1/peer ──▶  signed {did load rails profiles peers}
  pick: trusted, not full, holds CID first
  bundle = SOUL + config − host-local + jobs + scripts  (CIDv1 raw sha2-256)
  POST /itonami/v1/run  (signed envelope: profile cid prompt opts [files])  ──▶ verify sig, trust, ts, nonce
                                                    ◀── 202 {run_id} (signed)
                                                    `peer exec` child process:
                                                      verify bundle CID, materialize ~/.itonami/peer-runs/<cid>/
                                                      rebase A's home paths onto the copy
                                                      run the turn with B's own inference rail
                                                      (profile chain + murakumo), writes confined to the copy
  GET /itonami/v1/run/<id> every 3 s (signed)  ◀── 200 signed {final usage attempts writes result_sha256}
  verify B's signature and CID, apply workspace/ writes, record receipt in cron/itonami-runs.jsonl
```

- **Identity**: ed25519 per node (`~/.itonami/node/key.json`, 0600), named by
  `did:key:z6Mk…`. A murakumo fleet node advertises `MURAKUMO_NODE_DID`
  beside it.
- **Trust**: `~/.itonami/peers.edn`. Gossip learns URLs but never trust.
- **Secrets never cross**. The executing peer pays inference with its own
  rail (`~/.itonami/peer.env` or its environment); `murakumo` is put on the
  chain when the profile's `:inference-rail` is `:murakumo`.
- **Not a sandbox.** `terminal` on a peer is a real shell on that peer. Trust
  is the boundary. The four conditions of ADR-2609242300 (gVisor/rootless
  isolation, tunnel, cross-node resume, secret isolation) are still open.

### Decentralised inference (no third-party relay)

Every node brings its own inference rails and lends them to trusted peers.

```
any OpenAI client on node A (itonami-agent, Hermes)
  provider itonami-p2p  base_url http://127.0.0.1:7420/v1      (loopback only)
        │
        ├─ A's own rails  ~/.itonami/rails.edn   (llama-server, mlx_lm, Ollama,
        │                                         murakumo mishima-local-router over the mesh)
        └─ trusted peers  POST /itonami/v1/infer (signed envelope) ──▶ B's own rails only
                                                  ◀── signed response   (never forwarded onward)
```

- `peer rails detect` probes loopback for OpenAI-compatible servers and
  writes `rails.edn`; models too small for tool calling (≈1B and below) are
  marked `:agent? false` and used only when named exactly. `model: auto` picks
  the first agent-capable rail.
- `/peer` advertises `models` / `agent_models`, so gossip tells a node which
  peer can answer which model.
- For an itonami profile, hops whose base URL is a relay in
  `:inference :deny-hosts` (default `openrouter.ai`) are dropped from the
  chain; a profile without `itonami.edn` keeps its Hermes chain. Turns run for
  a peer always get `itonami-p2p` on their chain.
- **Authority servers, used but not depended on.** kotoba
  (`api.kotoba.cloud`) and murakumo (`api.murakumo.cloud`) are the few
  authority servers of the plane (`:inference :authorities`). They keep their
  place on a profile's chain while healthy, but each sits behind a circuit
  breaker shared by the node (`~/.itonami/authority-health.json`): a failure
  parks the authority (402/401/403 → 30 min, 429 → 2 min, 5xx/transport → 5
  min) and later turns skip it at no cost; a success clears it. The chain of
  an itonami profile always also carries `itonami-p2p`, so it never consists
  of authorities alone. `peer authorities` shows the breaker state.

### murakumo

murakumo today is hub-and-spoke: nodes poll `api.murakumo.cloud` for
inference jobs, and it has no generic agent-step job kind. itonami-agent
uses murakumo as the shared inference rail (`murakumo/free`, `mishima`) and
keeps agent execution on its own peer protocol. The
mesh path (`mishima-local-router` on a node, straight to fleet llama-servers
over tailscale) is used as a node-owned rail, without `api.murakumo.cloud`. Making agent turns a
murakumo job kind is a change on the murakumo side (`poll_worker.cljk`) and
not done here.

## Resident gateway

`~/Library/LaunchAgents/cloud.itonami.agent.gateway.plist` runs
`bin/itonami-agent gateway run --interval 60` (KeepAlive). Every minute it
ticks each adopted profile that has a due job — profiles independently, each
under its own `cron/.itonami-tick.lock`, secrets resolved only when a job is
due. Logs: `~/.itonami/logs/gateway.log`.

```
launchctl kickstart -k gui/$(id -u)/cloud.itonami.agent.gateway   # restart
launchctl bootout gui/$(id -u)/cloud.itonami.agent.gateway         # stop
```

## Fleet deployment

A node needs only `node`: the runtime is the nbb engine (`cli.js`, `lib/`,
`node_modules/import-meta-resolve`, ~19 MB) plus this repository, placed in
`~/.itonami/runtime/`. On the murakumo mishima nodes it runs as
`/Library/LaunchDaemons/cloud.itonami.agent.peer.plist` (`UserName` = the
node user, like `com.murakumo.mishima`), `node cli.js bin/itonami-agent peer
serve --port 7420 --url http://<tailscale-ip>:7420`; `peer rails detect`
finds the node's llama-server on `127.0.0.1:18094`. Trust is a full mesh in
each node's `~/.itonami/peers.edn`. `ITONAMI_PEER_PORT` moves the port (serve
and the `itonami-p2p` rail) on a node where 7420 is taken.

## System One Coding (kotoba-harness)

itonami-agent can assemble typed kotoba functions with
[kotoba-lang/kotoba-harness](https://github.com/kotoba-lang/kotoba-harness):
TypeSafe Jev chooses typed blocks one hole at a time (never source text), the
harness emits kotoba typed-subset source, and kotoba verifies each function
(`kotoba -M check`, then the module plus fixed exhaustive checks compiled to
wasm32-browser and run through `instantiateKotoba`). The search backtracks
outward when the policy reports that no candidate fits.

`system-one/loop.edn` encodes the run-loop rules of `src/itonami/agent/loop.cljk` — stop at `max_turns`, `budget_exhausted` when `elapsed > run_budget` (only for a positive budget: `pos?`, so zero or negative disables it), and the wrap-up notice at 80% of the budget (`5·elapsed > 4·budget`) — as `turn-allowed`, `budget-exhausted`, `wrap-up` and `may-continue` (15 016 exhaustive cases, including non-positive budgets; checks use
independently written oracles). The harness commit is pinned in
`kotoba-harness.pin.edn` and fetched into
`${XDG_CACHE_HOME:-~/.cache}/kotoba-harness/<sha>` on first use (network),
outside this repository, and reused only while that checkout is the pinned
commit with a clean worktree (override with `KOTOBA_HARNESS_HOME`). The
launcher is a kbb program and runs the harness in-process.

```sh
bin/itonami-system-one validate   # no kotoba CLI, no model: shape, catalog, baseline splice
bin/itonami-system-one known      # kotoba verification of known-correct bodies
bin/itonami-system-one wrong      # negative control (rejected)
OPENROUTER_API_KEY=... bin/itonami-system-one jev
```

`known`/`wrong`/`jev` need a kotoba CLI that provides `-M check` and
`-M compile --target wasm32-browser`, and `KOTOBA_BROWSER_HOST` pointing at
amu's `runtime/browser-host.mjs`. `jev` spends OpenRouter credit (about a tenth
of a cent per run). Receipts land in `target/system-one/`.

## Tests

```
kbb --backend sci --classpath src:test run-tests.cljk
```
