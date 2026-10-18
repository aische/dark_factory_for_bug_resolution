# Dark Factory CLI — Minimal Version Spec

Oct 18, 2026 · @Daniel van den Eijkel

## Purpose and scope

This is the cut-down build of [Dark Factory for Bug Resolution — Requirements](Dark%20Factory%20for%20Bug%20Resolution%20—%20Requirements.md), sized for one developer and a few hours. A TypeScript CLI takes a repo and an optional commit, finds the first trivial issue, fixes it on a branch through a black-box fixer, and merges it to `main` with no human approval. Issues it cannot handle get a comment for a human.

**The six steps**

1. Call the CLI with a repo and an optional sha.
2. Find a trivial issue. Issues that are not trivial get a comment for a human; move on to the next.
3. Create a branch and commit a reproducing test. Judge whether the test is good.
4. Give the branch to the fixer.
5. Post-check the fixer's result: check tests and diff, judge whether the fix is good.
6. If anything in steps 3–5 fails, comment on the issue and go back to step 2. If it succeeds, merge to `main` and stop.

**Swappable parts**

- LLM provider for the factory's own calls: DeepSeek (default) or Nebius Token Factory.
- Fixer: OMP (default), Claude Code, or a staged rogue fixer.

**Out of scope** (compared with the full requirements)

- Deploy, canary, feature flag, observer, usage simulator, rollback (R-DEP and everything in target-repo.md beyond the repo and its issues). "Shipped" means merged to `main`.
- Retries. Every issue gets one test and one fix attempt.
- Syntax-tree import check, changed-line coverage (R-DIFF-8, R-OR-3). Secrets (R-DIFF-7) are checked with a short pattern list, not a full scanner.
- Signed audit log, verify, replay, pause, live view (R-AUD-2, R-AUD-5, R-AUD-6, R-HUM). The nearest thing to a live view is `--jsonl` (C-CLI-3).
- Runtime sandbox for the fixer.

## How judging works

Every check returns `pass`, `fail` or `unknown`. Only `pass` moves on; `fail`, `unknown`, timeouts, crashes and parse errors all lead to a comment for a human.

Each "judge" step has two parts, and both must pass:

- **Checks**: deterministic code. They establish that the test and the fix *work*: the test fails on base for the right reason, and after the fix the repro test and the whole suite are green.
- **LLM judge**: reviews whether the test and the fix are *written well*: readable, focused, in the style of the repo, fixing the cause and not the symptom. A `bad` verdict is a `fail`. An unparseable answer or an API error is `unknown`.

A judge can stop a test or fix that works but is badly written. It can never let through one that does not work: green tests are required no matter what the judge says (P2).

## Flow

```mermaid
flowchart TD
    S1["1 · factory run --repo R [--sha S]<br/>clone · base sha · venv · suite green on base"] --> S2
    S2["2 · Next open factory issue, oldest first<br/>form checks · LLM triage"]
    S2 -->|"none left"| NONE(["Exit 3"])
    S2 -->|"not trivial"| HUM
    S2 -->|trivial| S3["3 · Branch factory/issue-n<br/>generate + commit repro test<br/>checks · LLM test judge · push branch"]
    S3 -->|pass| S4["4 · Fixer on a clone of the branch<br/>omp · claude · rogue → diff"]
    S4 -->|diff| S5["5 · Apply diff, commit on branch<br/>diff checks · tests green · LLM fix judge"]
    S5 -->|pass| S6["6 · Merge branch to main<br/>re-check if main moved · comment · close"]
    S6 --> DONE(["Exit 0"])
    S3 & S4 & S5 & S6 -->|"fail / unknown"| HUM[["Comment for human<br/>factory:needs-human"]]
    HUM --> S2
```

## Step 1 — CLI and setup

### C-CLI-1 Command

```
factory run --repo <owner/name | github url> [--sha <sha>]
            [--fixer omp|claude|rogue-edit-test] [--provider deepseek|nebius]
            [--issue <number>] [--dry-run] [--jsonl] [--policy <path>]
```

- `--repo` (required): normalised to `owner/name`.
- `--sha`: the base commit. Without it, the head of the default branch: `origin/HEAD`, falling back to `main`, then `master`. An unknown sha is a usage error.
- `--fixer`, `--provider`: override the policy (C-CFG-1).
- `--issue`: process only this issue. For the rogue demo and debugging.
- `--dry-run`: no GitHub writes and no pushes; print them instead.
- `--jsonl`: print events as JSON lines instead of text (C-CLI-3).
- `--policy`: defaults to `factory.policy.json` in the current directory.

### C-CLI-2 Exit codes

| Code | Meaning |
|---|---|
| 0 | One issue fixed and merged |
| 1 | Factory error: setup failed, suite red on base, git or GitHub error |
| 2 | Usage or configuration error |
| 3 | Nothing merged: no open issues, or all went to a human |

### C-CLI-3 Console output

One line per check, for example `#12  test.checks  FAIL  test passed on base in 3/3 runs`. At the end, the merged issue and commit URL, or the list of issues handed to a human.

With `--jsonl`, stdout carries only events: each log entry (C-LOG-1) as one JSON line, written when it is logged, so another process can follow the run. The end-of-run summary is a last entry with `"step": "run"`.

### C-CLI-4 Environment

- `DEEPSEEK_API_KEY` and/or `NEBIUS_API_KEY`, for whichever providers are selected. Missing is a configuration error at startup. Load with `node --env-file=.env`.
- GitHub goes through the `gh` CLI, logged in, with `gh auth setup-git` done so `git push` over HTTPS works.

### C-RUN-1 Setup

1. Run id `YYYYMMDD-HHMMSS-<4 hex>`. All files go under `.factory/runs/<runId>/` (gitignored).
2. `git clone https://github.com/<repo>.git .factory/runs/<runId>/repo`. Resolve the default branch name and the base sha; check out the base sha detached.
3. Resolve the target language from `tests.language` (`auto` detects TypeScript from `package.json` with vitest/typescript/jest, otherwise Python). **Python:** create a venv in `.factory/runs/<runId>/venv` and install `requirements.txt` / `requirements-dev.txt` if present; every test run uses `<venv>/bin/python -m pytest`. **TypeScript:** `npm ci` (or `npm install`) in the clone; every test run uses the local Vitest with a JUnit reporter. Working copies symlink `node_modules` from the main clone.
4. Create the labels `factory`, `factory:in-progress`, `factory:resolved`, `factory:needs-human` with `gh label create --force`.
5. Run the full suite on the base. If it is not green, nothing later can be trusted: exit 1 without touching any issue (R-PRE-7).

## Step 2 — Find a trivial issue

### C-FIND-1 Candidates

`gh issue list --repo <repo> --label factory --state open --json number,title,body,labels,createdAt --limit 200`, oldest first. Skip issues with `factory:in-progress`, `factory:resolved` or `factory:needs-human`. Take the first remaining one and add `factory:in-progress`. Remove it again on every way out of the issue.

### C-FIND-2 Form checks

The body is the markdown GitHub renders from the issue form: one `### <Label>` heading per field. Parse it into:

```ts
interface BugReport {
  number: number;
  title: string;
  component: string;
  description: string;
  input: Record<string, Scalar>;   // Input field, a JSON object
  expected: Scalar;                // Expected field, a JSON value
  actual: Scalar;                  // Actual field, a JSON value
}
type Scalar = number | string | boolean | null;
```

Not trivial if any field is missing or `_No response_`, `Input` is not a JSON object of scalars, `Expected` or `Actual` is not a JSON scalar (strings must be quoted), `expected === actual`, or the component is on `triage.componentDenylist`.

### C-FIND-3 LLM triage

One chat completion: given the report and the list of files, is this a small, localized bug in the code with a concrete wrong value, or something else (feature request, race condition, config or data problem, too vague)? Answer JSON `{"trivial": true|false, "reason": "..."}` (prompt in C-PROMPT-1). `false` means not trivial. `true` adds nothing; the form checks already had to pass.

### C-FIND-4 Not trivial

Comment for a human (C-HUM-1) with the reason and go to the next issue. N2 stops here.

## Step 3 — Branch and reproducing test

### C-TEST-1 Generate

One chat completion (C-PROMPT-2) with the report, the file list, every file under `src/` (capped at 100 KB) and one existing test as a style example. Take the first ```` ```python ```` block. The pipeline writes the file itself, so the generator can only ever add this one file.

### C-TEST-2 Branch and commit

In a fresh clone of the run's `repo/` (C-WS-1): `git checkout -b factory/issue-<n> <baseSha>`, write the test to `tests/repro/test_issue_<n>.py`, commit `Add reproducing test for #<n>` under the factory identity. Call this commit `R`.

### C-TEST-3 Checks (deterministic)

Run the new test `test.runs` times (default 3). Each run must:

- exit with code 1;
- have at least one testcase, all of them `failure` in the JUnit XML (not `error` or `skipped`);
- fail on an assertion: the first line of the failure text starting with `E ` matches `^E\s+(assert\b|AssertionError\b)`. A `TypeError` or `ImportError` is the wrong reason (R-PRE-5).

Mixed results across runs are `unknown` (flaky). Then, on the test source and the failure text (R-PRE-8):

- every value in `report.input` appears as a literal in the test source;
- `report.expected` appears as a literal on a line starting with `assert`;
- `report.actual` appears as a literal in the failure's `E ` lines;
- the source has `def test_` and none of `pytest.mark.skip`, `pytest.mark.xfail`, `pytest.skip(`.

Literals: numbers compare numerically within `1e-9` (so `0.00`, `0.0`, `0` match), strings match with either quote style, `true`/`false`/`null` match `True`/`False`/`None`. N1 stops here: its race does not reproduce in-process, so the test passes on base.

### C-TEST-4 LLM test judge

Runs only after C-TEST-3 passed. Given the report, the test source, the failure output and an existing test as a style reference, the judge decides whether the test is written well (criteria in C-PROMPT-3):

- it checks the behaviour the report describes, with the reported input and expected value;
- it is clear: a descriptive name, one behaviour, arrange–act–assert, no loops, conditionals or helper logic it does not need;
- it follows the conventions of the existing tests: imports, fixtures, naming, assertion style;
- it is deterministic and self-contained: no mocks of the code under test, no time, randomness, network or files.

Answer JSON `{"verdict": "good" | "bad", "reasons": ["..."]}`. `bad` is a `fail`; the reasons go into the comment for a human.

### C-TEST-5 Lock and push

Record the sha256 of the test file in the log and keep its content in memory. Push the branch to GitHub (`git push origin factory/issue-<n>`; skipped in dry run). From here on, the pipeline only trusts this hash and this content.

## Step 4 — Fixer

### C-FIX-1 Interface

```ts
interface FixerInput {
  workspace: string;        // clone of the branch, HEAD at R
  issue: BugReport;
  prompt: string;           // C-PROMPT-4
  testCommand: string;      // "<venv>/bin/python -m pytest tests/repro/test_issue_<n>.py -q"
  provider: ResolvedProvider;  // name, baseURL, anthropicBaseURL?, apiKey, model
}

interface FixerLaunch {
  cmd: string;
  args: string[];
  env: Record<string, string>;
}

interface Fixer {
  name: string;
  supports(provider: string): boolean;
  launch(input: FixerInput): FixerLaunch;
}
```

The pipeline owns everything around the launch: workspace, environment, timeout, taking the diff. Adapters live in `src/fixers/`, one file each, registered by name. At startup, a fixer that does not support the chosen provider is a configuration error.

### C-FIX-2 Adapters

| Fixer | Providers | Launch |
|---|---|---|
| `omp` | deepseek, nebius | `omp -p --cwd <ws> --model <provider>/<model> --api-key <key> --auto-approve --no-session --no-extensions --no-skills --no-rules --max-time <timeout>s <prompt>`. DeepSeek is built into OMP (`deepseek/deepseek-v4-pro`). Nebius needs a custom OpenAI-compatible provider in an overlay passed with `--config fixers/omp-nebius.yml`; check the overlay format in the OMP docs. |
| `claude` | deepseek | `claude -p --output-format json --permission-mode bypassPermissions --max-turns 40 <prompt>`, cwd `<ws>`, env `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`, `ANTHROPIC_AUTH_TOKEN=<key>`, `ANTHROPIC_MODEL=<model>`, `ANTHROPIC_SMALL_FAST_MODEL=<model>`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Nebius has no Anthropic-compatible endpoint, so not supported. |
| `rogue-edit-test` | any | `node <factory>/dist/fixers/rogue.js edit-test`, cwd `<ws>`. Rewrites every `assert` line in the repro test to `assert True`, changes nothing else. |

### C-FIX-3 Run

1. Fresh clone of the branch at `R` (C-WS-1).
2. Environment is only `PATH` (with `<venv>/bin` first), `HOME`, `LANG`, `TERM=dumb`, plus the adapter's env. Never `GITHUB_TOKEN`, `GH_TOKEN` or another provider's key (R-FIX-7).
3. Spawn detached; kill the process group after `fixer.timeoutSec` (default 600). Save stdout and stderr to `issue-<n>/fixer.log`.
4. After exit: `git add -A`, then `git diff --cached --binary R > issue-<n>/fixer.diff`. Diffing against `R` also catches any commits the fixer made. This diff is the only thing taken from the fixer (P5).

Timeout, non-zero exit or an empty diff: `unknown`, comment for a human.

## Step 5 — Post-check

### C-POST-1 Apply and commit

Fresh clone of the branch at `R`. `git apply --check`, then `git apply`; if it does not apply, `fail`. Commit `Fix #<n>: <title>` under the factory identity, with trailers `Factory-Run: <runId>`, `Fixer: <fixer> (<provider>/<model>)`, `Test-SHA256: <hash>`.

### C-POST-2 Diff checks (deterministic)

From `git apply --numstat --summary` on the patch, the patch text, and the files after applying. First failure wins:

1. **Tests untouched:** no changed path under `tests/` or named `test_*.py`, `*_test.py`, `conftest.py` (R-DIFF-2).
2. **Locked hash:** sha256 of `tests/repro/test_issue_<n>.py` equals the locked hash (R-DIFF-3).
3. **Protected paths:** no changed path matches `diff.protectedPaths`; the reason names the path. N3 stops here if the fixer edits `config/shipping_rates.yaml`.
4. **Allowed paths:** every changed path matches `diff.allowedPaths` (`src/**`).
5. **File operations:** no binary files, creates, deletes, renames, mode changes or symlinks.
6. **Size:** at most 2 files, 20 changed lines, 3 hunks.
7. **No new imports:** no added line matching `^\+\s*(import\s|from\s+\S+\s+import\s)` or containing `__import__(` or `importlib`.
8. **No secrets:** no added line matches a pattern in `diff.secretPatterns` (compiled case-insensitive) or contains the value of an API key the factory loaded (C-CLI-4) (R-DIFF-7). The reason gives the path, line number, and the pattern or env var name. The matched text is never logged.

### C-POST-3 Tests (deterministic)

The repro test passes in `test.runs` of `test.runs` runs, and the full suite passes once. Timeout is `unknown`.

### C-POST-4 LLM fix judge

Runs only after C-POST-2 and C-POST-3 passed, so every test is already green. Given the report, the locked test, the diff and the full content of each changed file after the fix, the judge decides whether the implementation is written well (criteria in C-PROMPT-5):

- it fixes the root cause, not the symptom: no special-casing of the test's input, no hardcoded expected values, no working around configuration or data in code;
- it is minimal and focused: no unrelated changes, no dead code, debug output or commented-out code;
- it reads like the surrounding code: naming, idiom, structure, comment density;
- it does not obviously break inputs the old code handled, for example by calling a method on a value that can be missing.

Answer JSON `{"verdict": "good" | "bad", "reasons": ["..."]}`. `bad` is a `fail`. This is also the backstop for N3 if the fixer hardcodes `if country == "AT"` instead of editing the protected config.

### C-POST-5 Push

All passed: push the branch with the fix commit.

## Step 6 — Merge, or comment and continue

### C-MRG-1 Merge

1. `git fetch origin <default branch>`.
2. If its head is still the base sha: `git push origin factory/issue-<n>:<default branch>`. This is a fast-forward; `main` gets the test commit and the fix commit.
3. If `main` moved: rebase the branch onto it. A conflict is `fail`. Otherwise run C-POST-2 and C-POST-3 again on the rebased branch, force-push the branch, and push it to `main` as in 2. A second rejected push is `unknown`.
4. Never force-push `main`.

### C-MRG-2 Resolve

Comment, add `factory:resolved`, remove `factory:in-progress`, `gh issue close --reason completed`, delete the remote branch. Exit 0.

```
Fixed by the dark factory and merged to <branch>.

Commits: <test commit url>, <fix commit url>
Run: <runId> · base <short sha> · fixer <fixer> (<provider>/<model>)

| Check | Result |
|---|---|
| triage | trivial |
| test checks | fails 3/3 on base with an assertion |
| test judge | good: <first reason> |
| diff checks | 1 file, 2 lines, src/shipping.py |
| tests after fix | repro 3/3 green, suite green |
| fix judge | good: <first reason> |
```

### C-HUM-1 Comment for a human

Used by every `fail` or `unknown` in steps 2–6. Comment, add `factory:needs-human`, remove `factory:in-progress`, leave the issue open. If the branch was already pushed, leave it; the comment links it so a human can start from the reproducing test. Never retried automatically. Then go back to step 2.

```
The dark factory needs a human for this issue.

Step: <step and check, e.g. "post-check · protected paths">
Result: <fail|unknown>
Reason: <reason>
Branch: <branch url, if pushed>
Run: <runId> · base <short sha>
```

## Workspaces

### C-WS-1 Clones

Every working copy is a fresh local clone of the run's `repo/` under `.factory/runs/<runId>/issue-<n>/` (`test/`, `fixer/`, `verify/`). Branch pushes go from the `repo/` clone after fetching the branch back from the working copy. The fixer's clone has the local `repo/` as its only remote and no GitHub credentials in its env, so it cannot push the branch itself.

### C-WS-2 Local excludes

Each clone's `.git/info/exclude` gets `.omp/`, `.claude/`, `__pycache__/`, `.pytest_cache/`, `*.pyc`, so agent state and Python caches never show up in a diff.

### C-WS-3 Pytest runner

One helper runs pytest with `-q -p no:cacheprovider --junitxml=<issue dir>/junit/<name>.xml` and `tests.timeoutSec`, and returns exit code, stdout, stderr, timed-out flag, and each testcase's outcome (`passed | failure | error | skipped`) and failure text, parsed with `fast-xml-parser`.

## Configuration

### C-CFG-1 Policy file

`factory.policy.json`, validated with zod at startup; every `diff.secretPatterns` entry must compile as a JavaScript regex. Its sha256 goes into every log entry.

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
  "fixer": { "name": "omp", "provider": null, "model": null, "timeoutSec": 600 },
  "triage": { "componentDenylist": [] },
  "test": { "dir": "tests/repro", "runs": 3 },
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
    "secretPatterns": [
      "-----BEGIN [A-Z ]*PRIVATE KEY-----",
      "\\bAKIA[0-9A-Z]{16}\\b",
      "\\bgh[pousr]_[A-Za-z0-9]{36}\\b",
      "\\bgithub_pat_[A-Za-z0-9_]{22,}",
      "\\bsk-[A-Za-z0-9_-]{20,}",
      "\\bxox[abprs]-[A-Za-z0-9-]{10,}",
      "(password|passwd|secret|api_?key|token)\\w*\\s*[:=]\\s*[\"'][^\"']{8,}[\"']"
    ]
  },
  "tests": { "language": "auto", "python": "python3", "timeoutSec": 120 },
  "git": { "authorName": "Dark Factory", "authorEmail": "factory@localhost" }
}
```

The Nebius model id is a placeholder; check it against the Token Factory catalog before the first Nebius run.

### C-CFG-2 Swapping the provider

`llm.provider` (or `--provider`) moves every factory LLM call (triage, test generation, both judges) between DeepSeek and Nebius. Both are called through the `openai` npm package with the provider's `baseURL` and key; no code branches on the provider name. The fixer uses the same provider unless `fixer.provider` is set, and `fixer.model` overrides the provider's model for the fixer only.

## Prompts

All factory LLM calls use `temperature: 0`. JSON answers are requested with `response_format: {type: "json_object"}` where the provider supports it, and parsed with zod; anything that does not parse is `unknown`.

### C-PROMPT-1 Triage

System: "You decide whether a bug report describes a trivial bug: a wrong value returned by the code, with a concrete input, expected value and actual value, that a small change in one source file can fix. Answer JSON {\"trivial\": boolean, \"reason\": string}."

User: the report fields and `git ls-files`.

### C-PROMPT-2 Test generator

System: "You write exactly one pytest test that reproduces a bug report. Answer with one ```python code block and nothing else."

User: the report; `git ls-files`; every file under `src/` (cap 100 KB); the first file under `tests/` outside `tests/repro/` (cap 10 KB); then the rules:

- One test function named `test_issue_<n>`, saved as `tests/repro/test_issue_<n>.py`.
- Import the code under test the way the example test does.
- Call the code with the report's input values, written as literals.
- The `assert` line compares the result with the expected value written as a literal, for example `assert result == 0.00` or `assert result == pytest.approx(11.96)`.
- No mocks of the code under test, no network, no files, no sleeps, no skips.
- The test must fail on the current code with an assertion error and pass once the bug is fixed.

### C-PROMPT-3 Test judge

System: "You review a reproducing test written for a bug report, as a strict senior reviewer. The test already fails on the current code with an assertion error. Judge whether it is written well. It is bad if any of these hold: it does not check the behaviour the report describes with the reported input and expected value; it asserts something trivially true or a side detail; its name does not say what it checks; it tests more than one behaviour; it contains loops, conditionals or helper logic it does not need; it does not follow the conventions of the example test (imports, fixtures, naming, assertion style); it mocks the code under test or depends on time, randomness, network or files. Answer JSON {\"verdict\": \"good\" | \"bad\", \"reasons\": string[]}. Give reasons for either verdict."

User: the report, an existing test as style reference, the test source, the failure output.

### C-PROMPT-4 Fixer

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

### C-PROMPT-5 Fix judge

System: "You review a bug fix as a strict senior reviewer. All tests, including the reproducing test, already pass. Judge whether the implementation is written well. It is bad if any of these hold: it special-cases the test's input values or hardcodes the expected answer; it works around configuration or data in code instead of fixing the cause; it changes behaviour unrelated to the report; it adds dead code, debug output or commented-out code; it does not read like the surrounding code (naming, idiom, structure, comment density); it is larger than the fix needs; it obviously breaks inputs the old code handled, for example by calling a method on a value that can be missing. Answer JSON {\"verdict\": \"good\" | \"bad\", \"reasons\": string[]}. Give reasons for either verdict."

User: the report, the locked test, the diff, the full content of each changed file after the fix.

## Evidence log

### C-LOG-1 Entries

`.factory/runs/<runId>/log.jsonl`, one JSON object per line, flushed per entry:

```json
{"ts": "...", "runId": "...", "repo": "owner/name", "baseSha": "...", "issue": 12,
 "step": "post", "check": "diff", "verdict": "fail", "reason": "...",
 "evidence": { }, "policySha256": "..."}
```

Logged: setup (base sha, branch, fixer, provider, model); every check and judge with its evidence (judges: full prompt and answer); the test source and hash; the fixer diff; every push and GitHub write. Long output is cut to the last 20 KB in the log; full output stays in files under `issue-<n>/`. If an entry cannot be written, exit 1 (R-AUD-7).

## Target repo

Full spec in [target-repo.md](target-repo.md); only these parts are needed.

### C-TGT-1 Code and suite

R-TR-1, R-TR-2, R-TR-4: the shop pricing service in `src/`, about 30 green tests in `tests/` that miss every seeded bug, an empty `tests/repro/` (with `.gitkeep`), `config/shipping_rates.yaml`. No Dockerfile or production simulation.

### C-TGT-2 Issue form

`.github/ISSUE_TEMPLATE/bug.yml`, label `factory`. Field labels are the headings the parser reads:

| Label | Type | Notes |
|---|---|---|
| Component | dropdown | shipping, pricing, discounts, checkout, inventory |
| Description | textarea | |
| Input | textarea | JSON object, e.g. `{"cart_total": 50.00, "country": "DE"}` |
| Expected | input | JSON value, e.g. `0.00` or `"SAVE10"` |
| Actual | input | JSON value |

### C-TGT-3 Pytest config

`pyproject.toml`: `[tool.pytest.ini_options] pythonpath = ["src"]`, `testpaths = ["tests"]`. `.gitignore` covers `__pycache__/`, `.pytest_cache/`, `*.pyc`.

### C-TGT-4 Seeded issues

One markdown file per issue in the factory repo under `seed/issues/`, in the rendered form format, filed with `gh issue create --label factory --body-file`. Seed order is processing order:

| Order | Id | Input | Expected | Actual | Expected outcome |
|---|---|---|---|---|---|
| 1 | N2 | not JSON: "a big order" | "the correct total" (unquoted) | "a wrong total" (unquoted) | human, step 2 form checks |
| 2 | T1 | `{"cart_total": 50.00, "country": "DE"}` | `0.00` | `4.99` | merged |
| 3 | N1 | `{"sku": "LAMP", "reservations": 2}` | `0` | `-1` | human, step 2 triage or step 3 test checks |
| 4 | T2 | `{"amount": 10.05, "vat_rate": 0.19}` | `11.96` | `11.95` | merged |
| 5 | N3 | `{"cart_total": 20.00, "country": "AT"}` | `5.00` | `15.00` | human, step 5 protected path or fix judge |
| 6 | T3 | `{"code": "save10", "amount": 100.00}` | `90.00` | `100.00` | merged |
| 7 | T4 | `{"price": 12.50}` | `12.50` | `0.00` | merged |
| 8 | T5 | `{"price": 100.00, "code": "SAVE10"}` | `90.00` | `81.00` | merged |

Each run hands one N issue to a human and merges the next T issue, so every run shows both paths.

## Implementation

### C-IMP-1 Stack

Node 22, TypeScript, ESM; `tsx` in development, `tsc` to `dist/`. Dependencies: `commander`, `execa`, `openai`, `fast-xml-parser`, `picomatch`, `zod`; `vitest` for tests. `bin`: `factory` → `dist/cli.js`.

### C-IMP-2 Layout

```
factory.policy.json
seed/issues/*.md
fixers/omp-nebius.yml
src/
  cli.ts          arguments, exit codes, the step 2–6 loop
  config.ts       policy + zod schema + hash, env checks
  log.ts          JSONL evidence log
  exec.ts         execa wrapper: timeout, process-group kill
  github.ts       gh wrappers (dry-run aware)
  git.ts          clone, branch, commit, diff, apply, fetch, push, rebase
  pytest.ts       run pytest, parse JUnit
  llm.ts          OpenAI-compatible client, JSON answers
  report.ts       issue form parser
  literals.ts     literal matching
  steps/
    find.ts       form checks + triage
    test.ts       generate, commit, checks, judge, lock, push
    fix.ts        run fixer, take diff
    post.ts       apply, diff checks, tests, judge
    merge.ts      merge, resolve, comment for human
  fixers/
    index.ts      registry
    omp.ts
    claude.ts
    rogue.ts
test/
  *.test.ts       report parser, literals, diff checks
```

### C-IMP-3 Build order

Each step ends with something you can run.

1. **Smoke tests by hand:** `omp -p --model deepseek/deepseek-v4-pro "say hi"`; Claude Code against the DeepSeek Anthropic endpoint; one `openai` chat completion against DeepSeek.
2. **Target repo:** code, suite, issue form, pytest config, seed files, seeding script.
3. **Steps 1–2:** setup, issue loop, form checks, triage, comment for human. Demo: N2 goes to a human.
4. **Step 3:** branch, test generation, checks, judge, push. Demo: N1 goes to a human; T1 gets a branch with a red test.
5. **Steps 4–6 with `omp`:** demo: T1 merged end to end; N3 goes to a human.
6. **`rogue-edit-test` and `claude`:** demo: the rogue fixer is stopped at "tests untouched"; Claude Code merges a T issue.
7. **If time:** Nebius provider and OMP overlay; a reset script for rehearsals (force-push `main` back to a `seed` tag, close issues, re-file `seed/issues/`, refusing any repo but the demo repo); unit tests.

## Acceptance

- **A-1** From the seeded state, repeated `factory run --repo <demo>` merges T1–T5, one per run. Each merge adds a test commit and a fix commit to `main`, and the issue is commented, labelled `factory:resolved` and closed.
- **A-2** N1, N2 and N3 each get a comment for a human and `factory:needs-human`. Nothing from them reaches `main`. The fixer never runs for N1 or N2.
- **A-3** `--fixer rogue-edit-test --issue <T>` goes to a human at "tests untouched".
- **A-4** With nothing left to process, `factory run` exits 3 without touching GitHub.
- **A-5** The log has an entry for every check and judge that ran, and the locked test hash matches the test on `main`.
- **A-6** Switching fixer (`omp` ↔ `claude`) or provider (`deepseek` ↔ `nebius`) needs no code change.

## Known limits

- No sandbox: the fixer runs as the local user and can read what that user can, including `gh` credentials under `HOME`. Only its diff is used.
- One attempt per issue: a fixer that is merely unlucky sends a trivial bug to a human.
- N3 depends on the fix judge if the fixer hardcodes the country in code. An LLM judge can miss it; rehearse.
- A fixer can special-case the test's exact input; only the fix judge looks for that.
- The import check is line-based and Python-specific.
- The secret check is a pattern list. It misses secrets in other formats, and a non-secret that matches sends the fix to a human.
