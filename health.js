'use strict';

/**
 * `/health` payload builder and HTTP request handler — Level 1 (apex) tier.
 *
 * This module is the Level 1 (`parent_repo_10_LOC`, JavaScript) implementation of
 * the composition-wide `/health` contract whose single normative definition lives
 * in `docs/health-endpoint.md`. That document is documentation and only
 * documentation: it is never imported, read, parsed or validated against at run
 * time by this file or by any other. The same contract is implemented
 * independently at Level 2 (Python, port 8000) and Level 3 (Java, port 8080);
 * the three implementations are independent siblings that share a *documented*
 * contract and no runtime artifact, which is what keeps the composition's levels
 * runtime-independent. Nothing here references a path outside this tier.
 *
 * The frozen contract implemented below:
 *
 *   | Element         | Normative value                                        |
 *   | --------------- | ------------------------------------------------------ |
 *   | Resource path   | `/health` (from configuration, `/health` by default)   |
 *   | Methods         | `GET`, `HEAD`                                          |
 *   | Success status  | `200 OK` (mandatory for a healthy status)              |
 *   | Content type    | `application/json; charset=utf-8`                      |
 *   | Cache directive | `Cache-Control: no-store`                              |
 *   | Body members    | exactly four, in order: name, version, timestamp, status |
 *   | Serialization   | compact — no insignificant whitespace                  |
 *   | `timestamp`     | RFC 3339 UTC, `Z` suffix, millisecond precision, fresh |
 *   |                 | per request                                            |
 *   | `status`        | the literal string `UP`                                |
 *   | Wrong method    | `405` + `Allow: GET, HEAD` + `{"error":"Method Not Allowed"}` |
 *   | Unknown path    | `404` + `{"error":"Not Found"}`                        |
 *
 * A canonical success body, byte for byte:
 *
 *   {"name":"parent_repo_10_LOC","version":"1.0.0","timestamp":"2026-07-28T13:35:56.452Z","status":"UP"}
 *
 * Standards basis. The payload follows the IETF Internet-Draft *Health Check
 * Response Format for HTTP APIs* (draft-inadarei-api-health-check-06): `status`
 * is that vocabulary's single mandatory root field, `up` is an explicitly
 * accepted healthy value, a healthy status must be returned with a 2xx–3xx code
 * (so `200` is mandatory here rather than merely conventional), and `version`
 * plus a date-time member are named optional fields. Two deliberate divergences:
 * the date-time member is named `timestamp` rather than the draft's `time`,
 * because the draft scopes `time` to when an observed value was *recorded* while
 * this contract carries the *current* time; and the content type is
 * `application/json` rather than `application/health+json`, so that ordinary
 * tooling (`curl`, `jq`, a CI runner, Node's built-in `fetch`) parses the payload
 * with no special handling. `Cache-Control: no-store` follows established
 * health-endpoint operational practice, so that a poller always reads live state
 * rather than an intermediary's cached copy of an earlier answer.
 *
 * Design constraints this file honors, each for a concrete reason:
 *
 *   - **CommonJS only.** `require` / `module.exports`, never `import` / `export`.
 *     The sibling `package.json` deliberately omits the ES-module `type` field so
 *     the whole tier resolves as CommonJS, which is what makes the
 *     `require.main === module` guard in `index.js` work.
 *   - **Standard library only.** `node:http`, `node:fs` and `node:path` are the
 *     only modules required, and the composition's third-party runtime dependency
 *     count stays at zero.
 *   - **Importable with no side effects.** Requiring this module reads two
 *     configuration files and returns; it binds no socket, starts no listener,
 *     writes nothing to either stream and schedules no timer, so the unit suite
 *     can assert the payload without opening a port. All binding lives in
 *     `server.js`.
 *   - **Configuration once, clock per request.** Identity and serving parameters
 *     are resolved a single time at module load; only the clock is read inside
 *     the handler. That keeps the probe lightweight (no per-request I/O) while
 *     still making every response provably fresh.
 *   - **No failure path, therefore no 5xx.** The handler performs no I/O, so the
 *     contract defines no server-error response. Every degradation resolves to a
 *     contract-defined status instead.
 *
 * @module health
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Compiled-in literal fallbacks — the last link of the resolution chain
 * (environment variable, then configuration file, then these).
 *
 * These are required rather than decorative: they guarantee that the endpoint
 * still serves a valid, complete contract when a configuration file is absent
 * from a container image, which is precisely the failure mode a health endpoint
 * has to survive. An endpoint that cannot answer because its own configuration
 * is missing is worse than no endpoint at all, because it turns a running
 * application into one that reports itself unhealthy.
 *
 * @type {Readonly<{name: string, version: string, host: string, port: number, path: string, status: string}>}
 */
const DEFAULTS = Object.freeze({
  name: 'parent_repo_10_LOC',
  version: '1.0.0',
  host: '0.0.0.0',
  port: 3000,
  path: '/health',
  status: 'UP',
});

/**
 * Absolute location of the identity manifest supplying `name` and `version`.
 *
 * Anchored to `__dirname` rather than the process working directory on purpose:
 * the server is started from arbitrary directories (a shell, an npm script, a
 * container `CMD`), and a CWD-relative read would resolve differently in each.
 *
 * @type {string}
 */
const IDENTITY_MANIFEST_PATH = path.join(__dirname, 'package.json');

/**
 * Absolute location of the serving configuration supplying host, port, resource
 * path and the status literal. Anchored to `__dirname` for the same reason.
 *
 * @type {string}
 */
const SERVING_CONFIG_PATH = path.join(__dirname, 'config', 'health.json');

/** Contract content type. Deliberately not `application/health+json`. @type {string} */
const CONTENT_TYPE = 'application/json; charset=utf-8';

/** Contract cache directive: a poller must never read a cached answer. @type {string} */
const CACHE_CONTROL = 'no-store';

/** The only methods the endpoint accepts, in the order the `Allow` header lists them. @type {readonly string[]} */
const ALLOWED_METHODS = Object.freeze(['GET', 'HEAD']);

/** `Allow` header value — single-sourced from {@link ALLOWED_METHODS} as `GET, HEAD`. @type {string} */
const ALLOW_HEADER_VALUE = ALLOWED_METHODS.join(', ');

/** Healthy response status. Mandatory: the health-check draft requires 2xx–3xx for a healthy status. @type {number} */
const STATUS_OK = 200;

/** Response status for any path other than the configured resource path. @type {number} */
const STATUS_NOT_FOUND = 404;

/** Response status for any method other than `GET` or `HEAD`. @type {number} */
const STATUS_METHOD_NOT_ALLOWED = 405;

/**
 * The two error bodies, pre-serialized once because they never vary. Both share
 * the single-member `{"error":"<reason phrase>"}` shape and the same compact
 * separators as the success body, so all three tiers agree byte for byte.
 *
 * @type {string}
 */
const NOT_FOUND_BODY = JSON.stringify({ error: 'Not Found' });

/** @type {string} */
const METHOD_NOT_ALLOWED_BODY = JSON.stringify({ error: 'Method Not Allowed' });

/**
 * Base used only to turn a relative request target into an absolute URL so its
 * path component can be extracted. It is a parsing device and never a
 * destination: no request is ever made to it.
 *
 * @type {string}
 */
const PATH_PARSE_BASE = 'http://127.0.0.1';

/** Lowest valid TCP port number (`0` asks the operating system for an ephemeral port). @type {number} */
const MIN_PORT = 0;

/** Highest valid TCP port number. @type {number} */
const MAX_PORT = 65535;

/** Byte-order mark, stripped before parsing so a BOM-prefixed file still loads. @type {string} */
const BYTE_ORDER_MARK = '\uFEFF';

/**
 * Read and parse a JSON object from disk without ever throwing.
 *
 * A missing, unreadable, empty, malformed or non-object file is an expected and
 * survivable condition here, not an error: the caller falls back to the
 * compiled-in literal for every value it needed. Returning `null` rather than
 * propagating keeps that policy in one place — the resolution chain — instead of
 * spreading `try`/`catch` through configuration handling.
 *
 * Arrays and `null` are rejected along with parse failures, because a caller
 * reading named members from either would silently observe `undefined` and
 * accept it as "configured".
 *
 * @param {string} filePath Absolute path to a UTF-8 encoded JSON document.
 * @returns {Object<string, unknown>|null} The parsed object, or `null` when the
 *   file cannot be read or does not contain a JSON object.
 */
function readJsonFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const text = raw.startsWith(BYTE_ORDER_MARK) ? raw.slice(BYTE_ORDER_MARK.length) : raw;
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    // Deliberately silent and deliberately not rethrown. This runs once at
    // module load, before any logger could be configured, and the documented
    // behavior of a missing or malformed configuration source is that the
    // compiled-in literal fallback takes over rather than that the process dies.
    return null;
  }
}

/**
 * Resolve the first usable string from an ordered list of candidates.
 *
 * Candidates are supplied highest precedence first — environment variable, then
 * configuration file value — and the compiled-in literal is the fallback. A
 * candidate qualifies only when it is a string with non-whitespace content, so
 * an unset variable, an empty string, a `null` and a value of the wrong type are
 * all skipped rather than being accepted as a deliberate override.
 *
 * @param {ReadonlyArray<unknown>} candidates Ordered candidates, highest precedence first.
 * @param {string} fallback Compiled-in literal used when no candidate qualifies.
 * @returns {string} The resolved, trimmed value.
 */
function resolveString(candidates, fallback) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return fallback;
}

/**
 * Resolve the first usable TCP port from an ordered list of candidates.
 *
 * Accepts a JSON number or a decimal string (an environment variable is always a
 * string) and requires an integer inside the valid port range. Anything else —
 * `"abc"`, `"3000x"`, `-1`, `70000`, `3000.5` — is skipped in favour of the next
 * candidate, so a typo in one source degrades to the next source rather than
 * making the listener unbindable.
 *
 * @param {ReadonlyArray<unknown>} candidates Ordered candidates, highest precedence first.
 * @param {number} fallback Compiled-in literal used when no candidate qualifies.
 * @returns {number} The resolved port number.
 */
function resolvePort(candidates, fallback) {
  for (const candidate of candidates) {
    let numeric = null;
    if (typeof candidate === 'number') {
      numeric = candidate;
    } else if (typeof candidate === 'string' && /^[0-9]+$/.test(candidate.trim())) {
      numeric = Number.parseInt(candidate.trim(), 10);
    }
    if (numeric !== null && Number.isInteger(numeric) && numeric >= MIN_PORT && numeric <= MAX_PORT) {
      return numeric;
    }
  }
  return fallback;
}

/**
 * Resolve the resource path, guaranteeing a leading slash.
 *
 * The comparison in {@link handleRequest} is exact equality against a parsed
 * `pathname`, and a parsed pathname always begins with `/`. Normalizing here
 * means a configuration value written as `health` still matches, while a value
 * written as `/health` is passed through untouched. Trailing slashes are
 * deliberately *not* normalized: the contract states that `/health/` does not
 * match `/health`.
 *
 * @param {ReadonlyArray<unknown>} candidates Ordered candidates, highest precedence first.
 * @param {string} fallback Compiled-in literal used when no candidate qualifies.
 * @returns {string} The resolved path, always beginning with `/`.
 */
function resolveHealthPath(candidates, fallback) {
  const resolved = resolveString(candidates, fallback);
  return resolved.startsWith('/') ? resolved : `/${resolved}`;
}

/**
 * Resolve the complete effective configuration, exactly once.
 *
 * Precedence is uniform for every value: **environment variable, then
 * configuration file, then compiled-in literal fallback**. Only `HOST` and
 * `PORT` participate at the environment level, because those are the two
 * overrides this tier declares; Levels 2 and 3 deliberately use the prefixed
 * `HEALTH_HOST` and `HEALTH_PORT` names instead, and that asymmetry is
 * intentional and must not be "harmonized". No environment override exists for
 * the application's identity — `name` and `version` are declared facts of the
 * build, read from the identity manifest, not runtime settings.
 *
 * Both sources are read here and nowhere else, so the whole file has a single
 * place where resolution happens and no value is hard-coded at its point of use.
 *
 * @returns {Readonly<{name: string, version: string, host: string, port: number, path: string, status: string}>}
 *   The frozen effective configuration.
 */
function loadConfig() {
  const identity = readJsonFile(IDENTITY_MANIFEST_PATH) || {};
  const serving = readJsonFile(SERVING_CONFIG_PATH) || {};
  const env = process.env;

  return Object.freeze({
    name: resolveString([identity.name], DEFAULTS.name),
    version: resolveString([identity.version], DEFAULTS.version),
    host: resolveString([env.HOST, serving.host], DEFAULTS.host),
    port: resolvePort([env.PORT, serving.port], DEFAULTS.port),
    path: resolveHealthPath([serving.path], DEFAULTS.path),
    status: resolveString([serving.status], DEFAULTS.status),
  });
}

/**
 * The effective configuration, resolved once at module load and reused for the
 * lifetime of the process.
 *
 * Reading it here rather than per request is a requirement, not an optimization:
 * a health probe must stay lightweight and perform no heavy work, because a probe
 * that does real work becomes a source of the very load it is meant to report on.
 *
 * @type {Readonly<{name: string, version: string, host: string, port: number, path: string, status: string}>}
 */
const config = loadConfig();

/**
 * Build the health payload.
 *
 * The returned object carries **exactly four members in exactly this order** —
 * `name`, `version`, `timestamp`, `status` — because `JSON.stringify` preserves
 * string-key insertion order and consumers compare the serialized *shape*, not
 * merely the parsed fields. Nothing may be added: no `uptime`, no `pid`, no
 * `hostname`, no `releaseId`, no `description` and no `checks` object. A frozen
 * contract with an extension point is a contract with a drift point.
 *
 * `name`, `version` and `status` come from the configuration resolved at module
 * load. `timestamp` is evaluated here, on every call, and is what makes the
 * response proof of *liveness* rather than merely proof of reachability: a
 * process that had frozen after binding its socket could otherwise keep serving a
 * stale but well-formed payload and be called healthy. `Date#toISOString` emits
 * RFC 3339 UTC with a `Z` suffix and exactly three fractional digits natively, so
 * no formatting helper is needed or wanted here.
 *
 * The object is intentionally returned unfrozen and uncached: each call is an
 * independent snapshot that the caller may serialize, assert against or discard.
 *
 * @returns {{name: string, version: string, timestamp: string, status: string}}
 *   A fresh four-member payload; `timestamp` matches
 *   `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`.
 */
function buildHealthPayload() {
  return {
    name: config.name,
    version: config.version,
    timestamp: new Date().toISOString(),
    status: config.status,
  };
}

/**
 * Write a complete JSON response, applying the contract headers last.
 *
 * `Content-Type`, `Cache-Control` and `Content-Length` are assigned after any
 * caller-supplied headers, so a caller can add `Allow` but cannot accidentally
 * override a contract header. `Content-Length` is the **byte** length of the
 * UTF-8 encoded body — obtained from a `Buffer`, never from `String#length` —
 * because that is what a client reads off the wire, and the two differ the moment
 * a body contains a non-ASCII character.
 *
 * When `omitBody` is set the headers, including the full `Content-Length` the
 * body would have had, are still sent and the response is ended without writing
 * the bytes. That is what makes `HEAD /health` a valid, cheap liveness check that
 * nevertheless proves the payload could be built.
 *
 * @param {import('node:http').ServerResponse} res Response to write.
 * @param {{statusCode: number, json: string, omitBody?: boolean, extraHeaders?: Object<string, string>|null}} options
 *   `statusCode` is the HTTP status, `json` the already-serialized compact body,
 *   `omitBody` suppresses the body (`HEAD`), and `extraHeaders` carries
 *   status-specific headers such as `Allow`.
 * @returns {void}
 */
function writeJsonResponse(res, options) {
  const { statusCode, json, omitBody = false, extraHeaders = null } = options;
  const body = Buffer.from(json, 'utf8');
  const headers = extraHeaders === null ? {} : { ...extraHeaders };

  headers['Content-Type'] = CONTENT_TYPE;
  headers['Cache-Control'] = CACHE_CONTROL;
  headers['Content-Length'] = body.length;

  res.writeHead(statusCode, headers);
  res.end(omitBody ? undefined : body);
}

/**
 * Extract the path component of a request target, ignoring any query string.
 *
 * `GET /health?x=1` must be treated exactly as `GET /health`, so the comparison
 * is made against a parsed `pathname` rather than against the raw target. A
 * target that cannot be parsed at all returns `null`, which no configured path
 * can equal, so a malformed request degrades to the contract's `404` instead of
 * escaping as an exception — the handler has no I/O and therefore no legitimate
 * server-error response to fall back on.
 *
 * @param {string|undefined} requestTarget The raw `req.url` value.
 * @returns {string|null} The parsed pathname, or `null` when the target is
 *   absent or unparseable.
 */
function parsePathname(requestTarget) {
  if (typeof requestTarget !== 'string' || requestTarget.length === 0) {
    return null;
  }
  try {
    return new URL(requestTarget, PATH_PARSE_BASE).pathname;
  } catch {
    // An unparseable request target cannot name the health resource, so it is
    // classified as an unknown path. Returning null routes it to the contract's
    // 404 rather than inventing a status the contract does not define.
    return null;
  }
}

/**
 * Tear down a response whose socket can no longer be written to, so a connection
 * is never left hanging half-written.
 *
 * No `try`/`catch` is needed: `destroy` is idempotent and tolerates an already
 * detached socket, and the guards cover a response object that is not a real
 * `ServerResponse` (as a hand-rolled unit-test double may not be).
 *
 * @param {import('node:http').ServerResponse} res Response to destroy.
 * @returns {void}
 */
function destroyResponse(res) {
  if (res && typeof res.destroy === 'function' && res.destroyed !== true) {
    res.destroy();
  }
}

/**
 * Last-resort completion path for an error that cannot occur by design.
 *
 * The handler reads one already-resolved value set and one clock, so it has no
 * I/O and no expected failure path — which is why the contract defines no `5xx`
 * response and none is invented here. This function exists solely so that an
 * exception can never escape the request listener: an escaping exception would
 * either crash the process (turning a health endpoint into an outage) or leave
 * the client waiting on a socket that will never be answered.
 *
 * If nothing has been sent yet, the contract's `404` is returned, because a
 * request that could not even be classified is by definition not a match for the
 * health resource. If a response is already in flight it is simply ended, and if
 * the response object itself is unusable the connection is destroyed.
 *
 * @param {import('node:http').ServerResponse} res Response to finalize.
 * @returns {void}
 */
function finalizeAfterUnexpectedError(res) {
  try {
    if (res.headersSent !== true) {
      writeJsonResponse(res, { statusCode: STATUS_NOT_FOUND, json: NOT_FOUND_BODY });
      return;
    }
    if (res.writableEnded !== true) {
      res.end();
      return;
    }
  } catch {
    // The response is unusable — its socket was torn down mid-flight. Nothing can
    // be written to it, so close the connection rather than leaving it hanging.
    destroyResponse(res);
    return;
  }
  destroyResponse(res);
}

/**
 * `node:http` request listener implementing the complete `/health` contract.
 *
 * Routing order is normative, not incidental:
 *
 *   1. **Method first.** `POST /health` returns `405`, and so does `POST /unknown`
 *      — the request never reaches the path comparison, so a caller always learns
 *      the most actionable fact first: that its method is not permitted anywhere
 *      on this server.
 *   2. **Then the parsed path, compared for exact equality.** A query string is
 *      ignored, and a trailing slash is not normalized, so `/health?x=1` matches
 *      and `/health/` does not.
 *   3. **Then success**, with a freshly built, compactly serialized payload.
 *
 * The handler performs no file I/O, no network call and no dependency
 * interrogation, and it logs nothing: reading an already-loaded value and reading
 * the clock is its entire permitted workload. It never throws.
 *
 * Method names are compared case-insensitively as a defensive measure for direct
 * invocation by unit tests; over the wire Node's HTTP parser only ever surfaces
 * canonical uppercase method tokens.
 *
 * @param {import('node:http').IncomingMessage} req Inbound request.
 * @param {import('node:http').ServerResponse} res Response to write.
 * @returns {void}
 */
function handleRequest(req, res) {
  try {
    const method = typeof req.method === 'string' ? req.method.toUpperCase() : '';
    const omitBody = method === 'HEAD';

    if (!ALLOWED_METHODS.includes(method)) {
      // 405 is never the answer to a HEAD request, since HEAD is allowed, so the
      // body is always written here.
      writeJsonResponse(res, {
        statusCode: STATUS_METHOD_NOT_ALLOWED,
        json: METHOD_NOT_ALLOWED_BODY,
        extraHeaders: { Allow: ALLOW_HEADER_VALUE },
      });
      return;
    }

    if (parsePathname(req.url) !== config.path) {
      writeJsonResponse(res, { statusCode: STATUS_NOT_FOUND, json: NOT_FOUND_BODY, omitBody });
      return;
    }

    writeJsonResponse(res, {
      statusCode: STATUS_OK,
      json: JSON.stringify(buildHealthPayload()),
      omitBody,
    });
  } catch {
    // Unreachable by design — see finalizeAfterUnexpectedError. Present so that
    // no exception can ever escape the request listener.
    finalizeAfterUnexpectedError(res);
  }
}

/**
 * Create an **unbound** HTTP server that serves the health contract.
 *
 * The returned server has no listener attached to any port: binding is the
 * responsibility of `server.js`, which owns the process lifecycle, the `HOST` and
 * `PORT` resolution it reads from {@link config}, the single start-up log line and
 * the `SIGTERM`/`SIGINT` shutdown handlers. Keeping `listen` out of this module is
 * what lets the unit suite require it, assert the contract and exit immediately
 * without ever opening a socket.
 *
 * @returns {import('node:http').Server} A server wired to {@link handleRequest}
 *   and not listening.
 */
function createHealthServer() {
  return http.createServer(handleRequest);
}

/**
 * Public surface consumed by `server.js` (the entry point) and `index.test.js`
 * (the unit suite).
 *
 * `config` is the single resolved source of the serving values; `name`,
 * `version`, `host`, `port`, `path` and `status` mirror its members at the top
 * level, and `healthPath` / `HEALTH_PATH` name the resource path under the two
 * other conventions a consumer may reasonably expect. Every one of those is the
 * same already-resolved value — there is no second resolution and no drift.
 */
module.exports = {
  buildHealthPayload,
  handleRequest,
  createHealthServer,
  config,
  name: config.name,
  version: config.version,
  host: config.host,
  port: config.port,
  path: config.path,
  status: config.status,
  healthPath: config.path,
  HEALTH_PATH: config.path,
};

