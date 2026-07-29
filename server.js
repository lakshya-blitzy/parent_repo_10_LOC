'use strict';

/**
 * Long-lived `/health` server entry point — Level 1 (apex) tier.
 *
 * This is the process entry point that binds the listener and keeps it serving.
 * It is deliberately a *second, parallel* entry point rather than a change to
 * `index.js`, and that separation is the single most important architectural fact
 * about this file.
 *
 * Every emission in `index.js` happens during script initialization: there is no
 * event loop work, no asynchrony and no deferred callback, so the process is
 * one-shot and terminates immediately. A listener makes a process long-lived, and
 * this is the first long-lived process this tier has ever had. Putting
 * `listen()` into `index.js` would therefore make `node index.js` hang forever
 * and destroy the preservation invariant that `node index.js` still exits `0`
 * after writing exactly five lines and fifteen bytes to standard output, with the
 * md5 of that output still `b07373a80ad21069e41be538e6506d00`. The health server
 * is consequently started only by `node server.js` (equivalently, by the `start`
 * script in `package.json` and by the container image's `CMD`), and `index.js` is
 * neither required nor modified from here. The two entry points are independent.
 *
 * Division of responsibility with `health.js` — this file does not duplicate any
 * of it:
 *
 *   - `health.js` owns the payload, the serialization, the contract headers, the
 *     status codes and the routing, and it returns an **unbound** server from
 *     `createHealthServer()`.
 *   - `server.js` owns only the process: resolving the bind target, binding the
 *     listener, emitting one start-up log line, reporting a start-up failure, and
 *     shutting the listener down in an orderly fashion on a signal.
 *
 * Bind-target resolution uses the precedence chain that is uniform across all
 * three tiers of the composition:
 *
 *     environment variable  ->  configuration file  ->  compiled-in literal
 *          HOST / PORT            config/health.json        0.0.0.0 / 3000
 *
 * This tier's override names are exactly `HOST` and `PORT`. Levels 2 and 3
 * deliberately use the prefixed `HEALTH_HOST` and `HEALTH_PORT` names instead
 * because each of those tiers owns a broader process environment; that asymmetry
 * is intentional and must not be "harmonized". The middle link of the chain is
 * read once by `health.js` and consumed here through its resolved `config`
 * export, so `config/health.json` is parsed in exactly one place in the tier and
 * the two cannot drift apart. The compiled-in literals below are the last link
 * and are required rather than decorative: they guarantee the listener still
 * binds and still serves a valid contract when the configuration file is absent
 * from a container image, which is precisely the failure mode a health endpoint
 * has to survive.
 *
 * Deliberately not present, because a single listener is the whole requirement:
 * no clustering, no worker threads, no child process, no daemonization, no PID
 * file, no auto-restart loop, no keep-alive or self-polling timer, no metrics
 * timer, no additional route, no middleware, no static file serving, no TLS
 * termination, no authentication, no CORS handling, no rate limiting, no
 * compression, no logging framework and no third-party package of any kind. The
 * only module this file requires is the tier-local `./health.js`; nothing outside
 * this repository tier is referenced, which is what keeps the composition's
 * levels runtime-independent.
 *
 * Nothing is logged per request. The endpoint has to stay lightweight, and
 * per-request logging would both add work to a probe and bury a CI run's real
 * output in noise. This file logs its bound address once at start-up, one line on
 * shutdown, and diagnostics on standard error when something actually goes wrong.
 *
 * @module server
 * @see health.js — the payload builder, request handler and server factory
 * @see docs/health-endpoint.md — the normative contract for all three tiers
 * @see .env.example — the two environment overrides documented for this tier
 */

const { createHealthServer, config } = require('./health.js');

/**
 * Compiled-in bind-target fallbacks — the last link of the resolution chain.
 *
 * `0.0.0.0` means every interface, which is what a container needs so that its
 * published port is reachable from outside. It is a *bind* address only and never
 * a destination: probes, the container `HEALTHCHECK` and CI all address
 * `127.0.0.1`. Port `3000` is this tier's reserved port in the composition —
 * Levels 2 and 3 own `8000` and `8080` — so all three applications can run side
 * by side on one host during validation.
 *
 * @type {Readonly<{host: string, port: number, path: string}>}
 */
const FALLBACK = Object.freeze({
  host: '0.0.0.0',
  port: 3000,
  path: '/health',
});

/** Lowest valid TCP port; `0` asks the operating system for an ephemeral port. @type {number} */
const MIN_PORT = 0;

/** Highest valid TCP port. @type {number} */
const MAX_PORT = 65535;

/** Matches a bare decimal integer, which is the only port form accepted from a string source. @type {RegExp} */
const DECIMAL_INTEGER = /^[0-9]+$/;

/**
 * The signals that trigger an orderly shutdown.
 *
 * Both are required. `SIGTERM` is what a container runtime and an orchestrator
 * send when stopping a container, so handling it is what makes a stop a graceful
 * close rather than a hard kill. `SIGINT` is what an interactive Ctrl-C and a CI
 * teardown send, and handling it is what guarantees the listener releases its
 * port so the next pipeline run can bind the same port again — that is what makes
 * a workflow re-run idempotent.
 *
 * @type {readonly string[]}
 */
const SHUTDOWN_SIGNALS = Object.freeze(['SIGTERM', 'SIGINT']);

/**
 * Milliseconds an orderly shutdown is allowed before connections are closed
 * forcibly. A client that is mid-request gets a moment to finish; a client
 * holding a socket open indefinitely does not get to hold the port hostage.
 *
 * @type {number}
 */
const SHUTDOWN_GRACE_MS = 5000;

/** Exit code for a requested, orderly shutdown. @type {number} */
const EXIT_SUCCESS = 0;

/** Exit code for a listener that could not be bound. Non-zero so CI fails loudly rather than hanging. @type {number} */
const EXIT_STARTUP_FAILURE = 1;

/**
 * Shutdown latch. Set the first time a shutdown signal is handled so that a
 * second signal — a repeated Ctrl-C, or a `SIGINT` chased by a `SIGTERM` — cannot
 * start a second teardown, and so that the `error` handler can tell a genuine
 * start-up failure apart from teardown noise.
 *
 * @type {boolean}
 */
let shuttingDown = false;

/**
 * Return a candidate as a trimmed, non-empty string, or `null` when it does not
 * qualify.
 *
 * An unset environment variable is `undefined` and an exported-but-empty one is
 * `''`; neither expresses an intent to override, so both are skipped in favour of
 * the next link in the chain rather than being accepted as a deliberate setting.
 *
 * @param {unknown} candidate Value from any link of the resolution chain.
 * @returns {string|null} The trimmed value, or `null` when unusable.
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
 *
 * @param {unknown} candidate Value from any link of the resolution chain.
 * @returns {number|null} The port number, or `null` when unusable.
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
 *
 * @returns {{host: string, port: number}} A bindable target; `host` is a
 *   non-empty string and `port` an integer in `[0, 65535]`.
 */
function resolveBindTarget() {
  const serving = config !== null && typeof config === 'object' ? config : {};

  const host =
    asNonEmptyString(process.env.HOST) ?? asNonEmptyString(serving.host) ?? FALLBACK.host;
  const port = asPort(process.env.PORT) ?? asPort(serving.port) ?? FALLBACK.port;

  return { host, port };
}

/**
 * Resolve the health resource path, used only to make the start-up log line
 * directly actionable. Routing itself is entirely `health.js`'s concern and is
 * never re-derived here.
 *
 * @returns {string} The resource path, always beginning with `/`.
 */
function resolveHealthPath() {
  const serving = config !== null && typeof config === 'object' ? config : {};
  const resolved = asNonEmptyString(serving.path) ?? FALLBACK.path;
  return resolved.startsWith('/') ? resolved : `/${resolved}`;
}

/**
 * Format an address and port as a URL authority, bracketing an IPv6 literal so
 * the result is a syntactically valid URL an operator can paste into a client.
 *
 * @param {string} address Host name or IP literal.
 * @param {number} port TCP port.
 * @returns {string} The authority, for example `0.0.0.0:3000` or `[::1]:3000`.
 */
function formatAuthority(address, port) {
  const needsBrackets = address.includes(':') && !address.startsWith('[');
  return `${needsBrackets ? `[${address}]` : address}:${port}`;
}

/**
 * Build the absolute URL of the health resource as actually bound.
 *
 * `server.address()` is preferred over the requested target because it reports
 * what the operating system really assigned: with `PORT=0` the requested port is
 * `0` while the bound port is an ephemeral one, and only the bound value is
 * useful to an operator or to a reader of a CI log. The requested target remains
 * the fallback for the case where the address is not yet available.
 *
 * @param {import('node:http').Server} server A listening server.
 * @param {{host: string, port: number}} target The requested bind target.
 * @returns {string} An absolute URL, for example `http://0.0.0.0:3000/health`.
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
 * Turn a failure to bind into a message that names the defect and the remedy.
 *
 * A silent hang on a taken port is one of the worst CI failure modes there is:
 * the readiness poll times out, the probe fails, and nothing in the log says why.
 * Each recognised error code therefore gets its own sentence stating what went
 * wrong and what to do about it, and an unrecognised code still reports its code
 * and message rather than an opaque stack trace.
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
        `health server cannot start: ${target.host} is not an address of any local ` +
        'interface. Set HOST to an address this host owns, or to 0.0.0.0 for every ' +
        'interface.'
      );
    default: {
      const reason =
        error !== null && typeof error === 'object' && asNonEmptyString(error.message) !== null
          ? error.message
          : String(error);
      const prefix = code.length > 0 ? `${code}: ` : '';
      return `health server cannot start: binding ${authority} failed. ${prefix}${reason}`;
    }
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
 *      would appear to linger — exactly the orphaned binding that breaks the next
 *      CI run.
 *   3. A grace timer is the backstop for a connection that is genuinely mid-flight
 *      and never completes. It calls `closeAllConnections()` and exits anyway. The
 *      timer is `unref`'d, so it can never itself keep the process alive, and it
 *      never fires at all on the ordinary path, where step 1's callback has
 *      already exited.
 *
 * Exiting with `0` is correct because the shutdown was *requested*: a container
 * stop and a CI teardown are both normal, successful terminations, and reporting a
 * non-zero code for either would make every pipeline teardown look like a failure.
 *
 * The function is idempotent — a second signal returns immediately — so a repeated
 * Ctrl-C cannot start a second teardown or produce a second log line.
 *
 * Both connection-closing methods are feature-detected before use. They are
 * present on every supported runtime, and the guards simply keep an entry point
 * that must never crash while shutting down from depending on that.
 *
 * @param {import('node:http').Server} server The listening server to close.
 * @param {string} signal Name of the signal that requested the shutdown.
 * @returns {void}
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
 * Create the server, bind it, and keep it serving until a signal arrives.
 *
 * Ordering here is deliberate. The `error` listener is attached *before*
 * `listen()` so that a synchronous bind failure cannot become an unhandled
 * `'error'` event, which would crash the process with a stack trace instead of the
 * actionable message {@link describeStartupFailure} produces. The signal handlers
 * are registered before `listen()` too, so a signal that arrives during start-up
 * is still handled rather than terminating the process abruptly.
 *
 * There is no `process.exit()` on the successful path: once bound, the listener
 * keeps the event loop alive and the process stays up serving requests until it is
 * signalled. That is the entire lifecycle.
 *
 * @returns {void}
 */
function start() {
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
    // endpoint is, readable by an operator and by a CI log alike. Readiness in CI
    // is established by polling the endpoint itself, so binding must be prompt —
    // there is deliberately no artificial start-up delay anywhere in this file.
    console.log(`health server listening on ${describeBoundUrl(server, target)}`);
  });
}

start();
