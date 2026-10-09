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
- **`terminal` runs in an OS sandbox** (`itonami.agent.confine`): macOS
  Seatbelt (`sandbox-exec`) or Linux `bwrap`. Writes reach only the run's
  roots and a per-run `TMPDIR`; ssh/cloud/gpg keys, keychains, the node key
  and every `.env` / `peer.env` are unreadable (also to `read_file` and
  `search_files`); there is no network; the env is `PATH`/`HOME`/locale/`TERM`
  only. With no sandbox on the host the command
  is refused. A turn run for a peer always gets this policy: the bundle's
  `itonami.edn` cannot widen it. The remaining conditions of ADR-2609242300
  (tunnel, cross-node resume) are still open.

## Terminal policy

Local runs read `:terminal` from the profile's `itonami.edn`:

```clojure
:terminal {:confinement :sandbox     ; default; :host = run unconfined (local only)
           :network true             ; outbound network (default: none)
           :env ["GITHUB_TOKEN"]     ; profile secrets passed to commands, by name
           :write ["~/notes"]}       ; extra write roots
```

A profile without `:terminal` gets the default: sandboxed, offline, no
secrets, writes confined to its terminal cwd.

`read_file` and `search_files` follow the same read rules: the secret stores
are refused before the file is even looked up (a symlink is judged by its
target), and `search_files` runs `rg` / `grep` / `find` inside the sandbox,
so a search over a broad path skips them. A turn run for a peer reads
nothing under the home directory except its own roots, the bundle it runs
from and the toolchains on `PATH`; its commands get the per-run `TMPDIR` as
`HOME`.

`web_extract` goes through `itonami.agent.webguard`: http(s) only, no
credentials in the URL, and every address the host resolves to must be
public -- loopback, private, link-local (cloud metadata), CGNAT (tailscale),
multicast and reserved ranges are refused, judged inside the socket's own
lookup so a DNS answer cannot change between check and connect. Redirects
are followed by hand (at most 5), each hop judged again; bodies are cut at
2 MB. To limit where a profile may fetch from at all:

```clojure
:web {:allow ["www.mhlw.go.jp" "*.go.jp"]}   ; exact names or *.suffix
```

A bundle can only narrow this, so a peer turn honours it. Every URL, fetched
or refused, is a line in `~/.itonami/logs/terminal-sandbox.jsonl`, with its
query string reduced to a length.

`web_search` uses the same fetch (so a profile with `:web :allow` must list
`html.duckduckgo.com` to search) and checks the query before it leaves the
host: queries over 256 chars, or carrying API keys / private keys / JWTs,
40+ char encoded blobs, e-mail addresses or phone numbers are refused. These
are pattern checks, not a guarantee. The audit line keeps the query's length
and a sha256 prefix, never its text.

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

## Tests

```
kbb --backend sci --classpath src:test run-tests.cljk
```
