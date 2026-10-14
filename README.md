# itonami-agent

A Hermes-compatible agent written in kotoba (`.cljk` on kbb), with peer-to-peer
execution of agent turns. The agent core needs only the kbb engine; no JVM or
npm packages. Cron jobs written in Hy additionally need Python with Hy installed.

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
| tools `terminal read_file write_file patch search_files web_search web_extract skills_list skill_view skill_manage todo_list delegate_task cronjob_manage memory execute_code session_search ha_list_entities ha_get_state ha_list_services ha_call_service`; toolsets `terminal`, `file`, `web`, `search`, `skills`, `todo`, `memory`, `session_search`, `code_execution`, `homeassistant` | these names have Kotoba handlers and JSON-string results; some semantics remain partial. Kotoba `execute_code` runs one confined, stateless Python source string and does not expose `hermes_tools` RPC. Kotoba `session_search` reads only the current profile's local `state.db` and supports bounded browse, FTS discovery, read, and scroll; cross-profile lookup and Hermes adaptive detail are not implemented. `hermes-cli`/`hermes-cron` retain Hermes' full core inventory and refuse to start when any selected tool is unsupported, rather than silently presenting a reduced bundle |
| `cron/jobs.json` (including `monitor_script` / `monitor_url`), 5-field cron / interval / once schedules | read and written in Hermes' format; Kotoba can create, list, and update monitor jobs, then evaluates the monitor before the agent turn |
| Pre-run script extensions `.sh`/`.bash`, `.cljk`, `.js`/`.mjs`, `.py`, `.hy` | extension dispatch; `.hy` runs through `hy.cmdline.hy_main` with the job/config-selected Python, which must have Hy installed |
| cron prompt: `_CRON_HINT`, `## Script Output` / `## Script Error` block, empty stdout and `{"wakeAgent": false}` skip, `[SILENT]`, `[CRON_FAILURE]` | identical text and semantics |
| `cron/output/<id>/<YYYY-MM-DD_HH-MM-SS>.md`, newest 50, mode 0600 | identical layout (adds `**Engine:**` / `**Peer:**` lines) |
| `usage_audit.jsonl`, `ticker_heartbeat`, `ticker_last_success` | written |
| `-p`, `-z` (stdout = final text, exit 1 + `… -z: reason` on stderr), `-m`, `--provider`, `-t`, `cron list/create/run/tick/runs/status`, `profile list/show`, `chat` | same commands; `cron create` also accepts `--no-agent`, `--monitor-script`, and `--monitor-url` |
| `executions.db`, incidents, notepad, messaging gateway adapters, browser tools, MCP | **not implemented**; itonami logs runs to `cron/itonami-runs.jsonl` |

`delegate_task` is currently limited to up to three parallel foreground turns.
Hermes background/list/steer/stop controls, image inputs, and output-schema
validation are not implemented. This is partial tool-contract coverage, not
full Hermes agent parity.

Home Assistant uses the profile's `HASS_URL` / `HASS_TOKEN` (default URL:
`http://homeassistant.local:8123`); redirects are refused and the service-call
domains that can execute commands or issue arbitrary HTTP requests are blocked.
`ha_call_service` requires approval. `terminal(background=true)` is explicitly
rejected until process management is implemented; `skill_manage` has remaining
staged-review/curator differences from Hermes, and cron delivery adapters are
not wired. These limitations must be closed before claiming full agent parity
or adopting profiles that depend on them.

The CLJK turn API accepts prior user/assistant history and per-request
instructions, in addition to the current prompt. Tool rows remain scoped to the
turn that produced them; only the user/assistant transcript is carried into the
next request, matching the current Kotoba Desktop gateway's normalized history.

`itonami-agent bridge` exposes this turn API to a local host over stdin/stdout:
one JSON request containing an explicit `tool_names` array, then JSONL event rows
and one terminal result row. It refuses any requested tool the Kotoba agent
does not implement; it never silently narrows a caller's requested tool set.

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
- `profile refresh-bundle <p>` recomputes the CID after files change without
  replacing the rest of `itonami.edn` (including custom bundle directories and
  scheduler ownership).

Hy cron scripts use the first configured interpreter among the job's
`interpreter`, `cron.script_python`, `ITONAMI_PYTHON`, `HERMES_PYTHON`, then
`python3`. That interpreter must provide `hy` (the fleet target is Hy 1.3.1).
The dispatcher inserts the script directory into `sys.path` and preserves
arguments after the script path, matching the `.py` job contract. When launched
by Kotoba Gateway, the scheduler also supplies its vendored Hy dependency via
`KOTOBA_HY_DEPS`; direct CLI runs still require Hy in the selected interpreter.

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

### Linux (bwrap) differs from macOS (Seatbelt)

bwrap matches paths, not patterns. Under it the whole home directory is an
empty tmpfs for every run, local ones too, and only the run's roots, the
profile home and the PATH toolchains are shown back; each `*.env`,
`*.env.*`, `secrets.command` and `auth.json` found under them (node_modules
and .git pruned) is masked with /dev/null. If that scan takes over 15 s the
command is refused. So a local run on Linux sees less of the home directory
than on macOS, and a dotenv outside the home directory (e.g. /srv/app/.env)
is not masked there. Verified on Linux 6.15 / bubblewrap 0.8.0 in a
container (2026-10-09): the same 193 assertions pass, and with the sandbox
bypassed 18 attack assertions fail.

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
