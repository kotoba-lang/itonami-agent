# itonami-agent

- kbb only (`kbb --backend sci`). No new .sh, no JVM, no npm deps (root AGENTS.md).
- Do not add an `nbb.edn` with empty `:deps` — the kbb deps door then fails with
  "The uberjar task needs a classpath". The launcher adds `src/` itself.
- Hermes compatibility is the contract: change a file format only together with
  the Hermes code that reads it, and keep `run-tests.cljk` green.
