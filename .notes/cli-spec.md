# Dark Factory CLI — Minimal Version Spec

Oct 18, 2026 · @Daniel van den Eijkel

## Purpose and scope

This is the cut-down build of [Dark Factory for Bug Resolution — Requirements](Dark%20Factory%20for%20Bug%20Resolution%20—%20Requirements.md), sized for one developer and a few hours. It keeps the trust story: gates that are deterministic code, a locked reproducing test, a black-box fixer, and a merge to `main` with no human approval. It drops the production side entirely.

**In scope**

- A TypeScript CLI, `factory run`, that takes a GitHub repo and an optional commit sha.
- It walks open `factory` issues oldest first. Each issue it cannot handle gets a comment and a `factory:needs-human` label, and the loop moves on. The run stops after the first issue it resolves.
- Resolving an issue means: generate a reproducing test, validate and lock it, hand the repo to a fixer, run the post-checks on the fixer's diff, and commit the test and fix to `main`.
- Swappable LLM provider for the factory's own calls: DeepSeek (default) or Nebius Token Factory.
- Swappable fixer: OMP (default), Claude Code, or a staged rogue fixer.
- A JSONL evidence log per run.
- The minimal target repo with seeded issues, so the demo has something to work on.

**Out of scope** (compared with the full requirements)

- Deploy, canary, feature flag, observer, usage simulator and rollback (R-DEP, R-DPL, R-FLG, R-OBS, R-RB, R-SIM, R-SCN, issue T6). "Shipped" means committed to `main`.
- LLM vetoes (R-PRE-2, R-PRE-9, R-DIFF-9).
- Secret scanner (R-DIFF-7), syntax-tree import and API check (R-DIFF-8; a line-based import check replaces it), changed-line coverage (R-OR-3).
- Signed, hash-chained audit log, verify and replay (R-AUD-2, R-AUD-5, R-AUD-6).
- Pause switch, live view, manual rollback (R-HUM).
- Runtime sandbox for the fixer.

## Principles

The principles P1–P6 from the full requirements still apply. P7 (canary) is dropped with the deploy. In short:

- Only deterministic code can let a change through. LLMs write candidates and nothing else.
- Every gate returns `pass`, `fail` or `unknown`. Only `pass` advances. Everything else, including timeouts, crashes and parse errors, ends with a human.
- The fixer never sees a test it could change and get away with. The pipeline writes the test, hashes it, and checks the hash after applying the fixer's diff.
- The only thing taken from the fixer is a diff, applied by the pipeline to a fresh checkout.
- Every gate writes its verdict and evidence to the log.

## Flow

```mermaid
flowchart TD
    START(["factory run --repo R [--sha S]"]) --> SETUP["Setup<br/>clone · resolve base · venv · labels"]
    SETUP --> SUITE{"Suite green on base?"}
    SUITE -->|no| ABORT(["Abort run, exit 1"])
    SUITE -->|yes| NEXT["Next open factory issue<br/>oldest first, skip status labels"]
    NEXT -->|none left| DONE0(["Exit 3: nothing fixed"])
    NEXT --> IN["Intake<br/>parse form · concrete values · denylist"]
    IN -->|pass| GEN["Generate repro test<br/>LLM"]
    GEN --> VAL["Validate<br/>fails N of N · assertion failure"]
    VAL -->|pass| MATCH["Matches report<br/>inputs · expected · actual"]
    VAL & MATCH -->|"fail, attempts left"| GEN
    MATCH -->|pass| LOCK["Lock test<br/>content + sha256 in memory and log"]
    LOCK --> FIX["Fixer<br/>omp · claude · rogue"]
    FIX -->|diff| APPLY["Apply to fresh checkout"]
    APPLY --> DIFF["Diff checks<br/>tests untouched · hash · paths · size · imports"]
    DIFF -->|pass| ORA["Oracle<br/>repro green N of N · suite green"]
    APPLY & DIFF & ORA -->|"fail, attempts left"| FIX
    ORA -->|pass| MRG["Commit test + fix to main<br/>re-verify if main moved"]
    MRG -->|pushed| RES["Comment · factory:resolved · close"]
    RES --> DONE(["Exit 0"])

    ESC[["Escalate<br/>comment · factory:needs-human"]]
    IN -->|"fail / unknown"| ESC
    VAL & MATCH -->|"unknown, or no attempts left"| ESC
    FIX -->|"timeout · crash · empty diff"| ESC
    APPLY & DIFF & ORA -->|"unknown, or no attempts left"| ESC
    MRG -->|"conflict · checks fail on new head"| ESC
    ESC --> NEXT
```

## CLI

### C-CLI-1 Command

```
factory run --repo <owner/name | github url> [--sha <sha>] [--fixer omp|claude|rogue-edit-test]
            [--provider deepseek|nebius] [--issue <number>] [--dry-run] [--policy <path>]
```

- `--repo` (required): normalised to `owner/name`.
- `--sha`: the base commit. Without it, the base is the head of the remote default branch: `origin/HEAD`, falling back to `main` and then `master`. A sha that does not exist is a usage error.
- `--fixer`: overrides `fixer.name` in the policy.
- `--provider`: overrides `llm.provider` in the policy. The fixer uses the same provider unless `fixer.provider` is set.
- `--issue`: process only this issue, even if older ones are open. Used for the rogue demo and for debugging.
- `--dry-run`: no GitHub writes and no push. Comments, labels and the commit are printed instead. Everything else runs.
- `--policy`: defaults to `factory.policy.json` in the current directory.

### C-CLI-2 Exit codes

| Code | Meaning |
|---|---|
| 0 | One issue resolved and pushed |
| 1 | Factory error (setup failed, suite red on base, GitHub or git error, log write failed) |
| 2 | Usage or configuration error |
| 3 | No issue resolved: none open, or all escalated |

### C-CLI-3 Console output

One line per gate, for example `#12  repro.validate  FAIL  test passed on base in 3/3 runs`. At the end, print the resolved issue and commit URL, or the list of escalated issues.

### C-CLI-4 Environment

Read from the process env (use `node --env-file=.env`):

- `DEEPSEEK_API_KEY`, `NEBIUS_API_KEY`: whichever the selected providers need. A missing key is a configuration error at startup.
- GitHub access goes through the `gh` CLI. It must be logged in (`gh auth status`), with `gh auth setup-git` done so `git push` over HTTPS works.

## Policy file

### C-POL-1 Format

One JSON file, `factory.policy.json`, validated with zod at startup. Its sha256 is written in every log entry. Defaults:

```json
{
  "llm": {
    "provider": "deepseek",
    "providers": {
      "deepseek": {
        "baseURL": "https://api.deepseek.com",
        "anthropicBaseURL": "https://api.deepseek.com/anthropic",
        "apiKeyEnv": "DEEPSEEK_API_KEY",
        "model": "deepseek-v4-pro"
      },
      "nebius": {
        "baseURL": "https://api.tokenfactory.nebius.com/v1/",
        "apiKeyEnv": "NEBIUS_API_KEY",
        "model": "deepseek-ai/DeepSeek-R1-0528"
      }
    },
    "timeoutSec": 120,
    "temperature": 0
  },
  "fixer": {
    "name": "omp",
    "provider": null,
    "model": null,
    "timeoutSec": 600,
    "attempts": 2
  },
  "repro": {
    "dir": "tests/repro",
    "attempts": 2,
    "runs": 3
  },
  "intake": {
    "componentDenylist": []
  },
  "diff": {
    "allowedPaths": ["src/**"],
    "protectedPaths": [
      "tests/**", "**/conftest.py", "pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini",
      ".github/**", "config/**", "requirements*.txt", "*.lock", "Dockerfile", ".env*",
      "factory.policy.json"
    ],
    "maxFiles": 2,
    "maxChangedLines": 20,
    "maxHunks": 3,
    "forbidNewImports": true
  },
  "tests": {
    "python": "python3",
    "timeoutSec": 120
  },
  "git": {
    "authorName": "Dark Factory",
    "authorEmail": "factory@localhost"
  },
  "demoRepo": null
}
```

Check the Nebius model id against the Token Factory catalog before the first Nebius run; it is only a placeholder.

### C-POL-2 Swapping providers

Changing `llm.provider` (or passing `--provider`) is the only step needed to move the factory's own LLM calls between DeepSeek and Nebius. Both use the OpenAI-compatible chat completions API, through the `openai` npm package with `baseURL` and `apiKey` taken from the provider entry. No code branches on the provider name.

## Run setup

### C-RUN-1 Run id and directories

A run id is `YYYYMMDD-HHMMSS-<4 hex>`. All files for a run live under `.factory/runs/<runId>/` in the current directory (gitignored):

```
.factory/runs/<runId>/
  log.jsonl
  base/                       clone of the target repo, checked out at the base sha
  venv/                       Python environment shared by every checkout in this run
  issue-<n>/
    repro-<a>/                checkout used to validate repro attempt a
    locked/test_issue_<n>.py  copy of the locked test, for humans only
    fixer-<k>/                fixer workspace for attempt k
    fixer-<k>.log             fixer stdout and stderr, in full
    fixer-<k>.diff            the diff taken from the fixer
    verify-<k>/               checkout used for post-checks of attempt k
    junit/                    pytest JUnit XML files
```

### C-RUN-2 Base

1. `git clone https://github.com/<repo>.git base`.
2. Resolve the default branch name and the base sha (C-CLI-1). Keep both: the branch is where the fix is pushed.
3. `git checkout --detach <baseSha>`.

### C-RUN-3 Python environment

Create `venv/` with `<tests.python> -m venv`, then install `requirements.txt` and `requirements-dev.txt` from the base checkout if present. Every pytest run uses `<venv>/bin/python -m pytest`. The target package is **not** installed; the target repo's pytest config puts `src` on the path (C-TGT-3), so each checkout tests its own code.

### C-RUN-4 Labels

Create the labels `factory`, `factory:in-progress`, `factory:resolved` and `factory:needs-human` with `gh label create --force`, which is idempotent.

### C-RUN-5 Suite green on base

Run the full suite once on the base checkout (R-PRE-7). If it is not green, nothing that follows can be trusted: log it and exit 1 without touching any issue.

## Checkouts

### C-WS-1 Making a checkout

Every workspace (repro, fixer, verify) is a fresh local clone of `base/`: `git clone -q <runDir>/base <ws>`, then `git checkout -q -b factory/issue-<n> <sha>`. Its `origin` is the local `base/`, so nothing inside it can push to GitHub.

### C-WS-2 Repro commit

To put the locked test into a checkout, write its content (from memory, never from another workspace) to `tests/repro/test_issue_<n>.py` and commit it under the factory identity. Record that commit's sha as `R` for this workspace.

### C-WS-3 Local excludes

Write `.omp/`, `.claude/`, `__pycache__/`, `.pytest_cache/` and `*.pyc` into each checkout's `.git/info/exclude`, so agent state and Python caches never show up in a diff.

## Gates

### C-GATE-1 Shape

```ts
type Verdict = "pass" | "fail" | "unknown";

interface GateResult {
  gate: string;            // e.g. "repro.validate"
  verdict: Verdict;
  reason: string;          // one line, shown in console and issue comments
  evidence: unknown;       // whatever decide() looked at
}
```

Each gate has a `collect` step that may run things (pytest, git, the LLM) and returns evidence, and a `decide(evidence, policy)` step that is a pure function. `decide` functions get unit tests with fixtures; `collect` does not.

Any exception inside a gate becomes `unknown` with the error message as the reason. A command that hits its timeout is `unknown`.

### C-GATE-2 Pytest runner

One helper runs pytest with `-q -p no:cacheprovider --junitxml=<runDir>/issue-<n>/junit/<name>.xml` and a timeout of `tests.timeoutSec`. It returns the exit code, stdout, stderr, whether it timed out, and the parsed JUnit (`fast-xml-parser`): each testcase with outcome `passed | failure | error | skipped` and the failure text.

## Per-issue pipeline

### C-ISS-1 Selection

`gh issue list --repo <repo> --label factory --state open --json number,title,body,labels,createdAt --limit 200`, sorted by `createdAt` ascending. Skip issues that carry `factory:in-progress`, `factory:resolved` or `factory:needs-human`. With `--issue`, take only that issue, but still skip it if it has a status label.

### C-ISS-2 Start

Add `factory:in-progress`. On every exit path out of the issue (resolved, escalated, factory error), remove it again. A crash of the factory itself removes the label and exits 1 without escalating; the issue is picked up on the next run.

### C-IN-1 Parse the issue form

The issue body is the markdown GitHub renders from the form: a `### <Label>` heading per field, then the value. Parse it by heading, case-insensitive, into:

```ts
interface BugReport {
  number: number;
  title: string;
  component: string;
  description: string;
  input: Record<string, Scalar>;   // parsed from the Input field
  expected: Scalar;
  actual: Scalar;
}
type Scalar = number | string | boolean | null;
```

A missing heading, an empty value or `_No response_` is `unknown` with the field name as the reason.

### C-IN-2 Concrete values (gate `intake`)

- `Input` parses as a JSON object with at least one key, and every value is a scalar.
- `Expected` and `Actual` each parse as a JSON scalar. Strings must be quoted: `"SAVE10"`, not `SAVE10`.
- `expected !== actual`.
- `component` is not in `intake.componentDenylist`.

Any failure is `unknown` (the report is not usable, which is a human's call). This is where N2 stops.

### C-PRE-1 Generate (gate `repro.generate`)

One chat completion on the selected provider (prompt in C-PROMPT-1). Take the first ```` ```python ```` block from the answer. No block, an LLM error or a timeout is `fail` and uses up an attempt. The pipeline, not the LLM, writes the file, so the generator can only ever add this one file (R-PRE-4 holds by construction).

### C-PRE-2 Validate (gate `repro.validate`)

In a fresh repro checkout with the candidate test committed (C-WS-2), run only the new test `repro.runs` times. Each run must:

- exit with code 1 (tests failed; 2, 4 and 5 mean interrupted, usage error or no tests);
- contain at least one testcase, and every testcase is `failure`, not `error` or `skipped`;
- have a failure text whose first line starting with `E ` matches `^E\s+(assert\b|AssertionError\b)`. A `TypeError` or `ImportError` is the wrong reason to fail (R-PRE-5).

All runs good: `pass`. All runs bad: `fail`, with the first run's reason, for example "test passed on base" or "fails with TypeError, not an assertion". Mixed: `unknown` (flaky, R-PRE-6). Timeout: `unknown`. This is where N1 stops.

### C-PRE-3 Matches the report (gate `repro.match`)

Pure checks on the test source and the failure text from C-PRE-2 (R-PRE-8):

- **Inputs:** each value in `report.input` appears as a literal in the test source.
- **Expected:** `report.expected` appears as a literal on a line whose stripped text starts with `assert`.
- **Actual:** `report.actual` appears as a literal in the `E ` lines of the first failure text.
- **Hygiene:** the source contains `def test_` and none of `pytest.mark.skip`, `pytest.mark.xfail`, `pytest.skip(`.

Literal matching:
- Numbers: extract numeric literals with `(?<![\w.])-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?` and compare numerically within `1e-9`, so `0.00`, `0.0` and `0` all match.
- Strings: `"value"` or `'value'`.
- `true`, `false`, `null`: `True`, `False`, `None`.

Any check missing is `fail`, naming the check.

### C-PRE-4 Attempts

Up to `repro.attempts` rounds of generate, validate and match. A `fail` starts the next round, and the prompt gets the previous reason. An `unknown` escalates at once. After the last round fails, escalate with the last reason. The fixer never runs.

### C-PRE-5 Lock (gate `repro.lock`)

Keep the test content and its sha256 in memory, write the hash and the full source to the log, and write a copy to `issue-<n>/locked/` for humans. From here on, every workspace gets the test from memory (C-WS-2).

### C-FIX-1 Fixer interface

```ts
interface FixerInput {
  workspace: string;        // checkout with the repro commit R at HEAD
  prompt: string;           // C-PROMPT-2
  testCommand: string;      // e.g. "<venv>/bin/python -m pytest tests/repro/test_issue_12.py -q"
  provider: ProviderConfig; // resolved provider entry, incl. API key value
  model: string;
}

interface FixerLaunch {
  cmd: string;
  args: string[];
  env: Record<string, string>;  // added to the base env (C-FIX-3)
}

interface Fixer {
  name: string;
  supports(providerName: string): boolean;
  launch(input: FixerInput): FixerLaunch;
}
```

Adapters live in `src/fixers/` and are listed in a registry keyed by name. Adding a fixer is one file and one registry line; the pipeline has no fixer-specific code. At startup, if the chosen fixer does not support the chosen provider, exit 2 with a clear message.

### C-FIX-2 Adapters

| Fixer | Providers | Launch |
|---|---|---|
| `omp` | deepseek, nebius | `omp -p --cwd <ws> --model <provider>/<model> --api-key <key> --auto-approve --no-session --no-extensions --no-skills --no-rules --max-time <timeoutSec>s <prompt>`. DeepSeek is a built-in OMP provider (`deepseek/deepseek-v4-pro`). Nebius needs a custom OpenAI-compatible provider in an overlay passed with `--config fixers/omp-nebius.yml`; check the overlay format in the OMP docs when wiring it up. |
| `claude` | deepseek | `claude -p --output-format json --permission-mode bypassPermissions --max-turns 40 <prompt>`, cwd `<ws>`, env `ANTHROPIC_BASE_URL=<anthropicBaseURL>`, `ANTHROPIC_AUTH_TOKEN=<key>`, `ANTHROPIC_MODEL=<model>`, `ANTHROPIC_SMALL_FAST_MODEL=<model>`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Nebius has no Anthropic-compatible endpoint, so `supports("nebius")` is false. |
| `rogue-edit-test` | any | `node <factory>/dist/fixers/rogue.js edit-test`, cwd `<ws>`. Replaces every `assert` line in `tests/repro/test_issue_<n>.py` with `assert True`, changes nothing else. |

The model is `fixer.model` if set, else the provider's `model`.

### C-FIX-3 Running the fixer (gate `fixer.run`)

- Fresh fixer checkout (C-WS-1, C-WS-2), with `R` recorded before the fixer starts.
- Base env is only `PATH` (with `<venv>/bin` first), `HOME`, `LANG`, `TERM=dumb`, plus the adapter's env. `GITHUB_TOKEN`, `GH_TOKEN` and the other provider's key are never passed (R-FIX-7).
- Spawn detached; on `fixer.timeoutSec` kill the whole process group. Write stdout and stderr to `fixer-<k>.log`.
- After exit: `git add -A`, then `git diff --cached --binary R > fixer-<k>.diff`. Diffing against `R` also captures any commits the fixer made.
- Timeout: `unknown`. Non-zero exit: `unknown`. Empty diff: `unknown` with reason "fixer made no change". Each escalates at once (R-FIX-3).

### C-POST-1 Apply (gate `post.apply`)

Fresh verify checkout (C-WS-1, C-WS-2). `git apply --check` then `git apply` with the fixer's diff. Does not apply: `fail`.

### C-POST-2 Diff checks (gate `post.diff`)

Evidence comes from `git apply --numstat --summary` on the patch, the patch text, and the file on disk after applying. Checks in this order, first failure wins:

1. **Tests untouched:** no changed path is under `tests/`, or named `test_*.py`, `*_test.py` or `conftest.py` (R-DIFF-2).
2. **Locked hash:** sha256 of `tests/repro/test_issue_<n>.py` on disk equals the locked hash (R-DIFF-3).
3. **Protected paths:** no changed path matches `diff.protectedPaths` (picomatch). The reason names the path. This is where N3 should stop.
4. **Allowed paths:** every changed path matches `diff.allowedPaths`.
5. **File operations:** no binary files (numstat `-`), no `create mode`, `delete mode`, `rename`, `mode change` or symlink (`120000`) in the summary.
6. **Size:** at most `maxFiles` files, `maxChangedLines` added plus removed lines, `maxHunks` lines starting with `@@ `.
7. **No new imports** (if `forbidNewImports`): no added line (`+`, not `+++`) matching `^\+\s*(import\s|from\s+\S+\s+import\s)` or containing `__import__(` or `importlib`.

All pass: `pass`. Otherwise `fail` with the check and the offending path or line.

### C-POST-3 Oracle (gate `post.oracle`)

In the verify checkout:

- the repro test passes in `repro.runs` of `repro.runs` runs (exit 0, every testcase passed);
- the full suite passes once (exit 0, no failures or errors).

Any failure: `fail`. Timeout: `unknown`.

### C-POST-4 Fixer attempts

Up to `fixer.attempts`. A `fail` from `post.apply`, `post.diff` or `post.oracle` starts a new attempt in a fresh fixer checkout; the prompt gets the previous gate and reason. An `unknown` escalates at once. After the last attempt fails, escalate with the last reason.

### C-MRG-1 Commit

In the verify checkout, squash the repro commit and the fix into one commit on top of the base sha (`git reset --soft <baseSha>`, then commit under the factory identity):

```
Fix #<n>: <issue title>

Adds the reproducing test tests/repro/test_issue_<n>.py and the fix.

Factory-Run: <runId>
Fixer: <fixer> (<provider>/<model>)
Test-SHA256: <hash>
```

### C-MRG-2 Push (gate `merge`)

1. `git fetch https://github.com/<repo>.git <branch>` and read the remote head.
2. Remote head equals the base sha: push `HEAD:<branch>` to the GitHub URL. Never force.
3. Remote head moved (or the push was rejected): make a fresh verify checkout at the new head, add the locked test, apply the same diff, run C-POST-2 and C-POST-3 again, commit as in C-MRG-1 on top of the new head, and push. A conflict or a failed check escalates. A second rejection is `unknown` and escalates.

This also covers `--sha` pointing at an older commit: the diff is re-verified on the current head before it ships (R-MRG-1).

### C-RES-1 Resolve

Comment on the issue, add `factory:resolved`, remove `factory:in-progress`, `gh issue close --reason completed`. Then stop the run and exit 0.

```
Resolved by the dark factory.

Commit: <commit url>
Run: <runId> · base <short sha> · fixer <fixer> (<provider>/<model>)

| Gate | Verdict |
|---|---|
| intake | pass |
| repro.validate | pass (failed 3/3 on base with an assertion) |
| ... | ... |
```

### C-ESC-1 Escalate

Comment, add `factory:needs-human`, remove `factory:in-progress`, leave the issue open. Never retried automatically (R-ESC-3). Then continue with the next issue.

```
The dark factory needs a human for this issue.

Stage: <gate>
Verdict: <fail|unknown>
Reason: <reason>
Run: <runId> · base <short sha>
Evidence: .factory/runs/<runId>/log.jsonl on the factory host
```

## Prompts

### C-PROMPT-1 Test generator

System: "You write exactly one pytest test that reproduces a bug report. Answer with one ```python code block and nothing else."

User message, in this order:

1. The report: title, component, description, input (as JSON), expected, actual.
2. The repo file list (`git ls-files`).
3. The content of every file under `src/`, capped at 100 KB in total.
4. The first file under `tests/` (excluding `tests/repro/`) as a style example, capped at 10 KB.
5. Rules:
   - One test function named `test_issue_<n>`, in a file that will be saved as `tests/repro/test_issue_<n>.py`.
   - Import the code under test the same way the example test does.
   - Call the code with the input values from the report, written as literals.
   - The `assert` line compares the result with the expected value written as a literal, for example `assert result == 0.00` or `assert result == pytest.approx(11.96)`.
   - No mocks of the code under test, no network, no files, no sleeps, no skips.
   - The test must fail on the current code with an assertion error and pass once the bug is fixed.
6. If this is a retry: "Your previous test was rejected: <reason>. Write a new one."

### C-PROMPT-2 Fixer

```
Fix bug #<n> in this repository.

Title: <title>
Component: <component>
Description: <description>
Input: <input json>
Expected: <expected>
Actual: <actual>

A test that reproduces the bug is at tests/repro/test_issue_<n>.py. It fails now and must pass after your fix.
Run it with: <testCommand>

Rules:
- Change only files under src/. Do not add, change, rename or delete tests, test configuration, config files or dependencies.
- Make the smallest change that fixes the root cause. Do not special-case the test's input values.
- Do not add imports.
- Do not commit. Leave your changes in the working tree.
- If the bug cannot be fixed within these rules, stop without changing anything.
```

On a retry, append: "Your previous attempt was rejected by <gate>: <reason>."

## Evidence log

### C-LOG-1 Entries

`.factory/runs/<runId>/log.jsonl`, one JSON object per line, appended and flushed per entry:

```json
{"ts": "...", "runId": "...", "repo": "owner/name", "baseSha": "...", "issue": 12,
 "gate": "repro.validate", "attempt": 1, "verdict": "fail", "reason": "...",
 "evidence": { }, "policySha256": "..."}
```

- Logged: setup (base sha, branch, fixer, provider, model), every gate result, the full repro test source and hash at lock, the full fixer diff, the commit sha and push result, every GitHub write.
- Long text (stdout, stderr) is cut to its last 20 KB in the log; full output stays in the files under `issue-<n>/`.
- If writing an entry fails, the run stops with exit 1 (R-AUD-7).

## Target repo

The full spec is in [target-repo.md](target-repo.md). For this build, only these parts are needed.

### C-TGT-1 Code and suite

R-TR-1, R-TR-2 and R-TR-4: the shop pricing service in `src/`, about 30 green tests in `tests/` that miss every seeded bug, an empty `tests/repro/` (with a `.gitkeep`), `config/shipping_rates.yaml`. No Dockerfile, router or deploy needed.

### C-TGT-2 Issue form

`.github/ISSUE_TEMPLATE/bug.yml` with label `factory` and these fields, whose labels are the headings the parser reads:

| Label | Type | Notes |
|---|---|---|
| Component | dropdown | shipping, pricing, discounts, checkout, inventory |
| Description | textarea | |
| Input | textarea | JSON object, e.g. `{"cart_total": 50.00, "country": "DE"}` |
| Expected | input | JSON value, e.g. `0.00` or `"SAVE10"` |
| Actual | input | JSON value |

### C-TGT-3 Pytest config

`pyproject.toml` sets `[tool.pytest.ini_options] pythonpath = ["src"]` and `testpaths = ["tests"]`. `.gitignore` covers `__pycache__/`, `.pytest_cache/` and `*.pyc`.

### C-TGT-4 Seeded issues

Issue files live in the factory repo under `seed/issues/` (one markdown file per issue, in the rendered form format), filed with `gh issue create --label factory --body-file`. Seed order, which is also processing order:

| Order | Id | Input | Expected | Actual | Intended outcome |
|---|---|---|---|---|---|
| 1 | N2 | not JSON: "a big order" | "the correct total" (unquoted) | "a wrong total" (unquoted) | `intake` |
| 2 | T1 | `{"cart_total": 50.00, "country": "DE"}` | `0.00` | `4.99` | resolved |
| 3 | N1 | `{"sku": "LAMP", "reservations": 2}` | `0` | `-1` | `repro.validate` |
| 4 | T2 | `{"amount": 10.05, "vat_rate": 0.19}` | `11.96` | `11.95` | resolved |
| 5 | N3 | `{"cart_total": 20.00, "country": "AT"}` | `5.00` | `15.00` | `post.diff`, protected path |
| 6 | T3 | `{"code": "save10", "amount": 100.00}` | `90.00` | `100.00` | resolved |
| 7 | T4 | `{"price": 12.50}` | `12.50` | `0.00` | resolved |
| 8 | T5 | `{"price": 100.00, "code": "SAVE10"}` | `90.00` | `81.00` | resolved |

With this order, run 1 escalates N2 and resolves T1, run 2 escalates N1 and resolves T2, and so on.

### C-TGT-5 Reset (should)

`factory reset --repo <owner/name>` for rehearsals: refuses any repo other than `demoRepo` in the policy; force-pushes the default branch to the `seed` tag; closes all open issues; re-files `seed/issues/`. This is destructive by design.

## Implementation

### C-IMP-1 Stack

Node 22, TypeScript, ESM, run with `tsx` during development and `tsc` for `dist/`. Dependencies: `commander`, `execa`, `openai`, `fast-xml-parser`, `picomatch`, `zod`; `vitest` for tests. `package.json` `bin` maps `factory` to `dist/cli.js`.

### C-IMP-2 Layout

```
factory.policy.json
seed/issues/*.md
fixers/omp-nebius.yml
src/
  cli.ts              argument parsing, exit codes
  config.ts           policy load + zod schema + hash, env checks
  log.ts              JSONL evidence log
  exec.ts             execa wrapper: timeout, process-group kill, {code, stdout, stderr, timedOut, ms}
  github.ts           gh wrappers: list issues, comment, labels, close (dry-run aware)
  git.ts              clone, checkout, commit, diff, apply, fetch, push
  workspace.ts        C-WS-1..3
  pytest.ts           run pytest + parse JUnit (C-GATE-2)
  llm.ts              OpenAI-compatible client from provider config
  report.ts           issue body parser (C-IN-1)
  literals.ts         literal matching shared by repro.match
  gates/
    intake.ts
    repro.ts          generate, validate, match, lock
    diff.ts
    oracle.ts
  fixers/
    index.ts          registry
    omp.ts
    claude.ts
    rogue.ts
  pipeline.ts         per-issue state machine, attempts, escalate/resolve
test/
  *.test.ts           decide() functions, report parser, literal matching
```

### C-IMP-3 Build order

Each step ends with something runnable.

1. **Smoke tests by hand.** `omp -p --model deepseek/deepseek-v4-pro "say hi"`, the same through Claude Code against the DeepSeek Anthropic endpoint, and one chat completion against DeepSeek with the `openai` package. Fix adapter flags now, not later.
2. **Target repo.** Code, suite, issue form, pytest config, seed files, seeding script.
3. **Skeleton.** `cli.ts`, `config.ts`, `log.ts`, `exec.ts`, `github.ts`, run setup (C-RUN-*), issue loop, intake and escalation. Demo: N2 escalates.
4. **Repro.** Generate, validate, match, lock. Demo: N1 escalates; T1 gets a locked test.
5. **Fixer.** Registry, `omp` adapter, diff capture.
6. **Post-checks and merge.** Apply, diff, oracle, commit, push, resolve. Demo: T1 resolved end to end; N3 escalates.
7. **Rogue and Claude.** `rogue-edit-test` (stopped by `post.diff` tests untouched), `claude` adapter. Demo: `--issue <T> --fixer rogue-edit-test` escalates; `--fixer claude` resolves a T issue.
8. **If time:** Nebius provider and OMP overlay, `factory reset`, unit tests for `decide` functions.

## Acceptance

- **A-1** Starting from the seeded state, repeated `factory run --repo <demo>` resolves T1–T5, one per run. Each leaves one commit on `main` containing `tests/repro/test_issue_<n>.py` and a change under `src/`, a resolve comment, the `factory:resolved` label and a closed issue.
- **A-2** N2 is escalated at `intake`, N1 at `repro.validate`, N3 at `post.diff`. The fixer never runs for N1 or N2. Nothing from them reaches `main`.
- **A-3** `--fixer rogue-edit-test --issue <T>` is escalated at `post.diff` with reason "tests untouched".
- **A-4** Once every seeded issue is resolved or escalated, `factory run` exits 3 without touching GitHub.
- **A-5** Each run's `log.jsonl` has an entry for every gate that ran, and the locked test hash in the log matches the test committed to `main`.
- **A-6** Switching `--fixer omp` to `--fixer claude` and `--provider deepseek` to `--provider nebius` (for the factory's own LLM calls) needs no code change.

## Known limits

- No sandbox: the fixer runs as the local user and can read anything that user can, including `gh` credentials under `HOME`. Only its diff is checked. Acceptable for the demo; say so openly.
- N1 may stop somewhere else if the LLM manages to write a multi-process test that reproduces the race. If rehearsal shows that, add `inventory` to `intake.componentDenylist`.
- N3 ships if the fixer hardcodes `if country == "AT"` in code rather than editing the protected config. The fixer prompt forbids special-casing, but nothing deterministic enforces it; the LLM diff veto (R-DIFF-9) is the full version's answer. Rehearse it.
- A fixer can special-case the test's exact input in general; see the holdout test under "Later" in the full requirements.
- The import check is line-based and specific to Python.
