# Dark Factory

A command-line tool that fixes trivial bugs on GitHub without a human in the loop. Point it at a repo. It picks the oldest open issue labelled `factory`, writes a test that reproduces the bug, gives the branch to a coding agent (the *fixer*), checks the result, and merges the fix to `main`. If it can't handle an issue, it leaves a comment for a human and moves on to the next one.

Each run merges at most one issue.

```
$ factory run --repo acme/shop
      setup            acme/shop base aeae53c on main, fixer omp (deepseek/deepseek-v4-pro), llm deepseek/deepseek-v4-pro
      setup.suite      PASS    31 tests green on base
      find.candidates  8 of 8 open issues to process
#1    find.form        FAIL    Input is not JSON
#2    find.triage      PASS    trivial: off-by-one comparison
#2    test.checks      PASS    fails 3/3 on base with an assertion
#2    test.judge       PASS    good: focused and clear
#2    fix.run          PASS    diff of 13 lines after 41s
#2    post.diff        PASS    1 file, 2 lines, src/shipping.py
#2    post.tests       PASS    repro 3/3 green, suite green
#2    post.judge       PASS    good: fixes the comparison at its source
#2    merge.push       PASS    merged to main at 7f25384
      run              merged #2

Merged #2: https://github.com/acme/shop/commit/7f25384…
Handed to a human:
  #1  find · form checks  fail  Input is not JSON
```

(The output is shortened: the real run also prints a line for each GitHub write.)

## How it works

For each candidate issue, oldest first:

1. **Find.** The form checks parse the issue body. They need a component, a description, an input (a JSON object), and an expected and an actual value (JSON scalars that differ). An LLM then judges whether the bug is small and local.
2. **Reproducing test.** An LLM writes one reproducing test for the target language (pytest for Python, Vitest for TypeScript), committed on `factory/issue-<n>`. The test must fail on the base commit 3 out of 3 times, on an assertion, and contain the reported input, expected and actual values. An LLM judge then reviews how it is written. The file's hash is locked and the branch is pushed.
3. **Fixer.** The fixer runs on a fresh clone of the branch. It gets a minimal environment: no GitHub token and no other provider's key. Only its `git diff` is taken.
4. **Post-check.** The diff is applied and committed, then checked. It must not touch tests, and the test hash must be unchanged. It must stay out of protected paths and inside `src/**`. It may not create, delete or rename files, or change binary files or modes. It has a size limit, and it may not add imports or secrets. Then the repro test must pass 3 out of 3 times and the full suite once. An LLM judge reviews the fix.
5. **Merge.** `main` is fast-forwarded to the branch, never force-pushed. If `main` moved during the run, the branch is rebased and all checks run again. The issue is then commented, labelled `factory:resolved` and closed.

Every check returns `pass`, `fail` or `unknown`. Only `pass` moves on. Anything else posts a comment on the issue explaining the failure, adds `factory:needs-human`, and leaves the branch (if pushed) for a human to start from. The LLM judges can only stop work. Green tests are always required, whatever a judge says.

The full specification is in [.notes/cli-spec.md](.notes/cli-spec.md).

## Requirements

- Node 22.9 or later
- Python 3 with `venv` (the target repo's tests run in a fresh venv)
- [`gh`](https://cli.github.com/), logged in, with `gh auth setup-git` done so `git push` over HTTPS works
- The fixer you use on your `PATH`: [`omp`](https://github.com/can1357/oh-my-pi) (default) or `claude` (Claude Code)
- An API key for the LLM provider: DeepSeek (default) or Nebius Token Factory

## Setup

```sh
npm install
npm run build
cp .env.example .env        # then fill in DEEPSEEK_API_KEY and/or NEBIUS_API_KEY
npm link                    # optional: puts `factory` on your PATH
```

`factory` (that is, `dist/cli.js`) reads `.env` from the current directory if one exists. The policy file defaults to `factory.policy.json` in the current directory, so run it from the repo root or pass `--policy`.

## Usage

```
factory run --repo <owner/name | github url> [--sha <sha>]
            [--fixer omp|claude|rogue-edit-test] [--provider deepseek|nebius]
            [--issue <number>] [--dry-run] [--jsonl] [--policy <path>]
```

| Option | Meaning |
|---|---|
| `--repo` | Target repo, as `owner/name`, `https://github.com/owner/name` or `git@github.com:owner/name.git`. Required. |
| `--sha` | Base commit. Defaults to the head of the default branch. |
| `--fixer` | Overrides `fixer.name` from the policy. |
| `--provider` | Overrides `llm.provider` from the policy. The fixer uses it too, unless `fixer.provider` is set. |
| `--issue` | Process only this issue. |
| `--dry-run` | Make no GitHub writes and no pushes; print them instead. Tests, LLM calls and the fixer still run. |
| `--jsonl` | Print each log entry as one JSON line on stdout. Other messages go to stderr. |
| `--policy` | Policy file (default `factory.policy.json`). |

### Examples

Process the next issue with the defaults (OMP fixer, DeepSeek):

```sh
factory run --repo acme/shop
```

Try a run without changing anything on GitHub:

```sh
factory run --repo acme/shop --dry-run
```

Work on one issue, using Claude Code as the fixer:

```sh
factory run --repo acme/shop --issue 4 --fixer claude
```

Use Nebius for the factory's own LLM calls and for the fixer:

```sh
factory run --repo acme/shop --provider nebius
```

Show that the gates hold. The staged `rogue-edit-test` fixer rewrites the test's asserts to `assert True`, and the factory stops it at "tests untouched":

```sh
factory run --repo acme/shop --issue 2 --fixer rogue-edit-test
```

Start from an older commit (if `main` has moved on, the branch is rebased before merging):

```sh
factory run --repo acme/shop --sha 1b8b35c
```

Follow a run from another process:

```sh
factory run --repo acme/shop --jsonl | jq -r 'select(.verdict) | "\(.issue) \(.step).\(.check) \(.verdict) \(.reason)"'
```

Process every open issue, one run per merge:

```sh
while factory run --repo acme/shop; do :; done
```

The loop stops at the first run that does not merge. Exit code 3 means nothing was left to merge; 1 or 2 means an error.

Without a build, during development:

```sh
npm run dev -- run --repo acme/shop --dry-run
```

### Exit codes

| Code | Meaning |
|---|---|
| 0 | One issue fixed and merged |
| 1 | Factory error: setup failed, suite red on base, git or GitHub error |
| 2 | Usage or configuration error (bad option, invalid policy, missing API key, fixer does not support the provider) |
| 3 | Nothing merged: no open issues, or all went to a human |

## Writing issues the factory can take

The factory looks at every open issue (oldest first). Prefer the issue form's rendered format (one `### <Label>` heading per field). Free-form bug write-ups are accepted too: an LLM extracts component, description, input, expected and actual. If it cannot pin down concrete values, the issue goes to a human.

````markdown
### Component

shipping

### Description

An order of exactly 50.00 to Germany should ship free.

### Input

{"cart_total": 50.00, "country": "DE"}

### Expected

0.00

### Actual

4.99
````

- **Input** must be a JSON object whose values are numbers, strings, booleans or `null`.
- **Expected** and **Actual** must be JSON scalars. Strings need quotes: `"SAVE10"`, not `SAVE10`.
- An empty field (`_No response_`), or Expected equal to Actual, sends the issue to a human.

The factory skips issues that already carry `factory:in-progress`, `factory:resolved` or `factory:needs-human`. To retry an issue after a human has looked at it, remove `factory:needs-human`. The optional `factory` label is no longer required for intake.

The target repo needs a green suite on the base commit and application code under `src/`. Language is chosen by `tests.language` in the policy (`auto` by default):

| Language | How it is detected (`auto`) | Install | Runner | Repro test path |
|---|---|---|---|---|
| Python | no JS/TS package markers | venv + `requirements*.txt` (pytest installed if missing) | pytest | `tests/repro/test_issue_<n>.py` |
| TypeScript | `package.json` with vitest/typescript/jest | `npm ci` / `npm install` | Vitest (must be a dependency) | `tests/repro/issue_<n>.test.ts` |

Python targets need a pytest config that puts `src` on the path (`pythonpath = ["src"]`). TypeScript targets should already run with `vitest run` (colocated `*.test.ts` under `src/` is fine for existing tests).

## Configuration

`factory.policy.json` holds everything that can change without a code change. It is checked at startup, and its sha256 goes into every log entry.

| Key | What it controls |
|---|---|
| `llm.provider`, `llm.providers` | The provider for triage, test generation and both judges: base URL, API key env var and model for each provider. Set `jsonMode: false` on a provider whose model rejects `response_format`. |
| `fixer.name`, `fixer.provider`, `fixer.model`, `fixer.timeoutSec` | Which fixer runs. It uses the LLM provider unless `fixer.provider` is set, and the provider's model unless `fixer.model` is set. |
| `triage.componentDenylist` | Components that always go to a human. |
| `test.dir`, `test.runs` | Where repro tests go, and how often each test run is repeated. |
| `diff.*` | Allowed and protected paths, size limits and secret patterns for the diff checks. |
| `tests.language`, `tests.python`, `tests.timeoutSec` | Target language (`auto` \| `python` \| `typescript`), the Python used for venvs, and the suite timeout. |
| `git.authorName`, `git.authorEmail` | Identity for the factory's commits. |

Fixers and their providers:

| Fixer | Providers | Notes |
|---|---|---|
| `omp` | deepseek, nebius | Nebius uses the overlay `fixers/omp-nebius.yml`. Its format has not been checked against the OMP docs yet. |
| `claude` | deepseek | Uses DeepSeek's Anthropic-compatible endpoint. |
| `rogue-edit-test` | any | Staged fixer for demos. It cheats by editing the test. |

To add a fixer, add a file under `src/fixers/` that implements `Fixer` (from `src/fixers/index.ts`) and register it there.

## Run output

Each run writes to `.factory/runs/<runId>/` (gitignored):

```
log.jsonl              evidence log: every check, judge prompt and answer, push and GitHub write
repo/                  clone of the target repo; all pushes go from here
venv/                  Python environment (Python targets)
junit/                 base suite report
                       TypeScript targets install into repo/node_modules instead
issue-<n>/
  test/ fixer/ verify/ the working copies for each step
  fixer.log            the fixer's stdout and stderr
  fixer.diff           the fixer's diff, the only thing taken from it
  junit/               report for every test run
```

Long values in `log.jsonl` are cut to their last 20 KB; the full output stays in the files under `issue-<n>/`.

## Development

```sh
npm test            # unit tests (vitest)
npm run typecheck
npm run build
```

```
src/
  cli.ts            arguments, setup, the per-issue loop, exit codes
  config.ts         policy schema, providers, repo names
  context.ts        run context, step results
  log.ts            JSONL evidence log and console output
  exec.ts           subprocesses with timeout and process-group kill
  git.ts            clone, commit, rebase
  github.ts         gh and push wrappers (dry-run aware)
  suite.ts          JUnit parser shared by test runners
  runtime.ts        Python (pytest) and TypeScript (Vitest) target adapters
  llm.ts            OpenAI-compatible client, JSON answers, judges
  report.ts         issue form parser
  literals.ts       Python/JS literal matching
  steps/            find, test, fix, post, merge
  fixers/           omp, claude, rogue-edit-test
test/               unit tests
```

## Known limits

- **No sandbox.** The fixer runs as your user and can read what you can read, including `gh` credentials under `HOME`. Only its diff is used.
- **One attempt per issue.** A fixer that is merely unlucky sends a trivial bug to a human.
- **Judges can miss things.** A fixer can special-case the test's exact input; only the fix judge looks for that.
- **Simple checks.** The import check is line-based (Python and TypeScript). The secret check is a short list of patterns.
- **TypeScript means Vitest.** Jest is not a separate runner yet; a repo without vitest is rejected at setup.
