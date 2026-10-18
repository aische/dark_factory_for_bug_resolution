# Target Repo and Production Simulation — Requirements

Oct 18, 2026 · @Daniel van den Eijkel

## Purpose and scope

The factory needs something to work on and somewhere to ship to. This document covers both:

- a **target repo** on GitHub with seeded issues, some trivial and some the factory must refuse;
- a **local production simulation** in Docker: deployment, a feature flag, an observer that can turn the flag off and trigger rollback, a rollback mechanism, and simulated users whose traffic occasionally hits a bug.

The factory itself is specified in [Dark Factory for Bug Resolution — Requirements](Dark%20Factory%20for%20Bug%20Resolution%20—%20Requirements.md). Its gated deploy (R-DEP) runs against the simulation described here.

**Where things live**

- The **target repo** holds only the application: code, tests, Dockerfile, issue form. This is what the fixer sees.
- The **factory repo** holds the production simulation: router, observer, simulator, deploy controller, Compose file. The fixer never sees it.

## Runtime overview

```mermaid
flowchart LR
    SIM["Usage simulator<br/>seeded user traffic"] --> R["Router<br/>canary flag = traffic weight"]
    R -->|"100 − w %"| S["app-stable<br/>shop image, sha A"]
    R -->|"w %"| C["app-canary<br/>shop image, sha B"]
    R -.->|"per-version metrics"| OBS["Observer<br/>SLO check"]
    OBS -->|"1 · breach: flag off"| R
    OBS -->|"2 · breach: rollback"| CTL["Deploy controller<br/>deployctl"]
    CTL -->|"start · stop · promote"| C
    CTL -->|"git revert + push"| GH[("Target repo<br/>on GitHub")]
    F["Factory"] -->|"deploy-canary · promote"| CTL
    OBS -.->|"verdict + events"| F
    H["Human"] -.->|"flag · rollback · status"| CTL
```

## Requirements

Values marked *(config)* are defaults in the simulation's config file. SLO values match the factory policy (R-DEP-4).

### Target repo (R-TR)

- **R-TR-1** A small Python web service, a "shop pricing" API, with endpoints for cart totals, discounts, checkout, shipping quotes and inventory reservation. About 10 core functions.
- **R-TR-2** A pytest suite of about 30 tests that runs in under 10 seconds and is green on `main`. It must **not** detect any seeded bug; otherwise the factory's base-commit check (R-PRE-7) fails.
- **R-TR-3** The suite has deliberate **coverage gaps** that the usage simulator exercises (R-SIM-3). They are listed in the repo's README so the gap is documented, not accidental:
  - a shipping quote without a country;
  - checkout with a `null` discount code.
- **R-TR-4** Layout: application code in `src/`, existing tests in `tests/`, an empty `tests/repro/` for factory-generated tests, protected configuration in `config/`, a `Dockerfile`, and the issue form in `.github/ISSUE_TEMPLATE/`.
- **R-TR-5** The repo is hosted on GitHub. `main` is the only deploy source. The deploy controller holds the only credentials that push to it besides the factory.
- **R-TR-6** The issue form has the fields from R-IN-1 (component, description, input, expected, actual) and adds the `factory` label.
- **R-TR-7** Every endpoint returns 4xx for invalid input and 5xx only for server faults. The observer counts only 5xx as errors.
- **R-TR-8** The service exposes `/healthz` and `/version`. `/version` returns the commit sha the image was built from.

### Seeded issues (R-ISS)

- **R-ISS-1** The repo is seeded with the issues below, filed through the issue form. Inputs, expected and actual values are concrete so the factory's report match (R-PRE-8) can work.
- **R-ISS-2** Every trivial bug returns a wrong value. None of them raises an exception, so a reproducing test fails on an assertion (R-PRE-5).
- **R-ISS-3** Every trivial bug's correct fix is a change of at most 5 lines in one file under `src/`.

*Trivial: expected to be resolved end to end*

| Id | Component | Input | Expected | Actual | Cause |
|---|---|---|---|---|---|
| T1 | shipping | quote, `cart_total` 50.00, country `DE` | shipping 0.00 | 4.99 | free-shipping check uses `>` instead of `>=` |
| T2 | pricing | cart total 10.05 with 19% VAT | 11.96 | 11.95 | amount truncated instead of rounded half up |
| T3 | discounts | apply code `save10` to 100.00 | 90.00 | 100.00 | code lookup is case-sensitive |
| T4 | pricing | cart with one item, price 12.50, no quantity | 12.50 | 0.00 | quantity defaults to 0 instead of 1 |
| T5 | checkout | one item at 100.00 with code `SAVE10` | 90.00 | 81.00 | discount applied twice |

*Rollback scenario: resolved by a staged fixer, then rolled back in production (R-SCN)*

| Id | Component | Input | Expected | Actual | Cause |
|---|---|---|---|---|---|
| T6 | shipping | quote, `cart_total` 20.00, country `de` | shipping 5.00 (EU rate) | 15.00 (international) | country lookup is case-sensitive |

*Non-trivial: must be refused, each at a different gate*

| Id | Component | Report | Why it is not trivial | Intended gate |
|---|---|---|---|---|
| N1 | inventory | Two customers can both reserve the last unit of `LAMP`; stock goes to −1. | The race only happens across worker processes. The code holds a thread lock, so an in-process test cannot reproduce it. | R-PRE-5 / R-PRE-6: no reliably failing test. Escalated; fixer never runs. |
| N2 | pricing | "Totals are sometimes wrong for big orders." Expected: "the correct total". Actual: "a wrong total". | No concrete input, expected or actual value. | R-PRE-1: expected and actual are not concrete values. Escalated before test generation. |
| N3 | shipping | Shipping to `AT` is charged the international rate 15.00 instead of the EU rate 5.00. | The cause is a missing entry in `config/shipping_rates.yaml`, a protected path. | R-DIFF-5: protected path. Escalated after the fixer runs. |

- **R-ISS-4** Each non-trivial issue must be refused at its intended gate in rehearsal. If rehearsal shows a different outcome (for example, a test for N1 does reproduce the race reliably), the issue is redesigned or its component is added to the intake denylist.
- **R-ISS-5** Known risk for N3: a fixer can work around the config file in code (`if country == "AT"`). The diff reviewer veto (R-DIFF-9) is the backstop. Rehearsal confirms the outcome.

### Deployment (R-DPL)

- **R-DPL-1** The whole simulation runs with Docker Compose on a laptop and starts with one command.
- **R-DPL-2** The deploy controller builds an image from the target repo at a given commit sha, tagged with that sha. A build takes at most 60 seconds with a warm cache.
- **R-DPL-3** Two app containers run side by side: `app-stable` with the current stable image and `app-canary` with the candidate image. Only `app-canary` is stopped when there is no candidate.
- **R-DPL-4** A router is the only public entry point (port 8080, *config*). It splits traffic between stable and canary according to the canary flag (R-FLG), using deterministic weighted round-robin so runs are reproducible.
- **R-DPL-5** The router adds a header naming the version that served each response, and records per-version metrics: request count, 5xx count and latency.
- **R-DPL-6** Before a canary receives traffic, the controller waits for its `/healthz` (30 s timeout, *config*). A failed start counts as a breach and rolls back (R-RB).
- **R-DPL-7** The deploy controller is a CLI, `deployctl`, with these commands. Each prints a JSON result that the factory writes to its audit log:
  - `build <sha>`
  - `deploy-canary <sha>`
  - `flag set <weight>`
  - `promote`
  - `rollback [--to <sha>]`
  - `status`
- **R-DPL-8** Promotion replaces `app-stable` with the canary image, sets the flag to 0 and stops `app-canary`.
- **R-DPL-9** The controller keeps deployment state (stable sha, canary sha, history of deploys, promotions and rollbacks) in a local file that survives container restarts.
- **R-DPL-10** The last 5 images (*config*) are kept locally so rollback never needs a rebuild.

### Feature flag (R-FLG)

- **R-FLG-1** One flag, `canary`, with a weight from 0 to 100. Off means 0: all traffic goes to stable.
- **R-FLG-2** The factory turns the flag on to the canary weight (10, *config*) after a healthy canary start.
- **R-FLG-3** A flag change applies to new requests within 1 second.
- **R-FLG-4** Every flag change is recorded with who changed it (factory, observer or human), when, and why.
- **R-FLG-5** A human can set the flag at any time with `deployctl flag set`.

### Observer (R-OBS)

- **R-OBS-1** The observer runs as its own container, independent of the factory, so it can protect production even if the factory process dies.
- **R-OBS-2** While a canary is live, it reads the router's metrics every 2 seconds (*config*) and computes, per version over the observation window: request count, error rate (5xx) and p95 latency.
- **R-OBS-3** SLO rule, matching R-DEP-4: canary error rate at most stable's plus 1 percentage point, and canary p95 latency at most 1.5× stable's. No verdict is given before the canary has served at least 50 requests (*config*).
- **R-OBS-4** A breach is acted on as soon as it is detected; the observer does not wait for the end of the window. Pass is only given at the end of the window (60 s, *config*). Too few canary requests at the end of the window is Unknown, and Unknown is handled like a breach.
- **R-OBS-5** On a breach the observer acts in this order:
  1. turn the flag off, within 2 seconds of detection;
  2. trigger rollback (R-RB).

  Turning the flag off stops the harm at once; rollback then cleans up.
- **R-OBS-6** The verdict is a deterministic function of the metric snapshot and the SLO config (P1). Each verdict, flag change and rollback is written as an event, with the metric snapshot as evidence, to an event log that the factory copies into its audit trail.

### Rollback (R-RB)

- **R-RB-1** Rolling back a canary means:
  1. flag set to 0 (if not already);
  2. `app-canary` stopped;
  3. the factory commit reverted on `main` and pushed;
  4. the rollback recorded in the deployment state and the event log.
- **R-RB-2** Rolling back after promotion means redeploying the previous stable image from the local cache (R-DPL-10) and reverting the commit, within 30 seconds.
- **R-RB-3** Traffic rollback never depends on GitHub or Nebius being reachable. If the push of the revert fails, the rollback still completes locally, `status` shows the revert as pending, and the push is retried.
- **R-RB-4** Rollback is idempotent: running it twice has the same effect as running it once.
- **R-RB-5** A human can trigger rollback at any time with `deployctl rollback`.
- **R-RB-6** After a rollback, the factory escalates the GitHub issue (R-ESC-2). If the factory is down, the escalation happens when it next starts and reads the event log.

### Usage simulator (R-SIM)

- **R-SIM-1** A container sends steady traffic through the router: 20 requests per second (*config*), mixing realistic shop flows: shipping quotes, cart totals, discount codes, checkout and inventory reservations.
- **R-SIM-2** The traffic is driven by a seeded random generator (*config*). The same seed produces the same request sequence.
- **R-SIM-3** A share of requests use inputs at the edge of what users do, which the test suite deliberately does not cover (R-TR-3): shipping quotes without a country, and checkout with a `null` discount code. Default: 20% of shipping quotes have no country, 10% of checkouts have a `null` code (*config*).
- **R-SIM-4** With correct code, every simulated request returns 2xx or 4xx. The seeded trivial bugs produce wrong values, not errors, so they never trigger rollback; that is why they arrive as issues.
- **R-SIM-5** The simulator shows live counts of requests and errors per version, for the demo's live view.
- **R-SIM-6** With the default settings, a canary that returns 5xx for the edge inputs in R-SIM-3 must breach the SLO within the observation window in every rehearsal run.

### Rollback scenario (R-SCN)

This is the demo of R-DEP-5: a fix that passes every gate but breaks in production, and undoes itself.

- **R-SCN-1** Issue T6 is processed by a staged fixer, `fragile`. Its diff fixes the reported bug by upper-casing the country (`country.upper()`), but crashes with a 5xx when the country is missing.
- **R-SCN-2** The diff passes every factory gate: the reproducing test goes green, the suite stays green (it does not cover missing countries, R-TR-3), and the diff is small, in `src/`, with no protected paths or new imports.
- **R-SCN-3** The factory merges the diff, deploys it as canary and turns the flag on.
- **R-SCN-4** The simulator's quotes without a country reach the canary and fail. The observer detects the breach, turns the flag off and triggers rollback. `main` gets a revert commit. The factory escalates T6 on GitHub with the observer's evidence.
- **R-SCN-5** Acceptance:
  - errors are seen only on the canary, never on stable;
  - the flag is off within 2 seconds of detection;
  - rollback completes within 30 seconds of detection;
  - `main` contains the revert commit;
  - the audit trail contains the breach evidence, the flag change and the rollback.
- **R-SCN-6** The demo says openly that `fragile` is a staged fixer: the point is to show the canary catching what the gates cannot.

### Reset (R-RST)

- **R-RST-1** One command resets everything to the seeded state for a rehearsal: containers stopped, images other than the seed image removed, `main` force-pushed back to the `seed` tag, all issues closed, the seeded issues re-created, factory labels removed, deployment state and event log cleared.
- **R-RST-2** Reset only runs against the configured demo repo and refuses any other repo name. It is destructive by design.
- **R-RST-3** A reset completes within 1 minute.

### Non-functional (R-NF)

- **R-NF-1** Runs on a laptop with Docker. No cloud resources besides GitHub.
- **R-NF-2** The seeded issues live as files in the factory repo (one per issue) so reset can re-create them exactly.

## Open decisions

1. GitHub owner and visibility of the target repo (team org, public or private).
2. Router implementation: a small Python proxy we write (recommended, easy per-version metrics and weights) or Traefik/nginx.
3. Post-promotion watch: whether the observer keeps watching stable for a grace period after promotion and rolls back to the previous image on a breach. Optional; adds a second rollback path to demo.
