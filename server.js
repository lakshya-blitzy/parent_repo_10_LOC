'use strict';

/**
 * Long-lived `/health` server entry point — Level 1 (apex) tier.
 *
 * A *second, parallel* entry point rather than a change to `index.js`. `listen()`
 * must not reach `index.js`: it would make that process long-lived and destroy its
 * invariant, which is that `node index.js` still exits `0` after writing exactly
 * five lines and fifteen bytes to standard output, md5
 * `b07373a80ad21069e41be538e6506d00`. `index.js` is therefore neither required nor
 * modified from here.
 *
 * Division of responsibility with `health.js`, which this file never duplicates:
 * `health.js` owns the payload, the serialization, the contract headers, the status
 * codes and the routing, and returns an **unbound** server from
 * `createHealthServer()`; `server.js` owns only the process — resolving the bind
 * target, binding the listener, emitting one start-up log line, reporting a
 * start-up failure, and shutting the listener down in an orderly fashion on a
 * signal.
 *
 * Bind-target resolution reapplies the tier's chain at bind time:
 *
 *     environment variable  ->  configuration file  ->  compiled-in literal
 *          HOST / PORT            config/health.json        0.0.0.0 / 3000
 *
 * The override names here are exactly `HOST` and `PORT`; Levels 2 and 3 deliberately
 * use the prefixed `HEALTH_HOST` / `HEALTH_PORT` names, and that asymmetry must not be
 * "harmonized". The middle link is parsed once, by `health.js`, and consumed through
 * its resolved `config` export, so `config/health.json` is read in exactly one place
 * and the two cannot drift. The literals are required rather than decorative: the
 * listener must still bind and serve a valid contract when the file is missing.
 *
 * A single listener is the whole requirement, so there is deliberately no clustering,
 * worker thread, child process, daemonization, PID file, restart loop, self-polling
 * timer, extra route, middleware, TLS termination, authentication, rate limiting or
 * logging framework. The only module required is the tier-local `./health.js`, so
 * nothing outside this tier is referenced and the levels stay runtime-independent.
 *
 * Nothing is logged per request — that would add work to a probe and bury the real
 * output of an automated run in noise. This file logs its bound address once at
 * start-up, one line on shutdown, and diagnostics on stderr when something goes wrong.
 *
 * @module server
 * @see health.js — the payload builder, request handler and server factory
 * @see docs/health-endpoint.md — the normative contract for all three tiers
 * @see .env.example — the two environment overrides documented for this tier
 */

const {
  createHealthServer,
  config,
  describeConfigurationDegradation,
  frozenValueConflicts,
} = require('./health.js');

// Compiled-in bind-target fallbacks — the last link of the resolution chain.
// `0.0.0.0` means every interface, so a published port stays reachable from
// outside the host that binds it. It is a *bind* address only and never a
// destination: a probe always addresses `127.0.0.1`, because a health probe
// asserts the state of *this* process. Port `3000` is this tier's reserved port
// in the composition — Levels 2 and 3 own `8000` and `8080` — so all three
// applications can run side by side on one host during validation.
const FALLBACK = Object.freeze({
  host: '0.0.0.0',
  port: 3000,
  path: '/health',
});

// The usable range for a configured port, identical to `health.js`'s and to the
// sibling tiers'. `0` is excluded on purpose: it asks the operating system to
// choose a port at random, so the listener would bind an address no probe,
// `HEALTHCHECK` instruction or workflow assertion could predict — running and
// unreachable at once. A bare decimal integer is the only port form accepted from
// a string source.
const MIN_PORT = 1;
const MAX_PORT = 65535;
const DECIMAL_INTEGER = /^[0-9]+$/;

// Both signals are required. `SIGTERM` is what a supervisor or orchestrator sends
// when stopping a process, so handling it is what makes a stop a graceful close
// rather than a hard kill. `SIGINT` is what an interactive Ctrl-C and an automated
// teardown send, and handling it is what guarantees the listener releases its port
// — which is what lets the same port be bound again immediately afterwards.
const SHUTDOWN_SIGNALS = Object.freeze(['SIGTERM', 'SIGINT']);

// How long an orderly shutdown may take before connections are closed forcibly. A
// client that is mid-request gets a moment to finish; a client holding a socket
// open indefinitely does not get to hold the port hostage.
const SHUTDOWN_GRACE_MS = 5000;

// A requested shutdown is a success. A listener that could not be bound exits
// non-zero, so an automated consumer fails loudly rather than waiting on a port
// that will never answer.
const EXIT_SUCCESS = 0;
const EXIT_STARTUP_FAILURE = 1;

/**
 * Shutdown latch. Set the first time a shutdown signal is handled so that a
 * second signal — a repeated Ctrl-C, or a `SIGINT` chased by a `SIGTERM` — cannot
 * start a second teardown, and so that the `error` handler can tell a genuine
 * start-up failure apart from teardown noise.
 */
let shuttingDown = false;

/**
 * Return a candidate as a trimmed, non-empty string, or `null` when it does not
 * qualify.
 *
 * An unset environment variable is `undefined` and an exported-but-empty one is
 * `''`; neither expresses an intent to override, so both are skipped in favour of
 * the next link in the chain rather than being accepted as a deliberate setting.
 */
function asNonEmptyString(candidate) {
  if (typeof candidate !== 'string') {
    return null;
  }
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Return a candidate as a valid TCP port number, or `null` when it does not
 * qualify.
 *
 * Both source shapes are accepted: a JSON number from the configuration file and
 * a decimal string from the environment, since every environment variable arrives
 * as a string. The value is coerced to a number and then validated as an integer
 * inside the valid port range, so `"abc"`, `"3000x"`, `"-1"`, `"70000"`, `3000.5`
 * and `NaN` are all rejected. Rejecting rather than throwing means a typo in one
 * source degrades to the next source instead of making the listener unbindable —
 * a mistyped `PORT` still yields a serving endpoint on the configured port.
 */
function asPort(candidate) {
  let numeric = null;
  if (typeof candidate === 'number') {
    numeric = candidate;
  } else if (typeof candidate === 'string' && DECIMAL_INTEGER.test(candidate.trim())) {
    numeric = Number.parseInt(candidate.trim(), 10);
  }
  if (numeric === null || !Number.isInteger(numeric) || numeric < MIN_PORT || numeric > MAX_PORT) {
    return null;
  }
  return numeric;
}

/**
 * Resolve the host and port the listener will bind, applying the uniform
 * precedence chain.
 *
 * For each value the chain is, highest precedence first:
 *
 *   1. the environment variable — `HOST` or `PORT`;
 *   2. the corresponding member of `health.js`'s resolved `config`, which already
 *      carries the value from `config/health.json`;
 *   3. the compiled-in literal in {@link FALLBACK}.
 *
 * Reading the middle link through `config` rather than re-parsing
 * `config/health.json` here is deliberate: the file is then read in exactly one
 * place in the tier, the payload and the listener can never disagree about the
 * serving parameters, and a missing or malformed file is already handled there by
 * falling back to a literal. The third link is still checked because `config` is
 * an imported value: if it were ever absent or reshaped, this file must still
 * produce a bindable target rather than a `TypeError` at start-up.
 */
function resolveBindTarget() {
  const serving = config !== null && typeof config === 'object' ? config : {};

  const host =
    asNonEmptyString(process.env.HOST) ?? asNonEmptyString(serving.host) ?? FALLBACK.host;
  const port = asPort(process.env.PORT) ?? asPort(serving.port) ?? FALLBACK.port;

  return { host, port };
}

/**
 * Read the health resource path, used only to make the start-up log line
 * directly actionable. Routing itself is entirely `health.js`'s concern and is
 * never re-derived here.
 *
 * `health.js` resolves this value from `config/health.json` and validates it
 * against the contract before adopting it, so it is guaranteed to be the frozen
 * contract path whatever the file says. Reading it here is therefore a read rather
 * than a second resolution. The guards exist only so that a hand-built `config`
 * double in a test cannot make the log line throw.
 *
 * @returns {string} The resource path, always beginning with `/`.
 */
function resolveHealthPath() {
  const serving = config !== null && typeof config === 'object' ? config : {};
  const resolved = asNonEmptyString(serving.path) ?? FALLBACK.path;
  return resolved.startsWith('/') ? resolved : `/${resolved}`;
}

/**
 * Placeholder substituted for a host that fails validation.
 *
 * Deliberately the same token the Level 2 and Level 3 siblings use, so a single
 * `grep '<unprintable>'` finds a rejected host in any of the three tiers' logs
 * without the reader having to remember three spellings.
 *
 * @type {string}
 */
const UNSAFE_HOST_TEXT = '<unprintable>';

/** Substituted for a port that is not a plain integer. @type {string} */
const UNSAFE_PORT_TEXT = '<unprintable>';

/** Longest host rendered verbatim. A DNS name maxes out at 253; 64 covers every real one. @type {number} */
const MAX_HOST_LENGTH = 64;

/**
 * Every character a legitimate host value can contain.
 *
 * Alphanumerics and `.` cover DNS names and IPv4 literals; `:` covers IPv6
 * literals; `-` and `_` cover host-name conventions; `%` covers an IPv6 zone
 * index such as `fe80::1%eth0`. Nothing else is permitted — in particular no
 * whitespace, no control character and no escape byte.
 *
 * @type {ReadonlySet<string>}
 */
const HOST_SAFE_CHARACTERS = new Set(
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.:-_%'.split(''),
);

/**
 * Validate a host before it is rendered into a diagnostic.
 *
 * The host reaching this function is configuration-derived: it comes from the
 * `HOST` environment variable or from `config/health.json`, so its content is
 * chosen by whoever can set an environment variable or edit a file — which in CI
 * is a broader set of people than those who can change this source. That makes
 * every diagnostic containing it a log-injection sink. A value carrying a newline
 * would not merely look untidy: it would emit a second line that a log collector
 * parses as a separate event, and that line can be made to read exactly like this
 * server's own successful start-up announcement. An operator or an automated
 * check could then be told the server is listening when it never bound at all.
 *
 * The defence is a strict allowlist rather than escaping, because an allowlist
 * fails closed: a character nobody anticipated is rejected by default instead of
 * being passed through by an escaping rule that did not know about it. A rejected
 * value is replaced wholesale rather than filtered, so the log never shows a
 * partially-scrubbed string that might be mistaken for the real configured value.
 *
 * @param {unknown} host The configuration-derived host.
 * @returns {string} The host unchanged, or {@link UNSAFE_HOST_TEXT}.
 */
function sanitizeHost(host) {
  if (typeof host !== 'string' || host.length === 0 || host.length > MAX_HOST_LENGTH) {
    return UNSAFE_HOST_TEXT;
  }
  for (const character of host) {
    if (!HOST_SAFE_CHARACTERS.has(character)) {
      return UNSAFE_HOST_TEXT;
    }
  }
  return host;
}

/**
 * Longest error category rendered, so one diagnostic stays one readable line.
 *
 * @type {number}
 */
const MAX_CATEGORY_LENGTH = 64;

/**
 * Characters permitted in a rendered error category.
 *
 * An `errno` code (`EADDRINUSE`) and an exception class name (`AggregateError`)
 * both consist entirely of these. Anything else is stripped, because `error.name`
 * is a writable property and a class name is caller-chosen in the general case: a
 * value containing a newline could otherwise forge an additional log line, which
 * is the same injection risk {@link sanitizeHost} exists to close.
 *
 * @type {RegExp}
 */
const CATEGORY_SAFE_CHARACTER = /^[A-Za-z0-9_.]$/;

/**
 * Reduce an error to a stable, non-sensitive category token.
 *
 * Precedence is `code`, then `name`, then the constructor name, then the literal
 * `Error`. The `errno` code is preferred because it is the one identifier that is
 * stable across Node versions, platforms and locales, and it is what a maintainer
 * searches the source for. Nothing derived from `error.message` is ever consulted.
 *
 * @param {unknown} error The caught or emitted value; anything may be thrown.
 * @returns {string} A token of `[A-Za-z0-9_.]`, never empty.
 */
function errorCategory(error) {
  let raw = '';
  if (error !== null && typeof error === 'object') {
    if (typeof error.code === 'string' && error.code.length > 0) {
      raw = error.code;
    } else if (typeof error.name === 'string' && error.name.length > 0) {
      raw = error.name;
    } else if (error.constructor && typeof error.constructor.name === 'string') {
      raw = error.constructor.name;
    }
  } else {
    // `throw 'boom'` and `server.emit('error', 42)` are both legal. The *type* is
    // recorded and the value never is, because a thrown primitive is exactly the
    // kind of value that carries interpolated detail.
    raw = `Thrown_${typeof error}`;
  }

  let safe = '';
  for (const character of raw) {
    if (CATEGORY_SAFE_CHARACTER.test(character)) {
      safe += character;
      if (safe.length === MAX_CATEGORY_LENGTH) {
        break;
      }
    }
  }
  return safe.length > 0 ? safe : 'Error';
}

/**
 * Format an address and port as a URL authority, bracketing an IPv6 literal so
 * the result is a syntactically valid URL an operator can paste into a client.
 *
 * The **single choke point** for rendering a host into operator-facing text: the
 * start-up line and every branch of {@link describeStartupFailure} reach a host
 * only through here, so sanitizing once at this one place is what makes it
 * structurally impossible for a future diagnostic to bypass the check by
 * interpolating `target.host` directly.
 *
 * Bracketing is decided *after* sanitization and tests only for a `:`; the
 * allowlist excludes `[` and `]`, matching the Levels 2 and 3 allowlists, because
 * an already-bracketed `HOST` such as `[::1]` is not a bindable value in any of
 * the three runtimes.
 *
 * @param {unknown} address Host name or IP literal, sanitized before rendering.
 * @param {unknown} port TCP port, rendered only when it is a plain integer.
 * @returns {string} The authority, for example `0.0.0.0:3000` or `[::1]:3000`.
 */
function formatAuthority(address, port) {
  const safeAddress = sanitizeHost(address);
  const safePort = Number.isInteger(port) ? String(port) : UNSAFE_PORT_TEXT;
  return `${safeAddress.includes(':') ? `[${safeAddress}]` : safeAddress}:${safePort}`;
}

/**
 * Builds the absolute URL of the health resource as actually bound.
 *
 * `server.address()` is preferred over the requested target because it reports
 * what the operating system really assigned: with `PORT=0` the requested port is
 * `0` while the bound port is an ephemeral one, and only the bound value is of any
 * use to a reader of the log. The requested target is the fallback for the case
 * where the address is not yet available.
 */
function describeBoundUrl(server, target) {
  const bound = typeof server.address === 'function' ? server.address() : null;
  const isSocketInfo = bound !== null && typeof bound === 'object';

  const address =
    isSocketInfo && asNonEmptyString(bound.address) !== null ? bound.address : target.host;
  const port = isSocketInfo && Number.isInteger(bound.port) ? bound.port : target.port;

  return `http://${formatAuthority(address, port)}${resolveHealthPath()}`;
}

/**
 * Turns a failure to bind into a message that names the defect and the remedy.
 *
 * A silent hang on a taken port is the worst way for this to fail: a readiness
 * poll times out, the probe fails, and nothing in the log says why. Each
 * recognised error code therefore gets its own sentence stating what went wrong
 * and what to do about it, and an unrecognised code still reports a stable
 * category rather than an opaque stack trace.
 *
 * Two disclosure rules apply to every branch:
 *
 *   - The host is rendered only through {@link formatAuthority}, never
 *     interpolated directly, so it is always sanitized first.
 *   - `error.message` is never rendered. Node interpolates the operation and the
 *     address into it — and a path or a resolver detail for a non-`listen`
 *     failure — so forwarding it would both re-introduce the unsanitized host by
 *     a side door and make the text vary with the platform's locale. A stable
 *     {@link errorCategory} is reported instead, which is what a maintainer greps
 *     for; the prose was never the actionable part.
 *
 * @param {NodeJS.ErrnoException} error The error emitted by the server.
 * @param {{host: string, port: number}} target The bind target that was attempted.
 * @returns {string} A single-line, operator-actionable diagnostic.
 */
function describeStartupFailure(error, target) {
  const authority = formatAuthority(target.host, target.port);
  const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';

  switch (code) {
    case 'EADDRINUSE':
      return (
        `health server cannot start: ${authority} is already in use. ` +
        'Stop the process holding that port, or choose another with ' +
        '`PORT=<port> node server.js`.'
      );
    case 'EACCES':
      return (
        `health server cannot start: permission denied binding ${authority}. ` +
        'Ports below 1024 require elevated privileges; choose a higher port with ' +
        '`PORT=<port> node server.js`.'
      );
    case 'EADDRNOTAVAIL':
      return (
        `health server cannot start: ${sanitizeHost(target.host)} is not an address of ` +
        'any local interface. Set HOST to an address this host owns, or to 0.0.0.0 ' +
        'for every interface.'
      );
    default:
      return (
        `health server cannot start: binding ${authority} failed ` +
        `(${errorCategory(error)}).`
      );
  }
}

/**
 * Close the listener in an orderly fashion and exit with code `0`.
 *
 * Orderly means three things, in this order:
 *
 *   1. `server.close()` stops the listener accepting new connections and releases
 *      the port, and its callback fires once every connection has finished.
 *   2. `closeIdleConnections()` closes sockets that are being held open only by
 *      HTTP keep-alive. Without it, a probe that left a keep-alive socket behind
 *      would keep `close()` pending for the whole keep-alive timeout, and the port
 *      would appear to linger — exactly the orphaned binding that stops the next
 *      run from binding it.
 *   3. A grace timer is the backstop for a connection that is genuinely mid-flight
 *      and never completes. It calls `closeAllConnections()` and exits anyway. The
 *      timer is `unref`'d, so it can never itself keep the process alive, and it
 *      never fires at all on the ordinary path, where step 1's callback has
 *      already exited.
 *
 * Exiting with `0` is correct because the shutdown was *requested*: a supervised
 * stop and an automated teardown are both normal, successful terminations, and
 * reporting a non-zero code for either would make every teardown look like a
 * failure.
 *
 * The function is idempotent — a second signal returns immediately — so a repeated
 * Ctrl-C cannot start a second teardown or produce a second log line.
 *
 * Both connection-closing methods are feature-detected before use. They are
 * present on every supported runtime, and the guards simply keep an entry point
 * that must never crash while shutting down from depending on that.
 */
function shutdown(server, signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  console.log(`health server received ${signal}, closing listener`);

  const forceExit = setTimeout(() => {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    process.exit(EXIT_SUCCESS);
  }, SHUTDOWN_GRACE_MS);
  forceExit.unref();

  server.close(() => {
    clearTimeout(forceExit);
    process.exit(EXIT_SUCCESS);
  });

  if (typeof server.closeIdleConnections === 'function') {
    server.closeIdleConnections();
  }
}

/**
 * Announce, exactly once, that a declared configuration source failed to supply
 * its values.
 *
 * `health.js` survives a missing, unreadable, malformed or empty source by falling
 * back to compiled-in literals, because an endpoint that refuses to answer over its
 * own configuration turns a running application into one that reports itself
 * unhealthy. But resilience without a report is indistinguishable from correctness: a
 * deployment assembled without `config/health.json` serves a perfectly valid `200`
 * carrying fallback identity, so a check that only looks at the response passes while
 * the payload no longer describes the build it came from.
 *
 * Reporting happens here rather than in `health.js` because requiring that module must
 * stay byte-silent on both streams — the suite loads it in a child process and asserts
 * nothing was written, and a module that logs at import time also logs when a tool
 * introspects it. The module records; the entry point reports.
 *
 * `stderr` is the correct stream: this is diagnostic output about a degraded
 * condition, and keeping `stdout` to exactly the one start-up line means a
 * consumer that parses `stdout` for the bound address is never confused by it.
 *
 * @returns {boolean} `true` when a line was written, for the unit suite's benefit.
 */
function reportConfigurationDegradation() {
  const described =
    typeof describeConfigurationDegradation === 'function'
      ? describeConfigurationDegradation()
      : null;
  if (typeof described !== 'string' || described.length === 0) {
    return false;
  }
  console.error(described);
  return true;
}

/**
 * Longest configured value rendered verbatim in a frozen-value diagnostic.
 *
 * Sixty-four characters, the same bound {@link sanitizeHost} and
 * {@link errorCategory} use, so that no single diagnostic can push the useful
 * part of a log line off the end of a terminal.
 *
 * @type {number}
 */
const MAX_CONFIGURED_LENGTH = 64;

/**
 * Render a rejected configured value safely inside a one-line diagnostic.
 *
 * Same trust boundary and same log-injection risk as {@link sanitizeHost}: the value
 * was read out of `config/health.json`. A `path` of
 * `"/x\nhealth server listening on http://0.0.0.0:3000/health"` would otherwise emit
 * a second line a collector parses as a separate event, reading precisely like this
 * server's own start-up announcement. A conflict record's `key` and `frozen` members
 * come from the frozen table compiled into `health.js`, so they are rendered as-is.
 *
 * Unlike a host, a rejected value cannot be replaced wholesale — naming what was
 * configured is the point, since an operator who cannot see their own value cannot
 * find the line to delete. So the length is bounded and every unprintable character
 * becomes a space, keeping one logical diagnostic on one physical line.
 *
 * @param {unknown} value The rejected value, as recorded by the audit; a
 *   configuration document may hold a non-string, so anything may arrive.
 * @returns {string} A single-line rendering, never longer than
 *   {@link MAX_CONFIGURED_LENGTH} plus an elision marker.
 */
function sanitizeConfiguredValue(value) {
  const text = typeof value === 'string' ? value : String(value);
  const bounded =
    text.length > MAX_CONFIGURED_LENGTH
      ? `${text.slice(0, MAX_CONFIGURED_LENGTH)}...`
      : text;

  let safe = '';
  for (const character of bounded) {
    const code = character.codePointAt(0);
    const printable = code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);
    safe += printable ? character : ' ';
  }
  return safe;
}

/**
 * Report, once at start-up, any configured value that was rejected for trying to
 * redefine a frozen contract value.
 *
 * `health.js` serves the frozen value whatever the document says, but serving the
 * right thing is not enough on its own: a deployment that edited `config/health.json`
 * expecting an effect would otherwise get silence and discover the truth only from a
 * monitoring gap. One warning line per rejected value names the key, what was
 * configured and what is served instead.
 *
 * On standard error, because it reports a misconfiguration rather than normal
 * progress, and emitted here rather than in `health.js` because that module must stay
 * importable without side effects. A correctly configured deployment prints nothing.
 * The configured value goes through {@link sanitizeConfiguredValue} first, being a
 * document-supplied string rendered into a log line.
 *
 * @returns {number} How many lines were written, for the unit suite's benefit.
 */
function reportFrozenValueConflicts() {
  for (const conflict of frozenValueConflicts) {
    console.error(
      `health server ignoring configured ${conflict.key} ` +
        `"${sanitizeConfiguredValue(conflict.configured)}": ` +
        `${conflict.key} is frozen at "${conflict.frozen}" by the /health contract ` +
        'and is not a deployment setting. Remove the value or restore it to ' +
        `"${conflict.frozen}" in config/health.json.`,
    );
  }
  return frozenValueConflicts.length;
}

/**
 * Create the server, bind it, and keep it serving until a signal arrives.
 *
 * Ordering here is deliberate. The `error` listener is attached *before*
 * `listen()` so that a synchronous bind failure cannot become an unhandled
 * `'error'` event, which would crash the process with a stack trace instead of the
 * actionable message {@link describeStartupFailure} produces. The signal handlers
 * are registered before `listen()` too, so a signal that arrives during start-up
 * is still handled rather than terminating the process abruptly.
 *
 * Both configuration reports come first, before the bind target is even resolved,
 * so that the *reason* a value looks wrong is on the stream ahead of the line that
 * reports the value. An operator reading a log top-to-bottom then meets "the
 * identity manifest was missing" before "listening as parent_repo_10_LOC 1.0.0",
 * rather than having to scroll back to explain what they just read. Degradation is
 * announced before rejected frozen values because it explains an absent source,
 * which is the broader condition — a deployment whose `config/health.json` never
 * arrived has no configured `path` for the frozen-value audit to reject.
 *
 * There is no `process.exit()` on the successful path: once bound, the listener
 * keeps the event loop alive and the process stays up serving requests until it is
 * signalled. That is the entire lifecycle.
 */
function start() {
  reportConfigurationDegradation();
  reportFrozenValueConflicts();

  const target = resolveBindTarget();
  const server = createHealthServer();

  server.on('error', (error) => {
    if (shuttingDown) {
      // Teardown noise: the listener is already closing, so an error raised while
      // it winds down must not turn a requested, successful shutdown into a
      // failure. The shutdown path owns the exit code from here.
      return;
    }

    if (server.listening) {
      // Already bound and serving. Report the fault and keep serving: a health
      // endpoint that exits on a transient socket-level error turns the very
      // outage it exists to report into a real one.
      console.error(`health server error while serving: ${describeStartupFailure(error, target)}`);
      return;
    }

    console.error(describeStartupFailure(error, target));
    process.exit(EXIT_STARTUP_FAILURE);
  });

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      shutdown(server, signal);
    });
  }

  server.listen(target.port, target.host, () => {
    // The one and only start-up line: a single, greppable statement of where the
    // endpoint is. A consumer establishes readiness by polling the endpoint itself
    // rather than by parsing this line, so binding must be prompt — there is
    // deliberately no artificial start-up delay anywhere in this file.
    console.log(`health server listening on ${describeBoundUrl(server, target)}`);
  });
}

start();
