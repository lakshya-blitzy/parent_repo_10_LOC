'use strict';

/**
 * `/health` payload builder and HTTP request handler for `parent_repo_10_LOC`.
 *
 * `docs/health-endpoint.md` defines the contract normatively, and it is
 * documentation only: it is never imported, read, parsed or validated against at
 * run time. The sibling Python and Java applications implement the same contract
 * independently, sharing a *documented* contract and no runtime artifact, which is
 * what keeps the levels runtime-independent. Nothing here references a path
 * outside this tier.
 *
 * The frozen contract implemented below:
 *
 *   | Element         | Normative value                                        |
 *   | --------------- | ------------------------------------------------------ |
 *   | Resource path   | `/health` — frozen; configuration may restate it but   |
 *   |                 | never redefine it                                      |
 *   | Methods         | `GET`, `HEAD`                                          |
 *   | Success status  | `200 OK` (mandatory for a healthy status)              |
 *   | Content type    | `application/json; charset=utf-8`                      |
 *   | Cache directive | `Cache-Control: no-store`                              |
 *   | Body members    | exactly four, in order: name, version, timestamp, status |
 *   | Serialization   | compact — no insignificant whitespace                  |
 *   | `timestamp`     | RFC 3339 UTC, `Z` suffix, millisecond precision, fresh |
 *   |                 | per request                                            |
 *   | `status`        | the literal string `UP` — a compiled-in protocol       |
 *   |                 | constant, never a configuration input                  |
 *   | Wrong method    | `405` + `Allow: GET, HEAD` + `{"error":"Method Not Allowed"}` |
 *   | Unknown path    | `404` + `{"error":"Not Found"}`, for a `GET` or a `HEAD` |
 *
 * Routing is METHOD FIRST, then path. `GET` and `HEAD` are accepted, so only a
 * `GET` or `HEAD` for some other path answers `404` — an unsupported method
 * answers `405` with `Allow: GET, HEAD` whatever the path, which makes
 * `POST /unknown` a `405` rather than a `404`. The contract defines exactly those
 * three responses and no 5xx.
 *
 * A canonical success body, byte for byte:
 *
 *   {"name":"parent_repo_10_LOC","version":"1.0.0","timestamp":"2026-07-28T13:35:56.452Z","status":"UP"}
 *
 * Three contract choices look arbitrary and are not. `status: "UP"` and the
 * presence of `version` follow the IETF Internet-Draft *Health Check Response
 * Format for HTTP APIs* (draft-inadarei-api-health-check-06), which also makes
 * `200` mandatory for a healthy status rather than merely conventional. The
 * content type is `application/json` rather than that draft's
 * `application/health+json`, so ordinary tooling parses the payload with no
 * special handling. The date-time member is named `timestamp` rather than the
 * draft's `time` because the draft scopes `time` to when an observed value was
 * *recorded*, while this carries the *current* time.
 *
 * Four constraints, each for a concrete reason:
 *
 *   - **CommonJS only**, never `import` / `export`. The sibling `package.json`
 *     omits the ES-module `type` field so the whole tier resolves as CommonJS,
 *     which is what makes the `require.main === module` guard in `index.js` work.
 *   - **Standard library only** — `node:http`, `node:fs`, `node:path` — so the
 *     third-party runtime dependency count stays at zero.
 *   - **Importable with no side effects.** Requiring this module reads two
 *     configuration files and returns; it binds no socket, writes nothing to
 *     either stream and schedules no timer, so the unit suite can assert the
 *     payload without opening a port. All binding lives in `server.js`.
 *   - **Configuration once, clock per request.** Identity and serving parameters
 *     are resolved a single time at module load; only the clock is read inside
 *     the handler. That keeps the probe lightweight (no per-request I/O) while
 *     still making every response provably fresh.
 *   - **Configuration cannot redefine the frozen contract.** Only the values the
 *     contract leaves open — the identity pair and the bind target — are resolved
 *     from a source outside this file. The resource path and the `status` literal
 *     are compiled-in constants: a configuration document may restate them, and
 *     one that names anything else is *rejected and reported*, never honoured. A
 *     settable path would move the endpoint monitoring polls, and a settable
 *     status would let a deployment lie about its own health; both would corrupt
 *     the contract while leaving the response syntactically valid, which is the
 *     hardest kind of failure to notice.
 *   - **Exactly one accepted request target.** The path comparison is made against
 *     the request target's raw origin-form path, with only the query component
 *     removed. Nothing is percent-decoded, no dot segment is collapsed and no
 *     absolute-form target is accepted, so `/health` is the one and only spelling
 *     that answers `200`.
 *   - **No routed request can produce a 5xx.** The handler performs no I/O, so the
 *     contract defines `200`, `405` and `404` and nothing else, and every
 *     degradation resolves to one of those. The single non-normative exception is
 *     unreachable on every contract path: an internal fault that leaves nothing on
 *     the wire fails closed with a `503` rather than misreporting itself as a
 *     route miss — see {@link finalizeAfterUnexpectedError}.
 *
 * @module health
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

/**
 * The one resource path this tier serves — a frozen contract constant.
 *
 * It is deliberately *not* a setting. The contract admits exactly one route, all
 * three tiers serve the same one, and every probe, `HEALTHCHECK` instruction and
 * workflow assertion in the composition is written against this literal. A
 * configuration document may restate it; a document that names a different path
 * is rejected by {@link findFrozenValueConflicts} and reported at start-up rather
 * than silently moving the endpoint away from where monitoring looks for it.
 *
 * The status literal is frozen in exactly the same way and for the same reasons,
 * and is declared with the other contract constants as {@link STATUS_UP}.
 *
 * @type {string}
 */
const FROZEN_PATH = '/health';

/**
 * Compiled-in literals for every payload and serving value.
 *
 * For `name`, `version`, `host` and `port` these are the last link of the
 * resolution chain (environment variable, then configuration file, then these).
 * They are required rather than decorative: they guarantee that the endpoint
 * still serves a valid, complete contract when a configuration file is absent
 * from a container image, which is precisely the failure mode a health endpoint
 * has to survive. An endpoint that cannot answer because its own configuration
 * is missing is worse than no endpoint at all, because it turns a running
 * application into one that reports itself unhealthy. When a fallback is used
 * because a source was missing or malformed, the reason is recorded in
 * {@link configDegradations} rather than discarded, so the substitution is
 * observable instead of silent.
 *
 * There is deliberately no `status` member here, and `path` is not a fallback but
 * the frozen constant itself. `status` is not a setting and therefore has no
 * fallback: it is the wire protocol's own constant, declared once as
 * {@link STATUS_UP} and never resolved from anything. `path` is single-sourced
 * from {@link FROZEN_PATH} so this object can never drift from it.
 *
 * @type {Readonly<{name: string, version: string, host: string, port: number, path: string}>}
 */
const DEFAULTS = Object.freeze({
  name: 'parent_repo_10_LOC',
  version: '1.0.0',
  host: '0.0.0.0',
  port: 3000,
  path: FROZEN_PATH,
});

/**
 * Absolute location of the identity manifest supplying `name` and `version`.
 *
 * Anchored to `__dirname` rather than the process working directory on purpose:
 * the server is started from arbitrary directories, and a CWD-relative read would
 * resolve differently in each.
 *
 * One measured runtime property matters for the degradation reasons below. Node's
 * CommonJS loader reads the nearest parent `package.json` itself, to decide
 * whether a `.js` file is CommonJS or an ES module. Verified on Node 24.18.0: a
 * *malformed* `package.json` therefore makes `require()` of **any** `.js` file in
 * this directory fail with `ERR_INVALID_PACKAGE_CONFIG` before a single line of
 * this module evaluates, while an *absent* `package.json` loads perfectly. So
 * `identity: declared source malformed` is not reachable at this tier — the
 * process cannot get far enough to report it — and a maintainer trying to
 * reproduce that case will be looking at a loader failure, not at a health
 * diagnostic. `missing`, `unreadable` and `incomplete` are all reachable and are
 * all exercised by the unit suite.
 *
 * @type {string}
 */
const IDENTITY_MANIFEST_PATH = path.join(__dirname, 'package.json');

/**
 * Absolute location of the serving configuration supplying host, port and the
 * resource path. Anchored to `__dirname` for the same reason.
 *
 * That file also *declares* the status literal, to document the contract it
 * serves, but this module never resolves the payload's `status` from that member:
 * see {@link STATUS_UP}. {@link declaredStatus} reads the declaration
 * deliberately, for a caller that wants to inspect it, and the unit suite asserts
 * that the declaration and the constant agree so the two cannot drift.
 *
 * @type {string}
 */
const SERVING_CONFIG_PATH = path.join(__dirname, 'config', 'health.json');

/**
 * The one healthy status value the contract permits: a compiled-in literal, and
 * the one payload member with no precedence chain at all.
 *
 * A wire-protocol constant, not a setting, and that distinction is the whole point
 * of it living here rather than in {@link DEFAULTS}. Nothing may override it — not
 * an environment variable, not `config/health.json`, not anything outside this
 * file — and that is a safety property rather than a simplification. A `status`
 * resolvable from a configuration file would let a deployment, or a stray edit to a
 * container image, publish `"status":"DOWN"` — or any other string — from a process
 * that is running perfectly well, and would let two tiers of this composition
 * disagree about the one value every consumer branches on. This endpoint reports
 * process liveness and performs no dependency checks, so the word on the wire has
 * to mean "this process answered", and it can only mean that if nothing outside
 * this file is able to choose it. A live process is `UP` by definition: the value is
 * compiled in, single-sourced here, and used verbatim by
 * {@link buildHealthPayload}.
 *
 * A configuration file that declares something else is ignored rather than adopted,
 * which follows this module's policy everywhere: degrade to the literal and keep
 * answering, never refuse to serve. The rejection is not silent — see
 * {@link findFrozenValueConflicts}.
 *
 * @type {string}
 */
const STATUS_UP = 'UP';

/** Contract content type. Deliberately not `application/health+json`. @type {string} */
const CONTENT_TYPE = 'application/json; charset=utf-8';
const CACHE_CONTROL = 'no-store';
const ALLOWED_METHODS = Object.freeze(['GET', 'HEAD']);
const ALLOW_HEADER_VALUE = ALLOWED_METHODS.join(', ');

// The three status codes the contract defines, and the only three a routed
// request can produce. `200` is mandatory rather than conventional: the
// health-check draft requires 2xx–3xx for a healthy status.
const STATUS_OK = 200;
const STATUS_NOT_FOUND = 404;
const STATUS_METHOD_NOT_ALLOWED = 405;

/**
 * Status of the last-resort branch in {@link finalizeAfterUnexpectedError}.
 *
 * Not a contract response: the contract defines exactly `200`, `405` and `404`,
 * and a routed request cannot fail. This is the implementation-specific,
 * non-normative answer to a fault that cannot occur by design.
 */
const STATUS_SERVICE_UNAVAILABLE = 503;

// Error bodies, pre-serialized once because they never vary. All three share the
// single-member `{"error":"<reason phrase>"}` shape and the same compact
// separators as the success body.
const NOT_FOUND_BODY = JSON.stringify({ error: 'Not Found' });
const METHOD_NOT_ALLOWED_BODY = JSON.stringify({ error: 'Method Not Allowed' });
const SERVICE_UNAVAILABLE_BODY = JSON.stringify({ error: 'Service Unavailable' });

/**
 * First character of an origin-form request target (RFC 9112, §3.2.1).
 *
 * A target that does not begin with it is absolute-form, authority-form or
 * asterisk-form, none of which names a resource this server serves. An
 * absolute-form target is still *accepted* — it receives a well-formed,
 * contract-defined answer — but it carries its own authority, so honouring it
 * would make this server answer for whatever host name a caller chose to write.
 *
 * @type {string}
 */
const ORIGIN_FORM_PREFIX = '/';

/**
 * Delimiter that begins the query component of a request target. It is the only
 * part of the target the path comparison discards.
 *
 * @type {string}
 */
const QUERY_DELIMITER = '?';

// `0` asks the operating system for an ephemeral port, which is how the test
// suite binds without colliding with a running server.
const MIN_PORT = 0;
const MAX_PORT = 65535;

// Stripped before parsing so a BOM-prefixed configuration file still loads.
const BYTE_ORDER_MARK = '\uFEFF';

/**
 * The two configuration sources, named as an operator sees them in a diagnostic.
 *
 * These are deliberately *categories* rather than file paths. A diagnostic says
 * `identity` or `serving`, never `/opt/app/config/health.json`: a path discloses
 * filesystem layout to anyone who can read the log, and it is also the least
 * useful half of the message, since the reader already knows which files this
 * tier declares. The category plus a reason code is enough to act on.
 *
 * @type {string}
 */
const SOURCE_IDENTITY = 'identity';

/** @type {string} */
const SOURCE_SERVING = 'serving';

/**
 * The closed set of reasons a configuration source can fail to supply values.
 *
 * Fixed, non-sensitive phrases — never an exception message, an `errno` string,
 * a path or a byte of file content. `readFileSync` and `JSON.parse` both report
 * failures with text that interpolates the offending filename or the offending
 * input (`Unexpected token } in JSON at position 118`), so neither is safe to
 * forward to a log verbatim. Each phrase below maps one-to-one onto an operator
 * action: create the file, fix its permissions, fix its syntax, add the missing
 * member.
 *
 * @type {string}
 */
const DEGRADED_MISSING = 'declared source missing';

/** @type {string} */
const DEGRADED_UNREADABLE = 'declared source unreadable';

/** @type {string} */
const DEGRADED_MALFORMED = 'declared source malformed';

/** @type {string} */
const DEGRADED_INCOMPLETE = 'declared source incomplete';

/**
 * `errno` codes that mean the declared file simply is not there.
 *
 * `ENOENT` is the ordinary case. `ENOTDIR` is the same condition reached from a
 * different direction: a path component that should be a directory is a regular
 * file, so the target cannot exist either. Both are reported as *missing* rather
 * than *unreadable*, because the operator action is identical — create it — and
 * calling a nonexistent file "unreadable" would send them to check permissions
 * on a file that is not there.
 *
 * @type {ReadonlySet<string>}
 */
const MISSING_FILE_CODES = new Set(['ENOENT', 'ENOTDIR']);

/**
 * The members `config/health.json` is the declared source for.
 *
 * Used only to decide whether a syntactically valid serving document actually
 * contributed anything. Kept beside the reason codes rather than derived from
 * `DEFAULTS`, because `DEFAULTS` also carries `name` and `version`, which the
 * serving document is explicitly *not* the source of.
 *
 * @type {readonly string[]}
 */
const SERVING_MEMBERS = Object.freeze(['host', 'port', 'path', 'status']);

/** Prefix of the single degraded-configuration diagnostic line. @type {string} */
const DEGRADED_PREFIX = 'health configuration degraded: ';

/** Suffix naming the consequence, so the reader knows the endpoint still answers. @type {string} */
const DEGRADED_SUFFIX = '; serving the compiled-in fallback values';

/**
 * Classify a configuration load failure into one of the fixed reason codes.
 *
 * Order matters. A `SyntaxError` from `JSON.parse` is checked before the generic
 * branch because it is the single most common real-world failure (a hand-edited
 * file with a trailing comma) and it deserves its own actionable phrase. The
 * `errno` test comes next: only `fs` failures carry a `code`, so its presence is
 * what distinguishes "the file system said no" from "the bytes were not JSON".
 *
 * @param {unknown} error The value thrown by `readFileSync` or `JSON.parse`.
 * @returns {string} One of the four `DEGRADED_*` reason codes.
 */
function classifyLoadFailure(error) {
  if (error instanceof SyntaxError) {
    return DEGRADED_MALFORMED;
  }
  const code = error !== null && typeof error === 'object' ? error.code : undefined;
  if (typeof code === 'string') {
    return MISSING_FILE_CODES.has(code) ? DEGRADED_MISSING : DEGRADED_UNREADABLE;
  }
  // No `errno` and not a parse failure: an exotic condition (a `TypeError` from
  // a non-string path, a stream error surfaced synchronously). Reported as
  // unreadable, which is the truthful superset — the bytes did not arrive.
  return DEGRADED_UNREADABLE;
}

/**
 * Read and parse a JSON object from disk without ever throwing, retaining *why*
 * a read failed.
 *
 * A missing, unreadable, empty, malformed or non-object file is an expected and
 * survivable condition here, not a fatal error: the caller falls back to the
 * compiled-in literal for every value it needed. Not throwing keeps that policy
 * in one place — the resolution chain — instead of spreading `try`/`catch`
 * through configuration handling.
 *
 * What this function deliberately does *not* do is discard the reason. An earlier
 * revision returned a bare `null`, which made a missing file, an unreadable file
 * and a malformed file indistinguishable to the caller and therefore to the
 * operator: the endpoint answered `200` with fallback identity and nothing
 * anywhere said the declared source had been ignored. The reason travels back
 * with the document so `loadConfig` can record it.
 *
 * Reporting is the caller's job, not this function's. Requiring this module must
 * stay byte-silent on both streams — the unit suite asserts exactly that — so
 * nothing here writes anywhere. `server.js` renders the recorded reasons once at
 * start-up, where a process that is about to serve traffic can legitimately say
 * something.
 *
 * Arrays and `null` are rejected along with parse failures, because a caller
 * reading named members from either would silently observe `undefined` and
 * accept it as "configured".
 *
 * @param {string} filePath Absolute path to a UTF-8 encoded JSON document.
 * @returns {{document: Object<string, unknown>|null, reason: string|null}} The
 *   parsed object with `reason: null` on success, or `document: null` with the
 *   `DEGRADED_*` code explaining the failure.
 */
function readJsonFile(filePath) {
  let parsed;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const text = raw.startsWith(BYTE_ORDER_MARK) ? raw.slice(BYTE_ORDER_MARK.length) : raw;
    parsed = JSON.parse(text);
  } catch (error) {
    // Deliberately not rethrown: the documented behavior of a missing or
    // malformed configuration source is that the compiled-in literal fallback
    // takes over, not that the process dies before it can serve anything. The
    // reason is classified here and returned, never logged from module scope.
    return { document: null, reason: classifyLoadFailure(error) };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    // Syntactically valid JSON that cannot carry named members. Malformed for
    // this purpose even though `JSON.parse` accepted it.
    return { document: null, reason: DEGRADED_MALFORMED };
  }
  return { document: parsed, reason: null };
}

/**
 * Report whether a candidate qualifies as a deliberately supplied string value.
 *
 * The single definition of "usable", so that the resolution chain and the
 * degradation check can never disagree about whether a source supplied something.
 * An unset variable, an empty string, a whitespace-only string, a `null` and a
 * value of the wrong type all fail, because none of them expresses an operator's
 * intent to override anything.
 *
 * @param {unknown} candidate The value to test.
 * @returns {boolean} `true` when the candidate is a string with non-whitespace content.
 */
function usableString(candidate) {
  return typeof candidate === 'string' && candidate.trim().length > 0;
}

/**
 * Resolve the first usable string from an ordered list of candidates.
 *
 * Candidates are supplied highest precedence first — environment variable, then
 * configuration file value — and the compiled-in literal is the fallback. A
 * candidate qualifies only when {@link usableString} accepts it, so an unset
 * variable, an empty string, a `null` and a value of the wrong type are all
 * skipped rather than being accepted as a deliberate override.
 *
 * @param {ReadonlyArray<unknown>} candidates Ordered candidates, highest precedence first.
 * @param {string} fallback Compiled-in literal used when no candidate qualifies.
 * @returns {string} The resolved, trimmed value.
 */
function resolveString(candidates, fallback) {
  for (const candidate of candidates) {
    if (usableString(candidate)) {
      return candidate.trim();
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
 * Audit a serving document for values that attempt to redefine a frozen contract
 * constant.
 *
 * The resource path and the status literal are part of the contract rather than
 * of the deployment, so this function never *resolves* them — the constants are
 * used directly. What it does is notice when a document declares something other
 * than the frozen value, so the rejection can be reported instead of being
 * swallowed. `config/health.json` ships both keys deliberately, restating the
 * contract where an operator reading the file will see it; a restatement produces
 * no conflict, and an absent key produces none either.
 *
 * Pure by design: it reads no file, writes nothing, logs nothing and throws
 * nothing, so it is safe to call during module load. Reporting is the caller's
 * business — `server.js` owns every line this tier prints.
 *
 * @param {Object<string, unknown>|null} servingDocument The parsed serving
 *   configuration document, or `null` when none could be read.
 * @returns {ReadonlyArray<Readonly<{key: string, configured: string, frozen: string}>>}
 *   One frozen descriptor per rejected value, in document-key order; empty when
 *   the document restates the frozen values or declares neither.
 */
function findFrozenValueConflicts(servingDocument) {
  if (servingDocument === null || typeof servingDocument !== 'object') {
    return Object.freeze([]);
  }

  const conflicts = [];
  const frozenByKey = { path: FROZEN_PATH, status: STATUS_UP };

  for (const key of Object.keys(frozenByKey)) {
    const declared = servingDocument[key];
    if (declared === undefined) {
      continue;
    }
    // A non-string declaration is a conflict too: it is unmistakably an attempt
    // to set the value, and it is not the frozen literal.
    const configured = typeof declared === 'string' ? declared.trim() : String(declared);
    if (configured !== frozenByKey[key]) {
      conflicts.push(Object.freeze({ key, configured, frozen: frozenByKey[key] }));
    }
  }

  return Object.freeze(conflicts);
}

/**
 * The identity manifest as read at module load, with the reason it could not be
 * used when that is what happened.
 *
 * Retained at module scope, rather than being read inside {@link loadConfig}, so
 * that each source is read exactly once no matter how many things need to consult
 * it — {@link loadConfig} resolves values from it and the frozen-value audit
 * inspects it.
 *
 * @type {{document: Object<string, unknown>|null, reason: string|null}}
 */
const IDENTITY_LOAD = readJsonFile(IDENTITY_MANIFEST_PATH);

/**
 * The serving configuration document as read at module load, with the reason it
 * could not be used when that is what happened. Read once, for the same reason as
 * {@link IDENTITY_LOAD}.
 *
 * @type {{document: Object<string, unknown>|null, reason: string|null}}
 */
const SERVING_LOAD = readJsonFile(SERVING_CONFIG_PATH);

/**
 * Resolve the complete effective configuration, exactly once, recording any
 * source that failed to supply what it declares.
 *
 * Precedence is **not** uniform across the five resolved values, and describing it
 * as if it were would misdocument the code. There are three distinct chains:
 *
 *   - `name`, `version` — `package.json`, then the compiled-in literal. No
 *     environment override: identity is a declared fact of the build that tells
 *     an operator which artifact is live, so a value retyped at launch would
 *     defeat the only reason the field exists.
 *   - `host`, `port` — `HOST` / `PORT`, then `config/health.json`, then the
 *     literal. These are the two overrides this tier declares, because a
 *     container or a CI job legitimately relocates the listener without editing a
 *     tracked file. Levels 2 and 3 deliberately use the prefixed `HEALTH_HOST` and
 *     `HEALTH_PORT` names instead; that asymmetry is intentional and must not be
 *     "harmonized".
 *   - `path` — `config/health.json`, then the literal. No environment override,
 *     because moving the resource path per process would break the contract every
 *     consumer probes.
 *
 * `path` and `status` take no part in that chain at all. They are frozen contract
 * constants, assigned here from {@link FROZEN_PATH} and {@link STATUS_UP}, so
 * that no source outside this file can move the endpoint or change what it
 * reports. A document that declares either differently is recorded by
 * {@link findFrozenValueConflicts} and reported by the entry point.
 *
 * Every source is read at module scope and nowhere else, so the whole file has a
 * single place where resolution happens and no value is hard-coded at its point
 * of use.
 *
 * `status` is deliberately absent from what this resolves. It is a protocol
 * constant rather than a serving parameter, so it has no precedence chain and no
 * configuration source at all: see {@link STATUS_UP}.
 *
 * Degradation recording is the second half of the job. When a declared source
 * cannot supply its values, the endpoint still answers — that is the whole point
 * of the literal fallbacks — but the substitution is written into the returned
 * `degradations` list instead of vanishing. `identity` is reported first and
 * `serving` second so the rendered line reads in the order this file declares the
 * sources. Nothing is printed from here: module load must stay byte-silent, and
 * `server.js` renders the list once at start-up.
 *
 * @returns {{values: Readonly<{name: string, version: string, host: string, port: number, path: string}>, degradations: ReadonlyArray<string>}}
 *   The frozen effective configuration and the frozen, possibly empty, list of
 *   `"<source>: <reason>"` degradations in declared order.
 */
function loadConfig() {
  const identity = IDENTITY_LOAD.document || {};
  const serving = SERVING_LOAD.document || {};
  const env = process.env;

  const values = Object.freeze({
    name: resolveString([identity.name], DEFAULTS.name),
    version: resolveString([identity.version], DEFAULTS.version),
    host: resolveString([env.HOST, serving.host], DEFAULTS.host),
    port: resolvePort([env.PORT, serving.port], DEFAULTS.port),
    path: FROZEN_PATH,
  });

  // A source that parsed but supplies none of the members it is the declared
  // source for is a distinct, actionable condition: the file is present and
  // syntactically fine, yet identity or serving values are still coming from the
  // literals. That is exactly the silent substitution this recording exists to
  // surface, so it earns its own reason code rather than being treated as a
  // success. A *partially* populated serving document is not reported: omitting
  // `host` while setting `port` is a supported, documented use of the chain.
  const identityReason = IDENTITY_LOAD.reason
    || (usableString(identity.name) || usableString(identity.version) ? null : DEGRADED_INCOMPLETE);
  const servingReason = SERVING_LOAD.reason
    || (SERVING_MEMBERS.some((member) => serving[member] !== undefined) ? null : DEGRADED_INCOMPLETE);

  const degradations = [];
  if (identityReason !== null) {
    degradations.push(`${SOURCE_IDENTITY}: ${identityReason}`);
  }
  if (servingReason !== null) {
    degradations.push(`${SOURCE_SERVING}: ${servingReason}`);
  }

  return { values, degradations: Object.freeze(degradations) };
}

/**
 * Report the `status` a serving document declares, for inspection only.
 *
 * Reading a declaration and honouring it are different things, and this function
 * exists so the first is possible without the second. An operator comparing a
 * file against what the endpoint reports, or the unit suite proving a declaration
 * is powerless, can call this instead of re-implementing the read — while
 * {@link buildHealthPayload} continues to ignore the value entirely.
 *
 * Mirrors the Python tier's `declared_status`, so the two tiers describe this the
 * same way.
 *
 * @param {Object<string, unknown>|null|undefined} document A parsed serving
 *   configuration document.
 * @returns {string|null} The declared status, trimmed; `null` when the document is
 *   absent, declares nothing, or declares a blank or non-string value.
 */
function declaredStatus(document) {
  if (document === null || typeof document !== 'object') {
    return null;
  }
  const declared = document.status;
  if (typeof declared !== 'string') {
    return null;
  }
  const trimmed = declared.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The effective configuration, resolved once at module load and reused for the
 * lifetime of the process.
 *
 * Reading it here rather than per request is a requirement, not an optimization:
 * a health probe must stay lightweight and perform no heavy work, because a probe
 * that does real work becomes a source of the very load it is meant to report on.
 *
 * @type {Readonly<{name: string, version: string, host: string, port: number, path: string}>}
 */
const { values: config, degradations: configDegradations } = loadConfig();

/**
 * Frozen-value declarations that were rejected, computed once at module load.
 *
 * Empty for the configuration this repository ships, because `config/health.json`
 * restates both frozen values exactly. A non-empty array means the deployed
 * configuration tried to redefine the contract: the endpoint still serves the
 * frozen values — that is the whole point — and `server.js` prints one warning
 * line per entry at start-up so the mismatch is visible to whoever caused it
 * rather than being discovered later as a monitoring outage.
 *
 * @type {ReadonlyArray<Readonly<{key: string, configured: string, frozen: string}>>}
 */
const frozenValueConflicts = findFrozenValueConflicts(SERVING_LOAD.document);

/**
 * Render the recorded configuration degradations as one operator-facing line.
 *
 * Returns `null` — not an empty string — when nothing degraded, so a caller
 * writes the line only when there is something to say. That distinction is the
 * whole reason this returns a value instead of printing: the ordinary,
 * fully-configured start-up must stay silent on both streams, and a caller that
 * had to test a string for emptiness would eventually forget to.
 *
 * Everything in the returned text is a module constant. No path, no file
 * content, no `errno` string and no exception message can reach it, so the line
 * is safe to write to a log an operator, a CI artifact or a container platform
 * will retain. The consequence clause is included deliberately: an operator
 * reading only this line must understand that the endpoint is still answering
 * with valid values, so that a configuration problem is not mistaken for an
 * outage.
 *
 * @returns {string|null} A single line, or `null` when every declared source
 *   supplied its values.
 */
function describeConfigurationDegradation() {
  if (configDegradations.length === 0) {
    return null;
  }
  return `${DEGRADED_PREFIX}${configDegradations.join(', ')}${DEGRADED_SUFFIX}`;
}

/**
 * The last millisecond value {@link currentTimestamp} handed out, or a floor that
 * any real clock reading exceeds.
 *
 * Node runs this module's code on a single thread and the read-modify-write in
 * {@link nextTimestampMs} contains no `await`, so the update is atomic with
 * respect to every other request without a lock. That is a property of the
 * runtime rather than of this design, which is why it is written down here: an
 * `await` introduced inside that function would silently break it.
 *
 * @type {number}
 */
let lastIssuedTimestampMs = -1;

/**
 * Allocate the millisecond value the next timestamp will carry.
 *
 * The wall clock is read on **every** call, so the value tracks real time and is
 * never captured at module load or cached. It is then forced to be *strictly
 * greater* than the previous value handed out, which is what makes the contract's
 * freshness clause hold literally: two consecutive responses always differ in
 * `timestamp`, including two that arrive inside the same millisecond and two that
 * straddle a backwards clock adjustment.
 *
 * Why that matters rather than being a nicety: freshness is the endpoint's proof
 * of *liveness* rather than of mere reachability. A process that had frozen after
 * binding its socket would keep serving a well-formed payload, and comparing two
 * consecutive responses is how a poller detects it — so "the two responses
 * happened to share a millisecond" must never be indistinguishable from "the
 * process stopped moving". A raw `Date.now()` read cannot make that distinction,
 * because this contract's precision is milliseconds and two probes can easily
 * land in one.
 *
 * The correction is bounded and self-cancelling: it advances the issued value by
 * one millisecond per call only while calls arrive faster than the clock ticks,
 * and the moment real time catches up the wall clock wins again, so the value can
 * never drift persistently ahead of it. An endpoint answering a poller every few
 * seconds never enters that regime at all.
 *
 * @returns {number} A millisecond value strictly greater than every value
 *   returned before.
 */
function nextTimestampMs() {
  const now = Date.now();
  lastIssuedTimestampMs = now > lastIssuedTimestampMs ? now : lastIssuedTimestampMs + 1;
  return lastIssuedTimestampMs;
}

/**
 * Render a millisecond instant in the contract's timestamp form.
 *
 * `Date#toISOString` emits RFC 3339 UTC with a `Z` suffix and exactly three
 * fractional digits natively — including when the instant falls on a whole
 * second, where a formatter that trims insignificant zeros would drop the
 * fraction and fail the contract's pattern — so no formatting helper is needed
 * beyond this one call.
 *
 * Exported so a consumer can render a chosen instant, which is what makes the
 * whole-second case assertable deterministically rather than by waiting for the
 * clock to land on one.
 *
 * @param {number} epochMs Milliseconds since the epoch.
 * @returns {string} A timestamp matching
 *   `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`.
 */
function formatTimestamp(epochMs) {
  return new Date(epochMs).toISOString();
}

/**
 * Read the clock and render it as the contract's timestamp.
 *
 * @returns {string} A fresh timestamp, strictly later than every timestamp this
 *   process has returned before.
 */
function currentTimestamp() {
  return formatTimestamp(nextTimestampMs());
}

/**
 * Builds the health payload.
 *
 * The insertion order of the literal below **is** the wire order, because
 * `JSON.stringify` preserves string-key insertion order and consumers compare the
 * serialized *shape*, not merely the parsed fields. Nothing may be added — no
 * `uptime`, `pid`, `hostname`, `releaseId`, `description` or `checks` object: a
 * frozen contract with an extension point is a contract with a drift point.
 *
 * `name` and `version` come from the configuration resolved at module load and
 * `status` is the compiled-in {@link STATUS_UP} constant — never a configuration
 * value, so no deployment can make a running process report anything else. It is
 * referenced directly here rather than through {@link config}, so that the
 * payload's independence from configuration is visible at the point the payload is
 * built.
 * `timestamp` is evaluated here, on every call, through {@link currentTimestamp},
 * and is what makes the response proof of *liveness* rather than merely proof of
 * reachability: a process that had frozen after binding its socket could otherwise
 * keep serving a stale but well-formed payload and be called healthy. See
 * {@link nextTimestampMs} for why the value is additionally required to be strictly
 * later than the one before it, which is what makes that comparison conclusive even
 * for two probes that land inside the same millisecond.
 *
 * The object is returned unfrozen and uncached: each call is an independent
 * snapshot the caller may serialize, assert against or discard.
 */
function buildHealthPayload() {
  return {
    name: config.name,
    version: config.version,
    timestamp: currentTimestamp(),
    status: STATUS_UP,
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
 * Extract the raw origin-form path of a request target, discarding only the query.
 *
 * Exported so the unit suite can assert the routing decision directly, spelling by
 * spelling, with no socket in the way. Levels 2 and 3 apply exactly these steps
 * under the same name, because a contract with one resource must not have a
 * different set of spellings at each tier.
 *
 * `GET /health?x=1` must be treated exactly as `GET /health`, so the query
 * component is cut off. **Nothing else is done to the target**, and that
 * restraint is the point of this function rather than an omission:
 *
 *   - **No URL parsing.** Feeding the target to the WHATWG `URL` parser resolves
 *     dot segments and percent-decodes `%2e`, so `/other/../health`,
 *     `/health/../health`, `/./health` and `/%2e%2e/health` would all collapse to
 *     `/health` and be served `200`. Each is a distinct request target that the
 *     contract requires to answer `404`: the contract admits exactly one route,
 *     and every extra spelling of it is an undocumented alias that monitoring,
 *     access logs and any intermediary see differently from the real one.
 *   - **Origin-form only.** A target that does not begin with `/` is
 *     absolute-form (`GET http://host/health`), authority-form or asterisk-form.
 *     Absolute-form in particular carries its own authority, so honouring it
 *     would make this server answer for any host name a caller cared to write.
 *     The request is still *accepted* — it receives a well-formed, contract-defined
 *     response — but the target does not name a resource this server serves, so
 *     that response is the contract's `404`.
 *   - **No fragment handling.** A fragment is not permitted in a request target
 *     at all (RFC 9112, §3.2), so `/health#x` is treated as the unknown path it
 *     literally is instead of being quietly trimmed back to `/health`.
 *
 * The result is compared for exact equality against {@link FROZEN_PATH}, so a
 * `null` return and any other spelling both route to the contract's `404`. The
 * function reads nothing, allocates at most one substring and cannot throw.
 *
 * @param {string|undefined} requestTarget The raw `req.url` value, which Node
 *   surfaces exactly as it appeared on the request line.
 * @returns {string|null} The raw path with any query removed, or `null` when the
 *   target is absent, empty or not origin-form.
 */
function requestTargetPath(requestTarget) {
  if (typeof requestTarget !== 'string' || requestTarget.length === 0) {
    return null;
  }
  if (!requestTarget.startsWith(ORIGIN_FORM_PREFIX)) {
    return null;
  }

  const queryStart = requestTarget.indexOf(QUERY_DELIMITER);
  return queryStart === -1 ? requestTarget : requestTarget.slice(0, queryStart);
}

/**
 * Error `code` values that mean *the peer went away*, not *this code is broken*.
 *
 * A health endpoint is polled continuously by clients that are entitled to hang
 * up mid-response: a `HEALTHCHECK` whose `--timeout` expired, a load balancer
 * that already got what it needed, a `curl` interrupted by Ctrl-C, an orchestrator
 * culling a probe during a rolling restart. Every one of those surfaces here as a
 * write failure, and none of them is a defect in this process. Reporting them
 * would produce a log that grows with poll volume and says nothing — which is the
 * fastest way to train an operator to ignore the log entirely.
 *
 * The four `E*` codes are socket-level: the peer closed, reset, aborted or timed
 * out. The three `ERR_STREAM_*` codes are the same event observed one layer up,
 * where Node has already torn the response stream down underneath a write.
 *
 * `ERR_HTTP_HEADERS_SENT` is deliberately **absent**. It cannot be caused by a
 * peer: it means this code tried to write a second set of headers, which is a
 * routing defect worth hearing about exactly once.
 *
 * @type {ReadonlySet<string>}
 */
const EXPECTED_TRANSPORT_CODES = new Set([
  'EPIPE',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
  'ERR_STREAM_ALREADY_FINISHED',
]);

/** Prefix of a handler-failure diagnostic. @type {string} */
const HANDLER_FAILURE_PREFIX = 'health request handler failed: ';

/**
 * The three possible consequences, as fixed text.
 *
 * Stating which one occurred is the difference between an operator knowing what
 * the client received and guessing whether it got half a body. All three are
 * module constants, so naming the outcome costs no disclosure risk.
 *
 * @type {string}
 */
const OUTCOME_FAILED_CLOSED = '; answered 503, nothing else had been sent';

/** @type {string} */
const OUTCOME_NO_RESPONSE = '; connection closed without a response';

/** @type {string} */
const OUTCOME_TRUNCATED = '; response already in flight, connection closed';

/**
 * Upper bound on distinct failure categories ever reported.
 *
 * The latch below already collapses repeats of the same category, but a defect
 * that produced an unbounded *variety* of categories could still grow the log
 * without bound. Eight is generous for a handler whose entire workload is one
 * object literal and one clock read: reaching it means something is badly wrong,
 * and the first eight categories are more than enough to diagnose it.
 *
 * @type {number}
 */
const MAX_REPORTED_HANDLER_FAILURES = 8;

/** Cap on a rendered category, so one line stays one readable line. @type {number} */
const MAX_CATEGORY_LENGTH = 64;

/** Substituted for a category that survives sanitization as an empty string. @type {string} */
const UNNAMED_FAILURE_CATEGORY = 'Unnamed';

/**
 * Categories already reported, so a recurring defect is announced once.
 *
 * A `Set` guarded by nothing at all is correct here, and the reason is worth
 * recording because the Level 2 sibling deliberately does the opposite: Python's
 * `ThreadingHTTPServer` runs handlers on real threads, so its equivalent latch
 * needs a mutex around the check-then-add or two simultaneous failures both emit.
 * Node's request listeners all run on one thread, and neither the membership test
 * nor the insertion below contains an `await` or any other suspension point, so
 * the sequence cannot interleave. Adding a lock here would be cargo cult.
 *
 * @type {Set<string>}
 */
const reportedFailures = new Set();

/**
 * Reduce a category to a token that is safe to place in a log line.
 *
 * The category is derived from an exception's `code`, `name` or constructor name.
 * Those are ordinarily tame identifiers, but "ordinarily" is not a security
 * property: `error.name` is a writable property and a class name is attacker-
 * chosen in the general case, so a value containing a newline could forge an
 * entire additional log line — including a line that impersonates this module's
 * own start-up output. Permitting only identifier characters and `.` makes that
 * structurally impossible rather than unlikely.
 *
 * @param {string} category Raw category text.
 * @returns {string} A non-empty token of `[A-Za-z0-9_.]` at most
 *   {@link MAX_CATEGORY_LENGTH} characters long.
 */
function sanitizeCategory(category) {
  let safe = '';
  for (const character of category) {
    if (/^[A-Za-z0-9_.]$/.test(character)) {
      safe += character;
      if (safe.length === MAX_CATEGORY_LENGTH) {
        break;
      }
    }
  }
  return safe.length > 0 ? safe : UNNAMED_FAILURE_CATEGORY;
}

/**
 * Classify a caught value, separating an expected disconnect from a real defect.
 *
 * @param {unknown} error The caught value; JavaScript permits throwing anything.
 * @returns {string|null} A sanitized category to report, or `null` when the
 *   failure is an expected transport condition that must stay quiet.
 */
function classifyHandlerFailure(error) {
  if (error === null || typeof error !== 'object') {
    // `throw 'boom'` is legal JavaScript and is unambiguously a defect. The
    // *type* is recorded; the value never is, because a thrown string is exactly
    // the kind of value that carries interpolated detail.
    return sanitizeCategory(`Thrown_${typeof error}`);
  }
  const code = typeof error.code === 'string' ? error.code : '';
  if (EXPECTED_TRANSPORT_CODES.has(code)) {
    return null;
  }
  if (code.length > 0) {
    return sanitizeCategory(code);
  }
  if (typeof error.name === 'string' && error.name.length > 0) {
    return sanitizeCategory(error.name);
  }
  const constructorName = error.constructor && typeof error.constructor.name === 'string'
    ? error.constructor.name
    : '';
  return sanitizeCategory(constructorName.length > 0 ? constructorName : 'Error');
}

/**
 * Report an unexpected handler failure to `stderr`, at most once per category.
 *
 * What is written is the category and the fixed consequence phrase, and nothing
 * else. The exception's `message` is never rendered: it is the one part of an
 * error that routinely interpolates untrusted or sensitive material — a request
 * target, a filesystem path, a credential that happened to be in scope — and a
 * health endpoint's log is precisely the artifact most likely to be shipped to a
 * central collector. The category is enough to locate the defect in the source;
 * the message would add risk, not information.
 *
 * The write is itself wrapped, because this runs on the last-resort path: if the
 * process's own `stderr` has been closed, failing to log must not escalate into a
 * second exception thrown out of the request listener.
 *
 * @param {string} category Sanitized failure category.
 * @param {string} outcome One of {@link OUTCOME_FAILED_CLOSED},
 *   {@link OUTCOME_NO_RESPONSE} or {@link OUTCOME_TRUNCATED}.
 * @returns {boolean} `true` when this call wrote a line.
 */
function reportHandlerFailure(category, outcome) {
  if (reportedFailures.has(category) || reportedFailures.size >= MAX_REPORTED_HANDLER_FAILURES) {
    return false;
  }
  reportedFailures.add(category);
  try {
    console.error(`${HANDLER_FAILURE_PREFIX}${category}${outcome}`);
    return true;
  } catch {
    // A closed or detached stderr. The category stays latched, so a later
    // successful write is not duplicated by an earlier failed one.
    return false;
  }
}

/**
 * Snapshot of the failure categories reported so far.
 *
 * Exported for the unit suite, which asserts that expected disconnects are absent
 * from it and that a genuine defect appears in it exactly once. Returned frozen
 * and copied, so a caller cannot mutate the live latch.
 *
 * @returns {ReadonlyArray<string>} Categories in the order they were first reported.
 */
function reportedHandlerFailures() {
  return Object.freeze([...reportedFailures]);
}

/**
 * Tears down a response whose socket can no longer be written to, so a
 * connection is never left hanging half-written.
 *
 * No `try`/`catch` is needed: `destroy` is idempotent and tolerates an already
 * detached socket, and the guards cover a response object that is not a real
 * `ServerResponse`, as a hand-rolled unit-test double may not be.
 */
function destroyResponse(res) {
  if (res && typeof res.destroy === 'function' && res.destroyed !== true) {
    res.destroy();
  }
}

/**
 * Last-resort completion path for a failure the handler has no defined response
 * for.
 *
 * **Not part of the contract, and not uniform across the sibling applications.**
 * The contract defines exactly three responses — `200`, `405` and `404` — and no
 * `5xx`, because a routed request performs no I/O and so has no failure path: it
 * reads one already-resolved value set and one clock. This branch is therefore
 * unreachable on every contract path, and what it emits is an
 * implementation-specific, non-normative detail of this runtime rather than
 * behaviour a consumer may rely on. The sibling tiers make the same
 * no-5xx-in-the-contract promise and each fails closed in the way its own runtime
 * allows.
 *
 * It exists at all so that an exception can never escape the request listener: an
 * escaping exception would either crash the process (turning a health endpoint
 * into an outage) or leave the client waiting on a socket that is never answered.
 *
 * Two things it deliberately does not do, both of which it used to:
 *
 *   - **It no longer answers `404`.** A `404` is a statement about the *client's*
 *     request target — "the resource you asked for does not exist here" — so
 *     returning it after an internal failure attributes this process's defect to
 *     the caller. A poller would record a clean, contract-shaped `404`, a human
 *     would go looking for a typo in a URL that was in fact correct, and the real
 *     defect would leave no trace anywhere. A route miss and an internal fault are
 *     different facts and must not be reported with the same status; where a status
 *     can still be chosen, `503` is the honest one.
 *   - **It no longer fails silently.** Closing the connection is the honest
 *     transport-level outcome when nothing can be written, but on its own it is
 *     indistinguishable from a network blip. The failure is therefore recorded
 *     server-side, so the operator sees the cause and the client is never sent a
 *     fabricated success.
 *
 * The resulting behavior, by what the client has already received: nothing yet — a
 * `503` with a compact JSON body; a response in flight — it is ended, because the
 * status line cannot be retracted; a response that can no longer be written to —
 * the connection is destroyed. An expected peer disconnect says nothing on stderr;
 * a genuine defect emits one sanitized line naming the category and the
 * consequence. In no case is any exception detail reflected to the client.
 *
 * This is the internal-fault policy of `docs/health-endpoint.md` §9.3.1, which is
 * canonical for all three tiers: report server-side, never `404` and never `2xx`,
 * fail closed in the way the runtime allows, reflect nothing. The `503` is not part
 * of the contract's normal vocabulary — no routed request can elicit one — so no
 * probe or workflow may treat it as an expected response.
 *
 * @param {import('node:http').ServerResponse} res Response to finalize.
 * @param {unknown} [error] The caught value, used only for classification and
 *   never rendered into the response.
 * @returns {void}
 */
function finalizeAfterUnexpectedError(res, error) {
  // Whether anything reached the client decides which consequence is truthful, so
  // it is read before any teardown can change it. A response object that is not a
  // real `ServerResponse` (a hand-rolled test double) is treated as "nothing sent".
  const headersSent = Boolean(res) && res.headersSent === true;
  const category = classifyHandlerFailure(error);

  if (!headersSent) {
    try {
      // Nothing is on the wire, so a status can still be chosen, and `503` is the
      // only honest one: something inside this process is broken.
      writeJsonResponse(res, {
        statusCode: STATUS_SERVICE_UNAVAILABLE,
        json: SERVICE_UNAVAILABLE_BODY,
      });
      if (category !== null) {
        reportHandlerFailure(category, OUTCOME_FAILED_CLOSED);
      }
      return;
    } catch {
      // The response is unusable — its socket was torn down mid-flight — so no
      // status reached the client after all. Fall through to the transport-level
      // close, and report that as the consequence rather than the `503`.
    }
  }

  if (category !== null) {
    reportHandlerFailure(category, headersSent ? OUTCOME_TRUNCATED : OUTCOME_NO_RESPONSE);
  }

  if (headersSent) {
    try {
      if (res.writableEnded !== true) {
        // Headers and possibly part of a body are already on the wire. Ending the
        // response is the only remaining option: the status line cannot be
        // retracted, and leaving the stream open would hang the client until its
        // own timeout.
        res.end();
        return;
      }
    } catch {
      // The stream was torn down underneath the `end()`. Fall through to destroy.
    }
  }

  // Nothing was sent, or the response object is unusable. Close the connection
  // without writing a status, so the client observes a transport failure — which
  // is what actually happened — rather than a status this process cannot honestly
  // claim.
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
 *   2. **Then the raw origin-form path, compared for exact equality against the
 *      frozen path.** A query string is ignored; nothing else is. A trailing
 *      slash is not normalized, a dot segment is not resolved, a percent-encoded
 *      byte is not decoded and an absolute-form target is not accepted — so
 *      `/health?x=1` matches while `/health/`, `/other/../health`,
 *      `/%2e%2e/health`, `/health#x` and `http://host/health` are each a `404`.
 *   3. **Then success**, with a freshly built, compactly serialized payload.
 *
 * The handler performs no file I/O, no network call and no dependency
 * interrogation: reading an already-loaded value and reading the clock is its
 * entire permitted workload. It never throws.
 *
 * It writes nothing per request — no access log, no timing line — because a probe
 * polled every few seconds would otherwise become the loudest thing in the log.
 * The single exception is bounded and deliberate: a genuinely unexpected internal
 * failure emits one sanitized line the first time each distinct category occurs
 * (see {@link finalizeAfterUnexpectedError}), so a real defect cannot hide inside
 * the silence that per-request quiet requires.
 *
 * Method names are compared case-insensitively as a defensive measure for direct
 * invocation by unit tests; over the wire Node's HTTP parser only ever surfaces
 * canonical uppercase method tokens.
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

    if (requestTargetPath(req.url) !== FROZEN_PATH) {
      writeJsonResponse(res, { statusCode: STATUS_NOT_FOUND, json: NOT_FOUND_BODY, omitBody });
      return;
    }

    writeJsonResponse(res, {
      statusCode: STATUS_OK,
      json: JSON.stringify(buildHealthPayload()),
      omitBody,
    });
  } catch (error) {
    // Two distinct populations arrive here and must not be conflated: a peer that
    // hung up mid-write (routine, silent) and a defect in the code above (rare,
    // reportable). The caught value is bound and forwarded so that
    // finalizeAfterUnexpectedError can tell them apart — an unbound `catch` threw
    // that information away and made every failure look like the harmless kind.
    finalizeAfterUnexpectedError(res, error);
  }
}

/**
 * Creates an **unbound** HTTP server: nothing here listens on a port.
 *
 * Binding is `server.js`'s responsibility, along with the process lifecycle, the
 * start-up log line and the signal handlers. Keeping `listen` out of this module
 * is what lets the unit suite require it, assert the contract and exit
 * immediately without ever opening a socket.
 */
function createHealthServer() {
  return http.createServer(handleRequest);
}

/**
 * Public surface consumed by `server.js` (the entry point) and `index.test.js`
 * (the unit suite).
 *
 * `config` is the single resolved source of the serving values; `name`,
 * `version`, `host`, `port` and `path` mirror its members at the top level, and
 * `healthPath` / `HEALTH_PATH` name the resource path under the two other
 * conventions a consumer may reasonably expect. Every one of those is the same
 * already-resolved value — there is no second resolution and no drift.
 *
 * `status` and `STATUS_UP` are the same compiled-in protocol constant, exported
 * under both names and deliberately *not* a member of `config`: it is not a
 * setting, so it does not appear among the resolved settings, and no consumer
 * should be able to read it as though it were one. `declaredStatus` is exported
 * alongside them so that a caller can still inspect what a configuration file
 * declared, without that declaration ever influencing what is served.
 *
 * The diagnostics surface — `configDegradations`,
 * `describeConfigurationDegradation` and `reportedHandlerFailures` — exists so
 * that the two conditions this module survives silently by design are
 * nevertheless *observable*: a configuration source that failed to supply its
 * values, and a genuinely unexpected handler failure. Both are recorded here and
 * rendered elsewhere, which is what keeps module load byte-silent while still
 * leaving an operator something to act on.
 *
 * `requestTargetPath` is exported so that the unit suite can assert the routing
 * decision directly, spelling by spelling, without binding a socket.
 *
 * `currentTimestamp` and `formatTimestamp` are exported so the freshness clause can
 * be asserted directly: the first proves that two immediate calls differ, and the
 * second renders a chosen instant so the whole-second case is deterministic.
 *
 * `frozenValueConflicts` is the audit trail for the two values configuration may
 * not redefine: empty in a correctly configured deployment, and one descriptor
 * per rejected declaration otherwise. `server.js` turns it into start-up warnings.
 */
module.exports = {
  buildHealthPayload,
  currentTimestamp,
  formatTimestamp,
  handleRequest,
  createHealthServer,
  requestTargetPath,
  declaredStatus,
  config,
  configDegradations,
  describeConfigurationDegradation,
  reportedHandlerFailures,
  frozenValueConflicts,
  name: config.name,
  version: config.version,
  host: config.host,
  port: config.port,
  path: config.path,
  status: STATUS_UP,
  STATUS_UP,
  healthPath: config.path,
  HEALTH_PATH: config.path,
};
