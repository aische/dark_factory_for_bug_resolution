/** Exit 1: setup failed, suite red on base, git or GitHub error, log not writable. */
export class FactoryError extends Error {
  readonly exitCode = 1;
}

/** Exit 2: bad arguments or configuration. */
export class UsageError extends Error {
  readonly exitCode = 2;
}
