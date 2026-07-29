'use strict';

/**
 * Level 1 (apex) unit suite — `parent_repo_10_LOC`, JavaScript, port 3000.
 *
 * The file name is load-bearing. `node --test`, invoked with no arguments and no
 * configuration, discovers `*.test.js` by default, so `index.test.js` at the tier
 * root is picked up with zero setup and zero dependencies. Renaming it, moving it
 * into a `tests/` directory or switching to `.spec.js` would silently remove it
 * from the default run.
 *
 * Eight groups, each here for a reason the code alone does not show:
 *
 *   A. **Export surface.** `add` returns `12` for `(5, 7)` *and* is reachable as an
 *      export, which is what locks in the export surface rather than merely
 *      restating arithmetic.
 *   B. **Non-regression, measured rather than intended.** Importing `index.js` must
 *      write nothing, and running it directly must still emit exactly five lines
 *      and fifteen bytes whose md5 is `b07373a80ad21069e41be538e6506d00`. Both are
 *      checked in a real child process, because `require`'s module cache makes any
 *      in-process check of load-time output unreliable, and monkey-patching
 *      `console.log` would test the patch rather than the program.
 *   C. **The frozen `/health` contract**, first against the payload builder in
 *      isolation and then over a real TCP socket: status line, both contract
 *      headers, exactly four body members in a fixed order, the literal `UP`, an
 *      RFC 3339 UTC timestamp that is provably fresh, compact serialization, and
 *      the two negative paths — `405` with `Allow: GET, HEAD`, and `404` — with the
 *      method checked before the path, so `POST /unknown` is a `405`.
 *   D. **The two values configuration may declare but not redefine.** The resource
 *      path and the `status` literal are read from the serving document like every
 *      other setting, but validated against the contract before they are adopted:
 *      a declaration that restates the literal is taken from the file, and anything
 *      else is refused in favour of the literal and recorded as a conflict. This
 *      group loads `health.js` in a child process behind an injected loader that
 *      returns a hostile serving document, and proves the endpoint still routes on
 *      `/health` and still reports `UP` — while asserting that the two freely
 *      configurable values in that same document, host and port, *did* change, so
 *      the group cannot pass vacuously. The exported provenance is asserted
 *      alongside every value, so an adoption and a refusal are told apart rather
 *      than inferred from a value that happens to look right, and a second
 *      sub-group asserts both directions for `status`: a legal declaration is
 *      adopted from the file, an illegal one falls back and is reported.
 *   E. **One resource, one spelling**, asserted against the routing decision
 *      directly and then again with request lines written to a socket by hand.
 *      `/health` is the only spelling of the resource: a percent-encoded,
 *      repeated-slash, dot-segment, fragment, absolute-form or protocol-relative
 *      variant of it must answer `404`. A general-purpose URL parser folds several
 *      of those onto `/health`, so proving the rule requires transmitting the
 *      target verbatim, which no HTTP client will do.
 *   F. **Configuration resilience, and a fallback that is never silent.** The
 *      documented precedence chain ends in a compiled-in literal, and that last
 *      link is a contract requirement rather than a nicety: the endpoint must still
 *      serve when its configuration cannot be read at all. So a copy of `health.js`
 *      is loaded from a private temporary directory whose identity and serving
 *      sources are missing, malformed, not JSON objects, or carry values of the
 *      wrong type; every resolved value is asserted to be the documented literal;
 *      the recorded reason for each substitution is asserted alongside it; and that
 *      reason is asserted once more as the single line `server.js` writes at
 *      start-up.
 *   G. **Diagnostics that can be neither misattributed nor forged.** An unexpected
 *      handler failure must be reported as what it is rather than rendered as a
 *      misleading `404`, an expected transport error — a peer that hung up — must
 *      not be reported at all, and a configuration-derived host carrying a newline
 *      must never be able to write a second log line that reads like this server's
 *      own start-up announcement.
 *   H. **The process entry point.** `server.js` calls `start()` at load and exports
 *      nothing, so a real child process is the only honest way to exercise it:
 *      bind-target resolution, the single announced start-up line, the contract
 *      served over the announced port, prompt `SIGTERM`/`SIGINT` shutdown with exit
 *      `0` and a released port, and an actionable diagnostic with exit `1` when the
 *      port is already taken.
 *
 * Freshness is asserted between **immediately consecutive** calls and responses,
 * with no delay inserted anywhere. That is deliberate: inserting a wait past a
 * millisecond boundary first would reduce the assertion to "the clock moved", which
 * a builder returning duplicates to two probes landing in the same millisecond
 * would still satisfy. The burst assertions go further and draw many samples inside
 * a single millisecond tick, where uniqueness and strict ordering can only hold if
 * the timestamp is allocated monotonically rather than read raw. A companion
 * assertion bounds how far that allocation may sit ahead of real time, so the
 * correction is proven finite and self-correcting rather than a licence to drift.
 *
 * The contract asserted here is defined normatively in `docs/health-endpoint.md`
 * and implemented in `health.js`. That document is documentation only — it is
 * never read, parsed or imported at run time, by this file or any other.
 *
 * Design constraints this file honors, each for a concrete reason:
 *
 *   - **Standard library only.** `node:test`, `node:assert/strict`, `node:crypto`,
 *     `node:child_process`, `node:fs`, `node:net`, `node:os` and `node:path` are
 *     the only external modules required; the built-in global `fetch` is the HTTP
 *     client wherever a normalized request is what is wanted, and `node:net`
 *     carries the hand-written request lines where it is not. `node:net` is not
 *     optional: `fetch` — like every conforming client — normalizes a URL before it
 *     reaches the wire, so it would turn `/other/../health` into `/health` in the
 *     client and assert nothing at all about the server. The composition's
 *     third-party dependency count is zero and this suite keeps it there: no test
 *     runner, no assertion library, no HTTP client package, no coverage package,
 *     and no mocking library — every subject is exercised for real, in this
 *     process or in a child process.
 *   - **Every wait is bounded.** Child processes carry a timeout, every socket
 *     exchange carries one, and every request goes through {@link request}, which
 *     supplies an `AbortSignal.timeout`. A stalled handler or a socket that never
 *     answers therefore fails the run with a named cause instead of hanging
 *     indefinitely.
 *   - **CommonJS only.** `require`, never `import`. The sibling `package.json`
 *     deliberately omits the ES-module `type` field, and that omission is exactly
 *     what makes the `require.main === module` guard in `index.js` work.
 *   - **Tier-local references only.** Every path resolved here is inside this
 *     repository, anchored to `__dirname`. Nothing reaches into
 *     `child_repo_10_LOC` or below: the three tiers are runtime-independent
 *     siblings that share a documented contract and no runtime artifact. Levels 2
 *     and 3 own their own suites.
 *   - **Never binds port 3000.** Every server started here binds port `0` — an
 *     operating-system assigned ephemeral port — on the loopback interface, and
 *     the real port is read back from `server.address().port`. Port 3000 is this
 *     tier's declared default, so anything already serving on it would race this
 *     suite for the port; binding an ephemeral one instead removes the race
 *     entirely rather than relying on the two never overlapping.
 *   - **Leaves nothing running.** Every server is closed in an `after` hook, every
 *     child process is signalled and awaited, and idle keep-alive sockets are
 *     destroyed explicitly, so the process exits on its own and no port stays bound.
 *   - **Never writes inside the repository.** The groups that need a tampered or
 *     absent configuration build one in a private directory under the operating
 *     system's temporary root, created with `fs.mkdtempSync` and removed in an
 *     `after` hook. No repository file is created, modified, moved or deleted by
 *     this suite, and the configuration-resilience group proves it by comparing the
 *     two real configuration sources byte-for-byte afterwards.
 *
 * Run it with `node --test`, `node --test index.test.js`, or `npm test`.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { add } = require('./index.js');
const health = require('./health.js');
const manifest = require('./package.json');
const servingConfig = require('./config/health.json');

/*
 * The contract, expressed once as literals, deliberately hard-coded rather than
 * read back from the module under test: a test that sources its expected values
 * from its subject asserts only self-consistency and passes whether the subject is
 * right or wrong. Every value below is the independent expectation from
 * `docs/health-endpoint.md`, so drift in either direction fails with a named cause.
 */

// The declared identity and defaults. The port and host are asserted as
// *declarations*; this suite never binds either.
const TIER_NAME = 'parent_repo_10_LOC';
const TIER_VERSION = '1.0.0';
const TIER_DEFAULT_PORT = 3000;
const TIER_DEFAULT_HOST = '0.0.0.0';

// The contract surface. `CONTENT_TYPE` is asserted byte for byte including the
// charset parameter, and `ALLOW_HEADER` down to its single comma and space.
const HEALTH_PATH = '/health';
const STATUS_LITERAL = 'UP';
const CONTENT_TYPE = 'application/json; charset=utf-8';
const CACHE_CONTROL = 'no-store';
const ALLOW_HEADER = 'GET, HEAD';
const PAYLOAD_KEYS = Object.freeze(['name', 'version', 'timestamp', 'status']);
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const NOT_FOUND_BODY = '{"error":"Not Found"}';
const METHOD_NOT_ALLOWED_BODY = '{"error":"Method Not Allowed"}';

/**
 * Request targets and the path each one must yield, or `null` for no path at all.
 *
 * The rule is the most restrictive one the contract admits, and these rows are its
 * definition: a target that does not begin with `/` names no path at all, and for
 * one that does, everything from the first `?` onwards is discarded and what is
 * left is the path *verbatim* — nothing decoded, no run of slashes collapsed, no
 * dot segment resolved, no fragment trimmed.
 *
 * The rows that matter are the ones a URL parser answers differently. `new URL()`
 * resolves dot segments, so it reports `/health` for `//../health` and for
 * `/./health`; percent-decoding does the same for `/%68ealth`; and it reads the
 * absolute-form target `http://host/health` as carrying its own authority with
 * `/health` as the path. Routing on a parsed path would therefore serve this
 * endpoint under spellings the contract never defined — and under a *different set*
 * of them at each tier, since the three runtimes normalize differently. The
 * expectation for every alias below is therefore the target's own text, unchanged,
 * and for every form that is not origin-form it is `null`.
 *
 * @type {ReadonlyArray<readonly [string, string|null]>}
 */
const TARGET_PATH_CASES = Object.freeze([
  ['/health', '/health'],
  ['/health?x=1', '/health'],
  ['/health?', '/health'],
  ['/health#fragment', '/health#fragment'],
  ['/health?x=1#fragment', '/health'],
  ['/%68ealth', '/%68ealth'],
  ['/%2Fhealth', '/%2Fhealth'],
  ['///health', '///health'],
  ['//../health', '//../health'],
  ['/./health', '/./health'],
  ['/health%2F', '/health%2F'],
  ['/health/', '/health/'],
  ['/health/../health', '/health/../health'],
  ['/HEALTH', '/HEALTH'],
  ['/healthz', '/healthz'],
  ['//health', '//health'],
  ['/unknown', '/unknown'],
  ['/', '/'],
  ['*', null],
  ['health', null],
  ['', null],
  // Absolute-form. A request line may legally carry one, and a URI parser reads
  // every one of these as the path `/health` under an authority of the caller's
  // choosing — which is how an endpoint with one documented route acquires a
  // second one that answers for any host name a caller cares to write. None of
  // them begins with `/`, so none of them names a path here.
  ['http://127.0.0.1:3000/health', null],
  ['http://127.0.0.1:3000', null],
  ['http://127.0.0.1:3000/%68ealth', null],
  ['http://127.0.0.1:3000/health?x=1', null],
  ['http://127.0.0.1:3000///health', null],
  ['HTTP://127.0.0.1:3000/health', null],
  // Protocol-relative. This one *does* begin with `/`, so it names a path — its
  // own text, which is not the health path.
  ['//127.0.0.1/health', '//127.0.0.1/health'],
  // A scheme with no authority is not absolute-form either, and it is the case a
  // URI parser gets wrong in the other direction: Node's WHATWG parser and Java's
  // `URI` both report `/health` for the first two.
  ['http:/health', null],
  ['HTTP:/health', null],
  ['http:health', null],
  ['a:b/health', null],
]);

/**
 * Spellings that must be served, written to the wire exactly as they appear here.
 *
 * The last three are here because the routing rule discards everything from the
 * first `?` onwards, and nothing else: a client that attached a query named nothing
 * by it, and the resource it named is the health path. That is also why the fourth
 * is served while a bare `/health#fragment` is not — here the `#` falls inside the
 * discarded query component, so it never reaches the comparison.
 *
 * @type {ReadonlyArray<string>}
 */
const SERVED_TARGETS = Object.freeze([
  '/health',
  '/health?probe=1&verbose=true',
  '/health?',
  '/health?x=1#fragment',
]);

/**
 * Spellings that must NOT be served, written to the wire exactly as they appear.
 *
 * Two classes are collected here, because both must answer identically and a
 * caller cannot tell them apart. The first is the aliases: every target some parser
 * reports as `/health` — percent-encoded spellings, repeated leading slashes, dot
 * segments, percent-encoded dot segments, a fragment, and the absolute-form and
 * protocol-relative targets that carry an authority of the caller's choosing. The
 * second is the plain non-matches: a case variant, a prefix variant, an unrelated
 * path, the root, the asterisk form and a bare authority.
 *
 * Node's HTTP server surfaces all of them in `req.url` verbatim, so every one
 * reaches the handler and every one must answer the contract's own JSON `404` —
 * there is no spelling of this resource at this tier that the runtime answers on
 * the application's behalf. (The four scheme-without-authority targets are the
 * exception and are asserted separately; see {@link RUNTIME_REFUSED_TARGETS}.)
 *
 * @type {ReadonlyArray<string>}
 */
const UNSERVED_TARGETS = Object.freeze([
  '/%68ealth',
  '/%2Fhealth',
  '//health',
  '///health',
  '////health',
  '//../health',
  '/./health',
  '/other/../health',
  '/a/b/../../health',
  '/%2e%2e/health',
  '/%2E%2E/health',
  '/health%2F',
  '/health/',
  '/health/../health',
  '/health#fragment',
  '/HEALTH',
  '/healthz',
  '/unknown',
  '/',
  '//127.0.0.1/health',
  '//evil.example.com/health',
  'http://evil.example.com/health',
  '*',
  '//',
]);

/**
 * Targets this runtime's parser refuses before any request listener runs.
 *
 * A request target carrying a scheme is validated by Node's HTTP parser, which
 * rejects all four of these with a `400 Bad Request` of its own making — so unlike
 * every entry in {@link UNSERVED_TARGETS} they never reach the handler and the
 * response body is the runtime's, not this application's.
 *
 * This is recorded as its own group rather than folded into the table above
 * because the three tiers genuinely differ here and a probe must not assume
 * otherwise: the Python tier answers all four with the application's JSON `404`,
 * the Java tier answers the first two the same way and closes the connection with
 * no response at all for the opaque last two. What every tier guarantees — and
 * what is asserted — is that the endpoint is never served through any of them, no
 * response ever carries the payload, and the listener keeps serving afterwards.
 *
 * @type {ReadonlyArray<string>}
 */
const RUNTIME_REFUSED_TARGETS = Object.freeze([
  'http:/health',
  'HTTP:/health',
  'http:health',
  'a:b/health',
]);

/**
 * Methods that must be refused with `405`, every one of them recognised by the
 * runtime's parser and therefore reaching the handler.
 *
 * The WebDAV entries are deliberate: a health endpoint answers the same way
 * whatever is thrown at it, and a handler that special-cased a shortlist would
 * leave the rest to whatever the runtime does by default.
 *
 * @type {ReadonlyArray<string>}
 */
const REFUSED_METHODS = Object.freeze([
  'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE', 'PROPFIND', 'MKCOL',
]);

/**
 * Method tokens the runtime's parser refuses before any request listener runs.
 *
 * Node validates the method token against its own table and answers anything
 * outside it — including a correctly spelled method in the wrong case, since
 * methods are case-sensitive — with `400 Bad Request` of its own making. That is a
 * boundary of the runtime, not a behaviour of this application, and it is asserted
 * for exactly what it guarantees: the endpoint is not served that way.
 *
 * @type {ReadonlyArray<string>}
 */
const UNPARSABLE_METHOD_TOKENS = Object.freeze(['FROBNICATE', 'get']);

/** Line terminator the protocol requires between the request line and each field. */
const CRLF = '\r\n';

/** The empty line that ends a header block. */
const HEAD_BODY_SEPARATOR = CRLF + CRLF;

/** Upper bound on a hand-written exchange, so a lost response fails rather than hangs. */
const RAW_SOCKET_TIMEOUT_MS = 5000;

/** Status a tampered configuration file declares, which the payload must ignore. */
const TAMPERED_STATUS = 'DOWN';

/** The historical standard output of `node index.js`: five lines, fifteen bytes. */
const GOLDEN_STDOUT = '12\n12\n12\n12\n12\n';
const GOLDEN_STDOUT_BYTES = 15;
const GOLDEN_STDOUT_LINES = 5;
const GOLDEN_STDOUT_MD5 = 'b07373a80ad21069e41be538e6506d00';

// Anchored to `__dirname`, so the suite never depends on the working directory. A
// probe asserts the state of *this* process, so it addresses the loopback
// interface, and port `0` asks the operating system for an ephemeral port.
const INDEX_PATH = path.join(__dirname, 'index.js');

/** Absolute path to the health module, required by the child processes below. */
const HEALTH_PATH_ON_DISK = path.join(__dirname, 'health.js');

/** Path suffix the injected loader in Group D intercepts. */
const SERVING_CONFIG_SUFFIX = path.join('config', 'health.json');

/** Absolute path to the entry point, used by the start-up diagnostic group. */
const SERVER_PATH = path.join(__dirname, 'server.js');

/** Absolute path to the identity manifest, whose bytes the resilience group proves unchanged. */
const MANIFEST_PATH_ON_DISK = path.join(__dirname, 'package.json');

/** Absolute path to the serving configuration, whose bytes the resilience group proves unchanged. */
const SERVING_CONFIG_PATH_ON_DISK = path.join(__dirname, 'config', 'health.json');

/** The identity manifest's basename, as `health.js` resolves it. */
const IDENTITY_MANIFEST_NAME = 'package.json';

/** The serving configuration's path relative to a tier root. */
const SERVING_CONFIG_RELATIVE = path.join('config', 'health.json');

/**
 * The closed vocabulary of degradation reasons, as independent literals.
 *
 * Pinned here rather than read back from `health.js` for the same reason every
 * other expectation is: a test that sources its expected strings from its subject
 * passes whether the subject is right or wrong. These are the operator-facing
 * phrases, and changing one is a contract change that must fail this suite.
 */
const DEGRADED_MISSING = 'declared source missing';

/** @see DEGRADED_MISSING */
const DEGRADED_UNREADABLE = 'declared source unreadable';

/** @see DEGRADED_MISSING */
const DEGRADED_MALFORMED = 'declared source malformed';

/** @see DEGRADED_MISSING */
const DEGRADED_INCOMPLETE = 'declared source incomplete';

/** The two source categories a degradation names. */
const SOURCE_IDENTITY = 'identity';

/** @see SOURCE_IDENTITY */
const SOURCE_SERVING = 'serving';

/** Prefix of the single degraded-configuration line. */
const DEGRADED_PREFIX = 'health configuration degraded: ';

/** Prefix of a handler-failure diagnostic. */
const HANDLER_FAILURE_PREFIX = 'health request handler failed: ';

/** Upper bound on distinct reported handler-failure categories. */
const MAX_REPORTED_HANDLER_FAILURES = 8;

/** Placeholder a rejected host or port is replaced with, shared by all three tiers. */
const UNSAFE_TEXT = '<unprintable>';

/**
 * Sentinel telling the workspace builder to create a *directory* where a file
 * belongs, which is how an unreadable source is simulated.
 *
 * A `chmod 000` would be the obvious approach and is the wrong one: CI commonly
 * runs as `root`, for whom mode bits do not deny access, so the case would
 * silently become a *readable* file and the assertion would test nothing. A
 * directory in the file's place fails the read for every user, including root.
 */
const AS_DIRECTORY = Symbol('as-directory');

/**
 * Strings that must never appear in any diagnostic this suite provokes.
 *
 * Each one is planted in an exception message, a host value or a file path during
 * the tests below, so finding any of them in captured output proves a real
 * disclosure rather than a hypothetical one.
 */
const FORBIDDEN_IN_DIAGNOSTICS = Object.freeze([
  'SENSITIVE',
  'token=',
  '/etc/shadow',
  os.tmpdir(),
  IDENTITY_MANIFEST_NAME,
  'health.json',
]);

/** Loopback interface. A probe asserts the state of *this* process, so it addresses `127.0.0.1`. */
const LOOPBACK = '127.0.0.1';

/**
 * The operating system's "assign me any free port" sentinel.
 *
 * Usable only where the *suite itself* binds the listener, because a resolved
 * configuration port of `0` is rejected at every tier: a health endpoint whose port
 * the operating system chose cannot be addressed by a container `HEALTHCHECK`, a
 * workflow probe or an orchestrator, all of which are configured with a fixed
 * number. Anything that has to reach a *child's* listener therefore reserves a
 * concrete number with {@link reserveFreePort} instead.
 */
const EPHEMERAL_PORT = 0;

// Upper bound on a child process, so a hung child fails the run with a clear
// timeout instead of stalling it indefinitely. Every child spawned here exits in a
// few tens of milliseconds; this bound exists only to fail safely.
const CHILD_TIMEOUT_MS = 30000;

/**
 * Number of samples drawn by the burst assertions.
 *
 * Large enough that the loop provably completes inside a single millisecond tick
 * on any plausible machine — which is exactly the regime a wall-clock read cannot
 * survive and the allocator must — while still finishing in microseconds.
 */
const BURST_SAMPLE_COUNT = 500;

/**
 * Number of requests the wire-level burst assertion issues back to back.
 *
 * Kept small because each one is a real socket round-trip; the point is only that
 * consecutive *responses* never repeat a timestamp, which the sequential builder
 * burst already establishes at volume.
 */
const WIRE_BURST_REQUEST_COUNT = 8;

/**
 * Slack added to the *observed* excursion when bounding how far the allocator may
 * sit ahead of the wall clock.
 *
 * The budget is derived from the excursion the suite itself just caused rather
 * than being a fixed constant, because the ceiling is a function of how many
 * timestamps have been drawn — and `node --test` may run files and tests in an
 * order that changes that count. A hard-coded budget would encode the current
 * ordering and break the moment it changed, which would make the assertion a
 * schedule detector rather than a bound. What is under test is that the excursion
 * is *finite and self-correcting*, not that it equals any particular figure.
 */
const CLOCK_TRACKING_MARGIN_MS = 250;

/**
 * Absolute ceiling on the derived tracking budget.
 *
 * Guards the derivation itself: however many timestamps were drawn, an allocator
 * that had genuinely run away from real time would exceed this, so the assertion
 * cannot be satisfied merely by having caused a large excursion.
 */
const CLOCK_TRACKING_CEILING_MS = 3000;

/**
 * Upper bound on a single HTTP request, applied by {@link request} to every call.
 *
 * `fetch` has no default timeout, so an unbounded call against a stalled handler or
 * a socket that is never answered waits forever: the run hangs instead of failing,
 * and a product defect becomes a stalled run with no diagnosis. Ten seconds is
 * orders of magnitude beyond the sub-millisecond work this endpoint performs, so the
 * bound can only ever be reached by a real fault.
 */
const REQUEST_TIMEOUT_MS = 10000;

/**
 * Upper bound on the wait for a spawned `server.js` to announce its bound address.
 *
 * Binding a loopback socket is immediate, so this can only expire if the entry point
 * failed to start or failed to log — both of which must be reported as failures with
 * the child's own output attached, never as a hang.
 */
const STARTUP_TIMEOUT_MS = 15000;

/**
 * Upper bound on the wait for a signalled `server.js` to exit.
 *
 * Deliberately just under `server.js`'s own five-second shutdown grace timer, so a
 * shutdown that only completes because that backstop fired — rather than because the
 * listener closed promptly — fails this suite instead of passing it quietly.
 */
const SHUTDOWN_TIMEOUT_MS = 4000;

/** Poll interval used while waiting for a released port to start refusing connections. */
const PORT_POLL_INTERVAL_MS = 20;

/**
 * The hostile serving document Group D injects.
 *
 * Two of its four members are deliberately legitimate overrides and two are
 * attempts to redefine a frozen constant. That mixture is what makes the group
 * conclusive: if the injection silently failed, `host` and `port` would come back
 * as the shipped defaults and the group would fail rather than pass while
 * asserting nothing. The port is never bound by this suite — it is only ever read
 * back out of the resolved configuration.
 */
const HOSTILE_SERVING_CONFIG = Object.freeze({
  host: LOOPBACK,
  port: 3210,
  path: '/liveness',
  status: 'DOWN',
});

/*
 * ---------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------
 */

/**
 * Wait for a fixed number of milliseconds.
 *
 * A **lifecycle** wait and nothing else: it is used only to space out polls of a
 * port that is being released and to bound a wait on a child process. No assertion
 * in this suite ever pauses to manufacture a difference between two timestamps —
 * freshness is asserted between immediately consecutive calls, because the module
 * allocates each instant to be strictly later than the last.
 *
 * Uses the global `setTimeout`, whose timer is cleared when it fires, so nothing is
 * left pending that could keep the process alive after the suite finishes.
 *
 * @param {number} milliseconds How long to wait.
 * @returns {Promise<void>} Resolved once the delay has elapsed.
 */
function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Read the wall clock directly, bypassing the module's timestamp allocator.
 *
 * Named rather than inlined so the contrast in the tracking assertion is explicit:
 * one side of that comparison must come from a source the allocator cannot
 * influence, or the assertion would compare the allocator with itself and hold
 * vacuously.
 *
 * @returns {number} Milliseconds since the epoch, as the platform reports them.
 */
function wallClockMs() {
  return Date.now();
}

/**
 * Build the environment for a child process from the inherited one plus overrides.
 *
 * A value of `null` **removes** the variable rather than setting it to something,
 * which is the only way to assert what happens when an override is genuinely unset:
 * an empty string is a different case — it is a set-but-blank value — and the two
 * must be distinguishable, because `HOST=''` and no `HOST` at all take different
 * routes through the resolver even though they resolve to the same answer.
 *
 * Layering over the inherited environment rather than replacing it keeps the child
 * able to resolve its own runtime, while every variable the assertions depend on is
 * stated explicitly so the result never reports on the shell that launched the run.
 *
 * @param {Object<string, string|null>} overrides Variables to set, or to delete when `null`.
 * @returns {Object<string, string>} The child's environment.
 */
function childEnvironment(overrides = {}) {
  const environment = { ...process.env };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) {
      delete environment[name];
    } else {
      environment[name] = value;
    }
  }
  return environment;
}

/**
 * Perform one HTTP request with a mandatory upper bound on how long it may take.
 *
 * Every socket request in this suite goes through here. `fetch` has no default
 * timeout, so an unbounded call is an unbounded wait: a handler that never answers
 * would stall `node --test` indefinitely, reporting a hang rather than a failure.
 * `AbortSignal.timeout` converts that into a deterministic failure,
 * and the abort is translated into a message that names the method, the URL and the
 * bound, so the log says what timed out rather than only that something did.
 *
 * The caller's options are preserved verbatim — method, headers, body — and a caller
 * that supplies its own `signal` keeps it: the two signals are composed with
 * `AbortSignal.any`, so a caller-driven abort and the timeout both still work.
 *
 * @param {string} url Absolute request URL.
 * @param {RequestInit} [options] Standard `fetch` options; `signal` is composed, not replaced.
 * @param {number} [timeoutMs] Upper bound in milliseconds.
 * @returns {Promise<Response>} The response, or a rejection naming the request that failed.
 */
async function request(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const method = options.method || 'GET';
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;

  try {
    return await fetch(url, { ...options, signal });
  } catch (error) {
    if (deadline.aborted) {
      throw new Error(`${method} ${url} did not complete within ${timeoutMs}ms`, { cause: error });
    }
    throw new Error(`${method} ${url} failed: ${error.message}`, { cause: error });
  }
}

/**
 * Run a Node child process and return its raw result.
 *
 * Standard output and standard error are captured as `Buffer`s — `encoding` is
 * deliberately not set — because both the byte-length assertion and the md5
 * digest must be computed over the bytes that actually crossed the pipe, not over
 * a decoded string. `cwd` is pinned to this directory and every script path is
 * absolute, so the result is identical however the suite was invoked.
 *
 * `process.execPath` is the interpreter currently running the suite, so the child
 * is guaranteed to be the same Node build rather than whatever `node` happens to
 * resolve to on `PATH`.
 */
function runNode(args, environmentOverrides = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: __dirname,
    timeout: CHILD_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnvironment(environmentOverrides),
  });

  // A spawn that never started (a missing executable, an exceeded timeout) yields
  // an `error` and null streams. Surfacing it here turns an obscure downstream
  // "cannot read length of null" into a message that names the real cause.
  assert.strictEqual(
    result.error,
    undefined,
    `spawning ${process.execPath} ${args.join(' ')} failed: ${result.error && result.error.message}`,
  );
  assert.strictEqual(result.signal, null, 'the child process must exit normally, never on a signal');

  return result;
}

/**
 * Hex md5 digest of a buffer.
 */
function md5(buffer) {
  return createHash('md5').update(buffer).digest('hex');
}

/** Workspaces created by {@link buildTierCopy}, removed after the suite. */
const temporaryWorkspaces = [];

/**
 * Materialize an isolated copy of this tier whose two configuration sources are in
 * a chosen state, and return the copied module's path.
 *
 * A copy is necessary rather than convenient. `health.js` anchors both sources to
 * `__dirname`, which is exactly right for a server started from an arbitrary
 * directory, and it means the only way to exercise a missing or malformed source
 * is to place the module somewhere else. Mutating the repository's own
 * `package.json` or `config/health.json` would be unacceptable: a crashed run
 * would leave the tier broken, and a parallel test would see the mutation.
 *
 * @param {string} label Directory name, so a failure names the case it came from.
 * @param {string|symbol|null} identity Manifest content, {@link AS_DIRECTORY}, or
 *   `null` to omit the file entirely.
 * @param {string|symbol|null} serving Serving-configuration content, under the
 *   same three conventions.
 * @returns {string} Absolute path to the copied `health.js`.
 */
function buildTierCopy(label, identity, serving) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `l1-health-${label}-`));
  temporaryWorkspaces.push(root);
  fs.copyFileSync(HEALTH_PATH_ON_DISK, path.join(root, 'health.js'));
  fs.copyFileSync(SERVER_PATH, path.join(root, 'server.js'));

  const manifestPath = path.join(root, IDENTITY_MANIFEST_NAME);
  if (identity === AS_DIRECTORY) {
    fs.mkdirSync(manifestPath);
  } else if (identity !== null) {
    fs.writeFileSync(manifestPath, identity);
  }

  const servingPath = path.join(root, SERVING_CONFIG_RELATIVE);
  if (serving === AS_DIRECTORY) {
    fs.mkdirSync(servingPath, { recursive: true });
  } else if (serving !== null) {
    fs.mkdirSync(path.dirname(servingPath), { recursive: true });
    fs.writeFileSync(servingPath, serving);
  }

  return path.join(root, 'health.js');
}

/**
 * Load a copied `health.js` in a child process and report its diagnostics surface.
 *
 * The child is the whole point: configuration resolves once, at module load, so
 * mutating anything in this already-loaded process would prove nothing. It also
 * lets every call assert the byte-silence requirement — that requiring the module
 * writes to neither stream — which an in-process load could not observe.
 *
 * @param {string} modulePath Absolute path to a copied `health.js`.
 * @param {Object<string, string>} [environmentOverrides] Layered environment.
 * @returns {{degradations: string[], line: string|null, values: Object<string, unknown>,
 *   sources: Object<string, string>, conflicts: Array<Object>}} The child's reported surface.
 */
function loadDiagnostics(modulePath, environmentOverrides = {}) {
  const expression =
    'const h = require(process.argv[1]);' +
    'process.stdout.write(JSON.stringify({' +
    'degradations: h.configDegradations,' +
    'frozen: Object.isFrozen(h.configDegradations),' +
    'line: h.describeConfigurationDegradation(),' +
    'reported: h.reportedHandlerFailures(),' +
    'values: h.config,' +
    'sources: h.configSources,' +
    'conflicts: h.frozenValueConflicts,' +
    'status: h.STATUS_UP,' +
    'payloadStatus: h.buildHealthPayload().status,' +
    'payloadKeys: Object.keys(h.buildHealthPayload()),' +
    '}));';
  const result = runNode(['-e', expression, modulePath], environmentOverrides);

  assert.strictEqual(
    result.status,
    0,
    `loading ${modulePath} must succeed; stderr was ${result.stderr.toString('utf8')}`,
  );
  assert.strictEqual(
    result.stderr.length,
    0,
    'requiring health.js must write nothing to stderr, however degraded its configuration is — ' +
      `got ${JSON.stringify(result.stderr.toString('utf8'))}`,
  );

  return JSON.parse(result.stdout.toString('utf8'));
}

/**
 * Assert that a captured diagnostic discloses nothing it should not.
 *
 * @param {string} text Captured output.
 * @param {string} context Description used in the failure message.
 * @returns {void}
 */
function assertNoDisclosure(text, context) {
  for (const forbidden of FORBIDDEN_IN_DIAGNOSTICS) {
    assert.ok(
      !text.includes(forbidden),
      `${context} must not disclose ${JSON.stringify(forbidden)}; got ${JSON.stringify(text)}`,
    );
  }
  // A path separator is the general form of the specific paths above: catching it
  // fails the test for a filesystem path nobody thought to enumerate.
  assert.ok(
    !text.includes(path.sep) || text.includes('http://'),
    `${context} must not disclose a filesystem path; got ${JSON.stringify(text)}`,
  );
  for (const character of text) {
    const code = character.codePointAt(0);
    assert.ok(
      character === '\n' || code >= 0x20,
      `${context} must contain no control character; got ${JSON.stringify(text)}`,
    );
  }
}

/**
 * Provoke handler failures inside a fresh child and return what it emitted.
 *
 * `handleRequest` is driven directly with a response double rather than over a
 * socket, because the failures under test are ones a real socket cannot be made to
 * produce on demand: a `TypeError` from a defect in the serialization path has no
 * network equivalent. The double records every call, so the assertions can prove
 * which status was written — and, critically, which was not.
 *
 * @param {string} scenario Name of the scenario the child should run.
 * @returns {{stdout: Object<string, unknown>, stderrLines: string[], raw: string}}
 *   The child's parsed report and its captured diagnostics.
 */
function provokeHandlerFailures(scenario) {
  const source = `
    const health = require(${JSON.stringify(HEALTH_PATH_ON_DISK)});
    const SECRET = 'SENSITIVE token=abcdef12345 /etc/shadow';
    const fail = (name, code) => {
      const error = new Error(SECRET);
      if (name) { error.name = name; }
      if (code) { error.code = code; }
      return error;
    };
    function makeRes(failWith, headersSentAfterThrow) {
      return {
        calls: [], headersSent: false, writableEnded: false, destroyed: false,
        writeHead(status, headers) {
          this.calls.push({ call: 'writeHead', status, headers: headers || null });
          if (failWith) { this.headersSent = Boolean(headersSentAfterThrow); throw failWith; }
          this.headersSent = true;
        },
        end(body) { this.calls.push({ call: 'end', hasBody: body !== undefined, body: body === undefined ? null : String(body) }); this.writableEnded = true; },
        destroy() { this.calls.push({ call: 'destroy' }); this.destroyed = true; },
      };
    }
    const get = (res) => health.handleRequest({ method: 'GET', url: ${JSON.stringify(HEALTH_PATH)} }, res);
    const report = {};
    const scenario = ${JSON.stringify(scenario)};

    if (scenario === 'expected-disconnects') {
      report.cases = [];
      for (const code of ['EPIPE', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END', 'ERR_STREAM_ALREADY_FINISHED']) {
        const res = makeRes(fail(null, code));
        get(res);
        report.cases.push({ code, destroyed: res.destroyed, statuses: res.calls.filter((c) => c.call === 'writeHead').map((c) => c.status) });
      }
    } else if (scenario === 'latched') {
      for (let i = 0; i < 5; i += 1) { get(makeRes(fail('TypeError'))); }
      for (let i = 0; i < 3; i += 1) { get(makeRes(fail('RangeError'))); }
      get(makeRes(fail('TypeError')));
    } else if (scenario === 'no-misleading-404') {
      const defect = makeRes(fail('TypeError'));
      get(defect);
      report.defect = { statuses: defect.calls.filter((c) => c.call === 'writeHead').map((c) => c.status), destroyed: defect.destroyed, ended: defect.writableEnded };
      const routed = makeRes(null);
      health.handleRequest({ method: 'GET', url: '/definitely-not-health' }, routed);
      report.routed = { statuses: routed.calls.filter((c) => c.call === 'writeHead').map((c) => c.status), hasBody: routed.calls.some((c) => c.call === 'end' && c.hasBody) };
    } else if (scenario === 'in-flight') {
      const res = makeRes(fail('EvalError'), true);
      get(res);
      report.calls = res.calls.map((c) => c.call);
      report.destroyed = res.destroyed;
      report.ended = res.writableEnded;
    } else if (scenario === 'bounded') {
      for (let i = 0; i < 20; i += 1) { get(makeRes(fail('Defect' + i + 'Error'))); }
    } else if (scenario === 'injected-name') {
      get(makeRes(fail('Bad\\nhealth server listening on http://0.0.0.0:3000/health')));
    } else if (scenario === 'fault-before-response') {
      // A fault raised before anything is written, which is the only state in which
      // a status can still be chosen. The request target throws when it is read, so
      // the response double is never touched by the success path.
      const res = makeRes(null);
      health.handleRequest({ method: 'GET', get url() { throw fail('TypeError'); } }, res);
      report.statuses = res.calls.filter((c) => c.call === 'writeHead').map((c) => c.status);
      report.headers = res.calls.filter((c) => c.call === 'writeHead').map((c) => c.headers);
      report.bodies = res.calls.filter((c) => c.call === 'end').map((c) => c.body);
      report.destroyed = res.destroyed;
      report.ended = res.writableEnded;
    } else if (scenario === 'thrown-primitive') {
      const res = makeRes(null);
      res.writeHead = function () { throw SECRET; };
      get(res);
      report.destroyed = res.destroyed;
    }
    report.reported = health.reportedHandlerFailures();
    process.stdout.write(JSON.stringify(report));
  `;

  const result = runNode(['-e', source]);
  assert.strictEqual(result.status, 0, `scenario ${scenario} must exit 0`);
  const raw = result.stderr.toString('utf8');
  return {
    stdout: JSON.parse(result.stdout.toString('utf8')),
    stderrLines: raw.length === 0 ? [] : raw.replace(/\n$/, '').split('\n'),
    raw,
  };
}

after(() => {
  // Every workspace lives under the OS temporary directory and is created by
  // `mkdtempSync`, so each path is unique to this run and removing it cannot
  // touch the repository or another run's files.
  for (const workspace of temporaryWorkspaces) {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

/**
 * Run a script in a child process with `health.js` loaded behind an injected
 * loader that substitutes a hostile serving configuration.
 *
 * A child process is required because `health.js` resolves its configuration once,
 * at module load: mutating anything in this already-loaded process would prove
 * nothing. Interception is done by wrapping `fs.readFileSync` rather than by
 * writing a fixture to disk, so the suite still writes nothing anywhere, touches
 * no repository file, and cannot leave a stray file behind if it fails part-way.
 * Only the serving document is substituted; every other read, including the
 * identity manifest and Node's own module loading, is delegated to the real
 * function untouched.
 *
 * @param {string} body Source executed after the module is loaded, with `health`
 *   bound to the freshly loaded module. It is expected to write a single JSON
 *   document to standard output.
 * @returns {Object<string, unknown>} The parsed JSON the child printed.
 */
function runWithHostileServingConfig(body) {
  const script = `
    const fs = require('node:fs');
    const realReadFileSync = fs.readFileSync;
    const hostile = ${JSON.stringify(JSON.stringify(HOSTILE_SERVING_CONFIG))};
    fs.readFileSync = function (file, options) {
      if (typeof file === 'string' && file.endsWith(${JSON.stringify(SERVING_CONFIG_SUFFIX)})) {
        return hostile;
      }
      return realReadFileSync.call(fs, file, options);
    };
    const health = require(${JSON.stringify(HEALTH_PATH_ON_DISK)});
    ${body}
  `;

  const result = runNode(['-e', script]);
  const stdout = result.stdout.toString('utf8');

  assert.strictEqual(
    result.status,
    0,
    `the injected child must exit 0; stderr was: ${result.stderr.toString('utf8')}`,
  );

  return JSON.parse(stdout);
}

/**
 * Assert that a value satisfies the frozen payload contract in full.
 *
 * Shared by the in-process payload group and the over-the-wire HTTP group so that
 * both hold the response to exactly one definition of correct — a contract
 * asserted two slightly different ways is two contracts.
 */
function assertContractPayload(payload, label) {
  assert.ok(
    payload !== null && typeof payload === 'object' && !Array.isArray(payload),
    `${label}: payload must be a JSON object`,
  );

  // Count and order together: `JSON.stringify` preserves insertion order, and
  // consumers compare the serialized shape, not merely the parsed members.
  assert.deepStrictEqual(
    Object.keys(payload),
    [...PAYLOAD_KEYS],
    `${label}: payload must carry exactly the four contract members in the frozen order`,
  );

  assert.strictEqual(payload.name, TIER_NAME, `${label}: name must be this tier's declared identity`);
  assert.strictEqual(payload.version, TIER_VERSION, `${label}: version must be this tier's declared version`);
  assert.strictEqual(payload.status, STATUS_LITERAL, `${label}: status must be the literal ${STATUS_LITERAL}`);
  assert.match(payload.timestamp, TIMESTAMP_PATTERN, `${label}: timestamp must be RFC 3339 UTC with millisecond precision`);

  return payload;
}

/**
 * Assert the two headers every response in the contract carries, success or error.
 *
 * `Headers#get` is case-insensitive, which is required rather than convenient:
 * header names are case-insensitive on the wire and the three tiers do not agree
 * on the casing they emit.
 */
function assertContractHeaders(response, label) {
  assert.strictEqual(response.headers.get('content-type'), CONTENT_TYPE, `${label}: Content-Type`);
  assert.strictEqual(response.headers.get('cache-control'), CACHE_CONTROL, `${label}: Cache-Control`);
}

/**
 * Start a health server on an ephemeral loopback port.
 *
 * The server comes from `health.createHealthServer()`, which returns it unbound:
 * binding is the caller's business, and that separation is exactly what lets this
 * suite serve the real handler over a real socket without touching port 3000 or
 * needing the long-lived entry point.
 */
function startEphemeralServer() {
  return new Promise((resolve, reject) => {
    const server = health.createHealthServer();

    // A bind failure must reject rather than surface as an unhandled 'error'
    // event, which would crash the test process instead of failing the hook.
    server.once('error', reject);
    server.listen(EPHEMERAL_PORT, LOOPBACK, () => {
      server.removeListener('error', reject);
      const address = server.address();
      const { port } = address;
      resolve({ server, origin: `http://${LOOPBACK}:${port}`, port });
    });
  });
}

/**
 * Close a server and release its port, tolerating a server that never started.
 *
 * `closeAllConnections` is what makes teardown prompt and deterministic: `close`
 * alone stops new connections but waits for existing ones, and the built-in
 * `fetch` keeps its sockets alive for reuse, so without it the close callback
 * would wait on the keep-alive timeout and the process would linger.
 */
function closeServer(server) {
  return new Promise((resolve) => {
    if (server === null || server.listening !== true) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/**
 * Write one request line to a socket verbatim and read the whole response back.
 *
 * This exists because the built-in `fetch` — like any HTTP client — builds its
 * request line from a parsed URL, so asking it for `/%68ealth` or `///health`
 * sends something else and tests nothing. Here the target is written as the bytes
 * it was given, which is the only way to assert what the server does with a
 * spelling rather than what a client does with it.
 *
 * `Connection: close` makes reading to end of stream a complete read, and the
 * timeout converts a lost response into a named failure instead of a hung suite.
 *
 * The response is reported four ways because different assertions need different
 * views of it: the parsed status code and the header map for the common case, the
 * verbatim status line for a failure message that names what actually came back,
 * and the complete raw text for the assertions that must prove a header is
 * *absent* — a field a parsed map cannot distinguish from one that was never sent.
 *
 * @param {number} port Loopback port to connect to.
 * @param {string} method Request method, written verbatim.
 * @param {string} target Request target, transmitted exactly as given.
 * @returns {Promise<{statusCode: number, statusLine: string, headers: Map<string, string>, body: string, raw: string}>}
 *   The parsed response, plus its status line and its complete raw text.
 */
function rawRequest(port, method, target) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.connect(port, LOOPBACK, () => {
      socket.write(
        `${method} ${target} HTTP/1.1${CRLF}Host: ${LOOPBACK}:${port}${CRLF}`
          + `Connection: close${CRLF}Content-Length: 0${HEAD_BODY_SEPARATOR}`,
        'ascii',
      );
    });

    socket.setTimeout(RAW_SOCKET_TIMEOUT_MS, () => {
      socket.destroy(new Error(`no response to ${method} ${target} within ${RAW_SOCKET_TIMEOUT_MS} ms`));
    });
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const separatorAt = raw.indexOf(HEAD_BODY_SEPARATOR);
      const head = separatorAt < 0 ? raw : raw.slice(0, separatorAt);
      const body = separatorAt < 0 ? '' : raw.slice(separatorAt + HEAD_BODY_SEPARATOR.length);
      const [statusLine, ...fields] = head.split(CRLF);
      const headers = new Map();

      for (const field of fields) {
        const colonAt = field.indexOf(':');
        if (colonAt > 0) {
          headers.set(field.slice(0, colonAt).trim().toLowerCase(), field.slice(colonAt + 1).trim());
        }
      }

      resolve({ statusCode: Number(statusLine.split(' ')[1]), statusLine, headers, body, raw });
    });
  });
}

/**
 * Bind a throwaway TCP listener on an ephemeral loopback port and report the port.
 *
 * Used by the start-up-failure test to occupy a port that is provably in use without
 * guessing a number, and by the released-port assertion as the counter-example. It is
 * a bare `net` server rather than an HTTP one because nothing ever speaks to it: its
 * only job is to hold the port.
 *
 * @returns {Promise<{server: import('node:net').Server, port: number}>} The listener and its port.
 */
function occupyEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(EPHEMERAL_PORT, LOOPBACK, () => {
      server.removeListener('error', reject);
      resolve({ server, port: server.address().port });
    });
  });
}

/**
 * Reserve a concrete free loopback port number and release it again.
 *
 * A resolved configuration port of `0` is rejected at every tier — an endpoint on an
 * operating-system-assigned port cannot be addressed by a `HEALTHCHECK`, a workflow
 * probe or an orchestrator — so a test that needs a *child* to bind a listener it can
 * then reach must supply a real number. Asking the operating system for one and
 * handing it back is how that number is obtained without hardcoding a guess that
 * could collide with something already running on the host.
 *
 * The listener is closed before the number is returned, so the caller receives a port
 * that is free rather than one this process is holding.
 *
 * @returns {Promise<number>} A port number that was free a moment ago.
 */
async function reserveFreePort() {
  const { server, port } = await occupyEphemeralPort();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Attempt one TCP connection and report how it ended.
 *
 * Resolves with `'connected'` when the port accepts, or with the error code when it
 * does not (`ECONNREFUSED` once a listener has gone). The socket is destroyed either
 * way, so nothing is left half-open, and the attempt is bounded so a filtered port
 * cannot turn the probe into a wait.
 *
 * @param {number} port TCP port on the loopback interface.
 * @param {number} [timeoutMs] Upper bound for the attempt.
 * @returns {Promise<string>} `'connected'`, an errno string, or `'ETIMEDOUT'`.
 */
function probeTcpPort(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: LOOPBACK });
    const finish = (outcome) => {
      socket.destroy();
      resolve(outcome);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish('connected'));
    socket.once('timeout', () => finish('ETIMEDOUT'));
    socket.once('error', (error) => finish(error.code || error.message));
  });
}

/**
 * Wait until a port stops accepting connections, so "the listener was released" is
 * asserted rather than assumed.
 *
 * Polling instead of sleeping keeps the check both prompt and bounded: it returns as
 * soon as the port refuses, and gives up with the last observed outcome rather than
 * waiting indefinitely if the port stays bound.
 *
 * @param {number} port TCP port that must become free.
 * @param {number} [timeoutMs] Upper bound on the wait.
 * @returns {Promise<string>} The final outcome observed by {@link probeTcpPort}.
 */
async function waitForPortRelease(port, timeoutMs = SHUTDOWN_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let outcome = await probeTcpPort(port);

  while (outcome === 'connected' && Date.now() < deadline) {
    await delay(PORT_POLL_INTERVAL_MS);
    outcome = await probeTcpPort(port);
  }

  return outcome;
}

/**
 * Build an isolated copy of the tier's runtime layout inside a private temporary
 * directory, so configuration-source failure can be exercised for real.
 *
 * `health.js` resolves its identity manifest and serving configuration from its own
 * `__dirname`, which is precisely what makes this technique work: a copy placed in an
 * empty directory reads `package.json` and `config/health.json` from *that*
 * directory, so "the file is missing" and "the file is malformed" become real states
 * of real files instead of simulated ones. Nothing in the repository is created,
 * modified, moved or deleted, and the directory lives under the operating system's
 * temporary root, never inside the working tree.
 *
 * @param {Object<string, string>} files Relative path → exact file contents to write.
 *   Omitting a path leaves that source absent, which is itself a case under test.
 * @returns {string} Absolute path to the temporary directory, for cleanup by the caller.
 */
function createIsolatedTier(files = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blitzy-health-isolated-'));
  fs.copyFileSync(HEALTH_PATH_ON_DISK, path.join(directory, 'health.js'));

  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(directory, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }

  return directory;
}

/**
 * Load an isolated `health.js` in a fresh child process and report what it resolved.
 *
 * A child process is required rather than convenient: configuration is resolved once,
 * at module load, and `require`'s cache means a second load in this process would
 * return the already-resolved module. The child prints its effective configuration
 * and one freshly built payload, so both the resolver and the payload it feeds are
 * observed from the same load.
 *
 * @param {string} directory An isolated tier built by {@link createIsolatedTier}.
 * @param {Object<string, string|null>} [environmentOverrides] Passed to {@link childEnvironment}.
 * @returns {{config: Object<string, unknown>, payload: Object<string, unknown>}} What the child resolved.
 */
function loadIsolatedTier(directory, environmentOverrides = {}) {
  const script =
    `const health = require(${JSON.stringify(path.join(directory, 'health.js'))});` +
    'process.stdout.write(JSON.stringify({ config: health.config, sources: health.configSources,' +
    ' conflicts: health.frozenValueConflicts, payload: health.buildHealthPayload() }));';

  // HOST and PORT are cleared unless a case sets them, so the two values that do
  // accept an environment override are determined by the case rather than inherited
  // from whatever launched the suite.
  const result = runNode(['-e', script], { HOST: null, PORT: null, ...environmentOverrides });

  assert.strictEqual(
    result.status,
    0,
    `loading an isolated health.js must succeed; stderr was: ${result.stderr.toString('utf8')}`,
  );
  assert.strictEqual(
    result.stderr.length,
    0,
    'resolving configuration must stay silent, even when every source is unusable',
  );

  return JSON.parse(result.stdout.toString('utf8'));
}

/**
 * Start `server.js` as a real child process and return handles for driving it.
 *
 * This is the only honest way to test that file: it is an entry point, not a module —
 * it calls `start()` at load and exports nothing — so requiring it would bind a
 * listener inside the test process and leave no way to observe signals, exit codes or
 * the start-up line. Both streams are accumulated as they arrive so that a diagnostic
 * printed before an early exit is still available to the assertions.
 *
 * @param {Object<string, string|null>} environmentOverrides Passed to {@link childEnvironment}.
 * @returns {{child: import('node:child_process').ChildProcess, stdout: () => string,
 *   stderr: () => string, waitForStartup: () => Promise<{host: string, port: number, line: string}>,
 *   waitForExit: (timeoutMs?: number) => Promise<{code: number|null, signal: string|null, elapsedMs: number}>,
 *   stop: () => Promise<void>}} Handles for the running child.
 */
function startServerProcess(environmentOverrides = {}) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnvironment(environmentOverrides),
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  /** @type {{code: number|null, signal: string|null, elapsedMs: number}|null} */
  let exitResult = null;
  const startedAt = Date.now();
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exitResult = { code, signal, elapsedMs: Date.now() - startedAt };
      resolve(exitResult);
    });
  });

  /**
   * Resolve once the child has announced the address it actually bound.
   *
   * The announced port is the one the assertions probe: with `PORT=0` the requested
   * port is `0` and only the announced value can be dialled, which is exactly the
   * property that makes the log line operationally useful.
   */
  const waitForStartup = async () => {
    const pattern = /^health server listening on http:\/\/(\[[^\]]+\]|[^:\/\s]+):(\d+)(\/\S*)?$/m;
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;

    for (;;) {
      const match = pattern.exec(stdout);
      if (match !== null) {
        return { host: match[1], port: Number(match[2]), line: match[0] };
      }
      if (exitResult !== null) {
        throw new Error(
          `server.js exited with code ${exitResult.code} before announcing a bound address. ` +
            `stdout: ${JSON.stringify(stdout)} stderr: ${JSON.stringify(stderr)}`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `server.js did not announce a bound address within ${STARTUP_TIMEOUT_MS}ms. ` +
            `stdout: ${JSON.stringify(stdout)} stderr: ${JSON.stringify(stderr)}`,
        );
      }
      await delay(PORT_POLL_INTERVAL_MS);
    }
  };

  /** Resolve with the exit result, or reject once the bound elapses. */
  const waitForExit = (timeoutMs = SHUTDOWN_TIMEOUT_MS) =>
    Promise.race([
      exited,
      delay(timeoutMs).then(() => {
        if (exitResult !== null) {
          return exitResult;
        }
        throw new Error(
          `server.js did not exit within ${timeoutMs}ms. ` +
            `stdout: ${JSON.stringify(stdout)} stderr: ${JSON.stringify(stderr)}`,
        );
      }),
    ]);

  /**
   * Unconditional teardown for an `after` hook: escalate to `SIGKILL` only if the
   * child is still alive, so a failing assertion can never leave a process behind
   * holding a port.
   */
  const stop = async () => {
    if (exitResult !== null) {
      return;
    }
    child.kill('SIGKILL');
    await exited;
  };

  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    waitForStartup,
    waitForExit,
    stop,
  };
}

/**
 * Build a minimal `ServerResponse` stand-in that records what a handler wrote.
 *
 * The defensive-path group calls {@link health.handleRequest} directly, because the
 * paths it covers cannot be reached over a socket: Node's HTTP parser rejects a
 * malformed request line before any handler runs, and a response object whose write
 * fails is a socket-level fault that cannot be provoked deterministically from a
 * client. This is a recorder rather than a mock — no expectations are pre-programmed
 * and nothing is asserted about how it was called except through the values it
 * captured — and `health.js` documents exactly this shape of double as supported.
 *
 * @param {{failWriteHeadTimes?: number, failEndTimes?: number, markEndedOnFailure?: boolean}} [behavior]
 *   How many leading `writeHead` and `end` calls must throw, simulating a socket
 *   that died mid-response, and whether a failing `end` still marks the response
 *   as ended — the difference between "the body was cut short" and "the response
 *   completed and then the socket failed", which the recovery path distinguishes.
 * @returns {{res: Object<string, unknown>, recorded: Object<string, unknown>}} The double and its record.
 */
function createResponseDouble(behavior = {}) {
  const {
    failWriteHeadTimes = 0,
    failEndTimes = 0,
    markEndedOnFailure = false,
    // The simulated fault is a socket that died underneath the write, which is a
    // routine peer disconnect rather than a defect in this process. Tagging it with
    // one of the codes `health.js` recognises as such is what makes these
    // assertions exercise the silent recovery path: a defect would additionally
    // emit a diagnostic, and this group asserts that none is emitted.
    failureCode = 'ERR_STREAM_DESTROYED',
  } = behavior;
  const recorded = {
    writeHeadCalls: 0,
    statusCode: null,
    headers: null,
    endCalls: 0,
    body: null,
    destroyed: false,
  };

  const res = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,

    writeHead(statusCode, headers) {
      recorded.writeHeadCalls += 1;
      if (recorded.writeHeadCalls <= failWriteHeadTimes) {
        const failure = new Error('simulated socket failure while writing the status line');
        failure.code = failureCode;
        throw failure;
      }
      recorded.statusCode = statusCode;
      recorded.headers = headers;
      res.headersSent = true;
      return res;
    },

    end(chunk) {
      recorded.endCalls += 1;
      if (recorded.endCalls <= failEndTimes) {
        if (markEndedOnFailure) {
          res.writableEnded = true;
        }
        const failure = new Error('simulated socket failure while writing the body');
        failure.code = markEndedOnFailure ? 'ERR_STREAM_ALREADY_FINISHED' : failureCode;
        throw failure;
      }
      recorded.body = chunk === undefined ? null : chunk;
      res.writableEnded = true;
      return res;
    },

    destroy() {
      recorded.destroyed = true;
      res.destroyed = true;
      return res;
    },
  };

  return { res, recorded };
}

/*
 * ---------------------------------------------------------------------------
 * Groups A and B — the preserved program and its new export surface
 * ---------------------------------------------------------------------------
 */

describe('index.js — preserved arithmetic and the new export surface', () => {
  test('exposes exactly one member, the add function', () => {
    const moduleSurface = require('./index.js');

    // Asserting the whole key list, not merely that `add` exists, pins the surface
    // closed: the guarded emission must stay a side effect of direct invocation and
    // never leak out as an export.
    assert.deepStrictEqual(Object.keys(moduleSurface), ['add']);
    assert.strictEqual(typeof add, 'function');
    assert.strictEqual(add, moduleSurface.add, 'the destructured and property forms must be the same function');
  });

  test('add(5, 7) returns 12 — the canonical preserved result', () => {
    assert.strictEqual(add(5, 7), 12);
  });

  test('add performs plain numeric addition for the operands the program uses', () => {
    // Deliberately limited to plain `+` semantics over numbers. `add`'s body is
    // untouched by this feature and it never promised argument validation, a
    // thrown error or any NaN contract, so asserting one here would invent a
    // requirement and freeze the wrong thing.
    assert.strictEqual(add(0, 0), 0);
    assert.strictEqual(add(-4, 4), 0);
    assert.strictEqual(add(-5, -7), -12);
    assert.strictEqual(add(1.5, 2.25), 3.75);
  });
});

// Group B — non-regression, measured in a real child process

describe('index.js — legacy invocation preserved, import free of side effects', () => {
  test('requiring index.js writes zero bytes to stdout and stderr', () => {
    // The require target is embedded as a JSON string literal so the absolute
    // path is escaped correctly and the child never depends on its own CWD.
    const result = runNode(['-e', `require(${JSON.stringify(INDEX_PATH)});`]);

    assert.strictEqual(result.status, 0, 'a bare require must exit cleanly');
    assert.strictEqual(result.stdout.length, 0, 'a bare require must print nothing — the main-module guard suppresses the emission');
    assert.strictEqual(result.stderr.length, 0, 'a bare require must not warn or throw');
  });

  test('requiring index.js in a fresh process still yields a callable add', () => {
    // Proves the export surface is a property of the module itself rather than an
    // artifact of this suite's already-populated module cache.
    const expression = `process.stdout.write(String(require(${JSON.stringify(INDEX_PATH)}).add(5, 7)));`;
    const result = runNode(['-e', expression]);

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout.toString('utf8'), '12');
    assert.strictEqual(result.stderr.length, 0);
  });

  test('node index.js still emits the golden five lines and fifteen bytes', () => {
    const result = runNode([INDEX_PATH]);

    assert.strictEqual(result.status, 0, 'the program must still exit 0');
    assert.strictEqual(result.stderr.length, 0, 'the program must still write nothing to stderr');
    assert.strictEqual(result.stdout.length, GOLDEN_STDOUT_BYTES, 'stdout must still be exactly fifteen bytes');
    assert.strictEqual(result.stdout.toString('utf8'), GOLDEN_STDOUT);
    assert.strictEqual(
      result.stdout.toString('utf8').split('\n').length - 1,
      GOLDEN_STDOUT_LINES,
      'stdout must still be five newline-terminated lines',
    );
  });

  test('node index.js stdout still digests to the pinned md5 fingerprint', () => {
    // The mechanical enforcement of "preserve the existing functionality": this
    // digest is the md5 of the standard output of `node index.js` and nothing
    // else, and it is asserted over the raw bytes.
    const result = runNode([INDEX_PATH]);

    assert.strictEqual(result.status, 0);
    assert.strictEqual(md5(result.stdout), GOLDEN_STDOUT_MD5);
  });
});

// Group C.1 — the payload contract, asserted without opening a socket

describe('health.js — the /health payload contract', () => {
  test('exposes the documented public surface', () => {
    assert.strictEqual(typeof health.buildHealthPayload, 'function');
    assert.strictEqual(typeof health.currentTimestamp, 'function');
    assert.strictEqual(typeof health.formatTimestamp, 'function');
    assert.strictEqual(typeof health.handleRequest, 'function');
    assert.strictEqual(typeof health.createHealthServer, 'function');
    assert.strictEqual(typeof health.config, 'object');
    assert.notStrictEqual(health.config, null);
  });

  test('the payload carries exactly four members in the frozen order', () => {
    const payload = health.buildHealthPayload();

    assert.deepStrictEqual(Object.keys(payload), [...PAYLOAD_KEYS]);
    assert.strictEqual(Object.keys(payload).length, 4);
    assertContractPayload(payload, 'buildHealthPayload');
  });

  test('name and version are single-sourced from the identity manifest', () => {
    const payload = health.buildHealthPayload();

    // Asserting against both the literal and `package.json` proves two separate
    // things: that the value is the one the contract mandates, and that it is
    // *read* from the manifest rather than duplicated in the handler where the two
    // copies could drift.
    assert.strictEqual(payload.name, TIER_NAME);
    assert.strictEqual(payload.name, manifest.name);
    assert.strictEqual(payload.version, TIER_VERSION);
    assert.strictEqual(payload.version, manifest.version);
  });

  test('status is resolved from the declared source and validated against the contract', () => {
    const payload = health.buildHealthPayload();

    // The first assertion is the contract: the reported value is the contract's
    // literal. The second proves the payload serves the *resolved* value rather
    // than a second copy written at the point of use, so there is one place in the
    // tier where the value is decided.
    assert.strictEqual(payload.status, STATUS_LITERAL);
    assert.strictEqual(payload.status, health.config.status, 'the payload must serve the resolved value');
    assert.strictEqual(health.config.status, health.STATUS_UP, 'the resolved value must be the contract literal');

    // And the chain is real, not decorative: `config/health.json` declares
    // `status`, that declaration is what was adopted, and the provenance says so.
    // A dead declaration would report `fallback` here even though the value looked
    // right, which is the failure this assertion exists to catch.
    assert.strictEqual(
      health.configSources.status,
      'file',
      'the shipped status declaration must be the value that was adopted',
    );

    // What makes adopting it safe is the validation, not the source: the contract
    // admits exactly one legal declaration, so `config.status` cannot become
    // anything else. A deployment that edited its configuration file could
    // otherwise publish "DOWN" — or any other string — from a process that is
    // running perfectly well, and two tiers of this composition could disagree
    // about the one value that matters. The frozen-contract group below proves the
    // refusal end to end.

    // The configuration file still *declares* the literal, for documentation of
    // the contract it serves, and this pins the declaration to the constant so the
    // two can never drift.
    assert.strictEqual(servingConfig.status, STATUS_LITERAL, 'the declared status must match the constant');
    assert.strictEqual(health.STATUS_UP, servingConfig.status);
  });

  test('the serving file declares status, and an illegal declaration is powerless', () => {
    // Both halves matter. The declared shape must still carry `status`, because the
    // contract quotes it and a consumer reading the file expects it; and only a
    // declaration equal to the contract's literal may ever be adopted.
    assert.strictEqual(health.declaredStatus(servingConfig), STATUS_LITERAL);

    // A document declaring anything else is read faithfully...
    assert.strictEqual(health.declaredStatus({ status: 'DOWN' }), 'DOWN');
    assert.strictEqual(health.declaredStatus({ status: '  MAINTENANCE  ' }), 'MAINTENANCE');
    // ...and an absent, blank or non-string declaration reports nothing at all.
    assert.strictEqual(health.declaredStatus({}), null);
    assert.strictEqual(health.declaredStatus({ status: '   ' }), null);
    assert.strictEqual(health.declaredStatus({ status: 7 }), null);
    assert.strictEqual(health.declaredStatus(null), null);
    assert.strictEqual(health.declaredStatus(undefined), null);

    // ...while what the endpoint reports never moves. Reading a declaration and
    // adopting it are separate steps, and only the second is gated by the contract.
    assert.strictEqual(health.buildHealthPayload().status, STATUS_LITERAL);
  });

  test('timestamp is RFC 3339 UTC with millisecond precision and a Z suffix', () => {
    const { timestamp } = health.buildHealthPayload();

    assert.match(timestamp, TIMESTAMP_PATTERN);

    // The pattern alone would accept a syntactically valid but impossible instant
    // such as month 99, so the value is also required to parse.
    assert.ok(Number.isFinite(Date.parse(timestamp)), 'timestamp must be a real instant');
    assert.strictEqual(new Date(timestamp).toISOString(), timestamp, 'timestamp must round-trip unchanged');
  });

  test('the payload serializes compactly, with no insignificant whitespace', () => {
    const serialized = JSON.stringify(health.buildHealthPayload());

    // Byte-shape parity across the three tiers depends on this: Node is compact by
    // default, Python is not, and a consumer that compares shapes rather than
    // parsed members sees the difference.
    assert.ok(!serialized.includes(', '), 'no space may follow a comma');
    assert.ok(!serialized.includes(': '), 'no space may follow a colon');
    assert.ok(!/\s/.test(serialized.replace(/"[^"]*"/g, '')), 'no whitespace may appear outside string values');
    assert.strictEqual(
      serialized,
      `{"name":"${TIER_NAME}","version":"${TIER_VERSION}","timestamp":"${JSON.parse(serialized).timestamp}","status":"${STATUS_LITERAL}"}`,
      'the serialized body must match the canonical byte shape exactly',
    );
  });

  test('two immediately consecutive payloads differ in timestamp and agree on every other member', () => {
    // Deliberately no delay between the two calls. The previous form of this test
    // waited past a millisecond boundary first, which meant it asserted only that
    // the clock had moved — a builder that captured its timestamp once at module
    // load would have failed it, but one that merely read `Date.now()` per call
    // would have passed it while still returning duplicates to two probes landing
    // in the same millisecond. Removing the wait is what makes the assertion test
    // the contract's freshness clause literally: *consecutive* payloads differ,
    // whatever the interval between them.
    const first = health.buildHealthPayload();
    const second = health.buildHealthPayload();

    assertContractPayload(first, 'first payload');
    assertContractPayload(second, 'second payload');

    assert.notStrictEqual(
      second.timestamp,
      first.timestamp,
      'two consecutive payloads must differ in timestamp with no delay between them',
    );
    assert.ok(
      Date.parse(second.timestamp) > Date.parse(first.timestamp),
      'the later call must carry the strictly later instant',
    );

    assert.strictEqual(second.name, first.name);
    assert.strictEqual(second.version, first.version);
    assert.strictEqual(second.status, first.status);
  });

  test('a burst of payloads carries strictly increasing, never-repeating timestamps', () => {
    // A tight loop draws hundreds of samples inside a single millisecond tick, so
    // every value beyond the first is one the wall clock alone could not have
    // distinguished. Uniqueness proves no duplicate is ever handed out; strict
    // ordering proves the values also stay monotonic, so a consumer comparing two
    // responses can rely on the later one carrying the later instant.
    const timestamps = [];
    for (let index = 0; index < BURST_SAMPLE_COUNT; index += 1) {
      timestamps.push(health.buildHealthPayload().timestamp);
    }

    assert.strictEqual(timestamps.length, BURST_SAMPLE_COUNT);
    assert.strictEqual(
      new Set(timestamps).size,
      BURST_SAMPLE_COUNT,
      'every timestamp in a burst must be distinct, however fast the calls arrive',
    );

    for (let index = 1; index < timestamps.length; index += 1) {
      assert.ok(
        timestamps[index] > timestamps[index - 1],
        `timestamp ${index} must be strictly later than its predecessor`,
      );
      assert.match(timestamps[index], TIMESTAMP_PATTERN, `burst sample ${index} must keep the contract format`);
    }
  });

  test('the timestamp still tracks the wall clock and cannot run away from it', () => {
    // The allocator's correction is bounded and self-cancelling: it may sit ahead
    // of real time only while calls arrive faster than the clock ticks, and the
    // moment real time catches up the wall clock wins again. This asserts that
    // bound rather than a fixed figure — the budget is derived from the excursion
    // the sampling itself just caused, plus a margin, under a hard ceiling — so
    // the test measures the property (finite, proportional, self-correcting) and
    // not the order in which the runner happened to execute the suite.
    const before = wallClockMs();
    const samples = [];
    for (let index = 0; index < BURST_SAMPLE_COUNT; index += 1) {
      samples.push(Date.parse(health.currentTimestamp()));
    }
    const after = wallClockMs();

    const excursion = samples[samples.length - 1] - after;
    const budgetMs = Math.min(Math.max(excursion, 0) + CLOCK_TRACKING_MARGIN_MS, CLOCK_TRACKING_CEILING_MS);

    assert.ok(
      samples[0] >= before,
      'the first allocated instant must not predate the wall-clock reading taken before it',
    );
    assert.ok(
      samples[samples.length - 1] <= after + budgetMs,
      `a bounded burst must not run further than ${budgetMs} ms beyond real time`,
    );
    assert.ok(
      excursion < CLOCK_TRACKING_CEILING_MS,
      'the excursion above real time must stay small — a persistent drift would be unbounded',
    );
  });

  test('the exported timestamp helpers render the contract form for any instant', () => {
    // Rendering a chosen instant is what makes the whole-second case assertable
    // deterministically: `.000` is where a formatter that trims insignificant
    // zeros would drop the fraction and silently break the pattern, and waiting
    // for the clock to land on a whole second would make the suite flaky.
    assert.strictEqual(health.formatTimestamp(1000), '1970-01-01T00:00:01.000Z');
    assert.strictEqual(health.formatTimestamp(0), '1970-01-01T00:00:00.000Z');
    assert.strictEqual(health.formatTimestamp(1769000000000), '2026-01-21T12:53:20.000Z');
    assert.strictEqual(health.formatTimestamp(1769000000007), '2026-01-21T12:53:20.007Z');

    for (const instant of [0, 1000, 1769000000000, 1769000000007, 1769000000123]) {
      assert.match(
        health.formatTimestamp(instant),
        TIMESTAMP_PATTERN,
        `formatTimestamp(${instant}) must match the contract pattern`,
      );
    }

    // The allocator feeds the same renderer, so the pattern holds for live values too.
    assert.match(health.currentTimestamp(), TIMESTAMP_PATTERN);
    assert.notStrictEqual(health.currentTimestamp(), health.currentTimestamp());
  });

  test("the declared serving defaults match this tier's frozen assignment", () => {
    // The declaration is asserted, not the effective value: `HOST` and `PORT` are
    // documented runtime overrides, so a set environment variable legitimately
    // changes what the process binds. What must never drift is what the tier
    // declares in its configuration file.
    assert.strictEqual(servingConfig.port, TIER_DEFAULT_PORT);
    assert.strictEqual(servingConfig.host, TIER_DEFAULT_HOST);
    assert.strictEqual(servingConfig.path, HEALTH_PATH);
    assert.strictEqual(health.config.path, HEALTH_PATH, 'the resolved resource path must be the contract path');
    assert.strictEqual(health.config.name, TIER_NAME);
    assert.strictEqual(health.config.version, TIER_VERSION);
    assert.deepStrictEqual(
      Object.keys(health.config).sort(),
      ['host', 'name', 'path', 'port', 'status', 'version'],
      'the resolved configuration carries every served value: identity, bind target, path and status',
    );
    assert.strictEqual(health.status, STATUS_LITERAL, 'the resolved status is exported at the top level');

    // Every one of those six values was read from a declared source rather than
    // written inline at its point of use, and the provenance map says which source.
    // With both files present and valid, no value may report `fallback`.
    assert.deepStrictEqual(
      health.configSources,
      { name: 'file', version: 'file', host: 'file', port: 'file', path: 'file', status: 'file' },
      'with both declared sources present and valid, every value must come from a file',
    );
    assert.ok(Object.isFrozen(health.configSources), 'the provenance map must be immutable');
  });

  test('the identity manifest keeps this tier resolvable as CommonJS with no dependencies', () => {
    // `"type": "module"` would flip the whole tier to ES-module resolution and
    // silently disable the `require.main === module` guard Group B depends on, and
    // any dependency entry would end the composition's zero-third-party posture.
    assert.strictEqual(manifest.type, undefined, 'package.json must not declare the ES-module type field');
    assert.strictEqual(manifest.dependencies, undefined, 'this tier must declare no runtime dependencies');
    assert.strictEqual(manifest.devDependencies, undefined, 'this tier must declare no development dependencies');
    assert.strictEqual(manifest.scripts.test, 'node --test', 'npm test must be the built-in runner with default discovery');
  });
});

/*
 * Group C.2 — the documented configuration precedence
 * These run in child processes because resolution happens once, at module load:
 * changing `process.env` inside this already-loaded process would prove nothing.
 * They are also why the assertions above pin the *declared* defaults rather than
 * the effective ones — exporting `PORT` is a documented feature, not a broken
 * suite. Nothing here binds a socket.
 */

describe('health.js — documented configuration precedence', () => {
  /** Emits the resolved configuration of a freshly loaded module as JSON. */
  const printConfig = `process.stdout.write(JSON.stringify(require(${JSON.stringify(
    path.join(__dirname, 'health.js'),
  )}).config));`;

  test('HOST and PORT override the configuration file, while identity does not budge', () => {
    const result = runNode(['-e', printConfig], { HOST: LOOPBACK, PORT: '3100' });
    const config = JSON.parse(result.stdout.toString('utf8'));

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stderr.length, 0);
    assert.strictEqual(config.port, 3100, 'PORT must take precedence over the configuration file');
    assert.strictEqual(config.host, LOOPBACK, 'HOST must take precedence over the configuration file');

    // Identity is a declared fact of the build, not a runtime setting, so no
    // environment variable may change what the payload claims to be. `path` and
    // `status` are resolved settings, but only the declared *file* may supply them
    // and only when it restates the contract literal, so an environment variable
    // cannot reach them either — there is no `HEALTH_PATH` or `HEALTH_STATUS`
    // variable to set. Group C.3 proves the file cannot move them either.
    assert.strictEqual(config.name, TIER_NAME);
    assert.strictEqual(config.version, TIER_VERSION);
    assert.strictEqual(config.path, HEALTH_PATH, 'no environment variable may move the resource path');
    assert.strictEqual(
      config.status,
      STATUS_LITERAL,
      'no environment variable may change the reported status',
    );
  });

  test('the shipped configuration restates both frozen values, so nothing is rejected', () => {
    // The repository's own configuration must be conflict-free: it declares
    // `path` and `status` so an operator can read the whole shape of what is
    // served in one place, and both declarations restate the frozen literal.
    assert.strictEqual(servingConfig.path, HEALTH_PATH);
    assert.strictEqual(servingConfig.status, STATUS_LITERAL);
    assert.ok(Array.isArray(health.frozenValueConflicts), 'the audit result must be an array');
    assert.deepStrictEqual(
      health.frozenValueConflicts,
      [],
      'the shipped configuration must not attempt to redefine a frozen value',
    );
    assert.ok(Object.isFrozen(health.frozenValueConflicts), 'the audit result must be immutable');
  });

  test('an unusable or empty override falls back to the configured default', () => {
    // A typo in one source must degrade to the next source rather than leave the
    // listener unbindable — a health endpoint that cannot start because of its own
    // configuration is worse than no endpoint at all. An empty value is skipped
    // for the same reason: it is an unset variable, not a deliberate override.
    //
    // Both variables are set explicitly rather than left inherited, so the child's
    // environment is fully determined for the two values asserted here. Leaving
    // either to inheritance would make this test report on the shell that launched
    // it instead of on the resolution chain.
    const result = runNode(['-e', printConfig], { PORT: 'not-a-port', HOST: '' });
    const config = JSON.parse(result.stdout.toString('utf8'));

    assert.strictEqual(result.status, 0);
    assert.strictEqual(config.port, TIER_DEFAULT_PORT, 'an unusable PORT must fall through to config/health.json');
    assert.strictEqual(config.port, servingConfig.port);
    assert.strictEqual(config.host, TIER_DEFAULT_HOST, 'an empty HOST must fall through to config/health.json');
    assert.strictEqual(config.host, servingConfig.host);
  });

  test('a configured port of 0 is rejected, because an assigned port cannot be probed', () => {
    // `0` is a legal argument to `listen`, so it would otherwise resolve cleanly and
    // bind whatever port the operating system handed out. That is precisely wrong for
    // this endpoint: every consumer of it — a fixed-number probe, an orchestrator
    // liveness check — is configured with a port in advance, and cannot discover one
    // chosen at bind time. All three tiers reject it identically, so `0` never
    // becomes a resolved configuration value anywhere in the composition.
    const fromEnvironment = JSON.parse(
      runNode(['-e', printConfig], { PORT: '0', HOST: null }).stdout.toString('utf8'),
    );
    assert.strictEqual(fromEnvironment.port, TIER_DEFAULT_PORT, 'PORT=0 must fall through, not resolve');

    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'blitzy-health-port-zero-'));
    try {
      fs.mkdirSync(path.join(workspace, 'config'));
      fs.copyFileSync(path.join(__dirname, 'health.js'), path.join(workspace, 'health.js'));
      fs.copyFileSync(path.join(__dirname, 'package.json'), path.join(workspace, 'package.json'));
      fs.writeFileSync(
        path.join(workspace, 'config', 'health.json'),
        JSON.stringify({ ...servingConfig, port: 0 }),
      );

      const script = `const h = require(${JSON.stringify(path.join(workspace, 'health.js'))});`
        + 'process.stdout.write(JSON.stringify({ port: h.config.port, source: h.configSources.port }));';
      const fromFile = JSON.parse(runNode(['-e', script], { PORT: null, HOST: null }).stdout.toString('utf8'));

      assert.strictEqual(fromFile.port, TIER_DEFAULT_PORT, 'a declared port of 0 must fall through to the literal');
      assert.strictEqual(fromFile.source, 'fallback', 'and the provenance must say the declaration was not used');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('a configuration file declaring a different status cannot change the payload', () => {
    // The strongest form of the "status cannot be reconfigured" claim: build a whole
    // throwaway copy of this tier whose configuration file declares DOWN, load it in
    // a fresh process, and require the payload to report UP anyway. The chain does
    // read the declaration — that is what makes the file the value's declared source
    // — but it adopts it only when it matches the contract, so a deployment that
    // edits the file cannot make a running process report itself unhealthy.
    //
    // The copy lives in the operating system's temporary directory, never inside
    // this repository, and is removed in the `finally` block whatever happens.
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'blitzy-health-status-'));

    try {
      fs.mkdirSync(path.join(workspace, 'config'));
      fs.copyFileSync(path.join(__dirname, 'health.js'), path.join(workspace, 'health.js'));
      fs.copyFileSync(path.join(__dirname, 'package.json'), path.join(workspace, 'package.json'));
      fs.writeFileSync(
        path.join(workspace, 'config', 'health.json'),
        JSON.stringify({ ...servingConfig, status: TAMPERED_STATUS }),
      );

      const printPayload = `process.stdout.write(JSON.stringify(require(${JSON.stringify(
        path.join(workspace, 'health.js'),
      )}).buildHealthPayload()));`;
      const result = runNode(['-e', printPayload]);

      assert.strictEqual(result.status, 0, 'the tampered copy must still load and serve');
      assert.strictEqual(result.stderr.length, 0);

      const payload = assertContractPayload(JSON.parse(result.stdout.toString('utf8')), 'tampered configuration');
      assert.strictEqual(
        payload.status,
        STATUS_LITERAL,
        `a configuration file declaring ${TAMPERED_STATUS} must not change the reported status`,
      );

      // And the refusal is visible rather than silent: the provenance of a rejected
      // declaration is the fallback, never the file.
      const printSources = `process.stdout.write(JSON.stringify(require(${JSON.stringify(
        path.join(workspace, 'health.js'),
      )}).configSources));`;
      const sources = JSON.parse(runNode(['-e', printSources]).stdout.toString('utf8'));
      assert.strictEqual(sources.status, 'fallback', 'a rejected declaration must not be reported as adopted');
      assert.strictEqual(sources.host, 'file', 'the legitimate members of the same document are still adopted');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * Group D.1 — the two values configuration may declare but not redefine
 *
 * `/health` and `UP` are resolved from the serving document like every other
 * setting, but their declarations are validated against the contract first: only
 * the contract's own literal may be adopted, and a document that names anything
 * else must be rejected rather than honoured. A settable path would move the
 * endpoint away from where a probe addresses it, and a settable status would let a
 * deployment report a value its own behavior does not support. Both failures leave
 * a response that is still syntactically valid, which is what makes them worth
 * asserting rather than assuming.
 *
 * Each test loads the module in a child process behind an injected loader, so the
 * resolution genuinely happens against the hostile document. Each one also asserts
 * that the document's two *legitimate* members took effect, which is what proves
 * the injection worked and stops the group from passing vacuously.
 * ---------------------------------------------------------------------------
 */

describe('health.js — the frozen contract cannot be reconfigured', () => {
  test('a hostile serving document cannot move the resource path or change the status', () => {
    const observed = runWithHostileServingConfig(
      'process.stdout.write(JSON.stringify({ config: health.config, sources: health.configSources,'
        + ' payload: health.buildHealthPayload() }));',
    );

    // Positive control first: without this, every assertion below would also hold
    // for an injection that never took effect.
    assert.strictEqual(
      observed.config.host,
      HOSTILE_SERVING_CONFIG.host,
      'the injected document must actually have been read — host is a documented setting',
    );
    assert.strictEqual(
      observed.config.port,
      HOSTILE_SERVING_CONFIG.port,
      'the injected document must actually have been read — port is a documented setting',
    );

    assert.strictEqual(observed.config.path, HEALTH_PATH, 'the resource path is frozen');
    assert.notStrictEqual(observed.config.path, HOSTILE_SERVING_CONFIG.path);

    // `status` is validated exactly as strictly as `path`, so the resolved setting
    // is the contract's literal even though the document named something else.
    assert.strictEqual(
      observed.config.status,
      STATUS_LITERAL,
      'an illegal status declaration must resolve to the contract literal',
    );
    assert.notStrictEqual(observed.config.status, HOSTILE_SERVING_CONFIG.status);

    // Both refusals are recorded in the provenance rather than hidden behind a
    // value that happens to look right.
    assert.strictEqual(observed.sources.path, 'fallback');
    assert.strictEqual(observed.sources.status, 'fallback');
    assert.strictEqual(observed.sources.host, 'file', 'the document\'s legitimate members are still adopted');
    assert.strictEqual(observed.sources.port, 'file');

    // The payload is what a consumer actually sees, so it is asserted separately
    // from the resolved configuration rather than inferred from it.
    assertContractPayload(observed.payload, 'payload under a hostile configuration');
    assert.strictEqual(observed.payload.status, STATUS_LITERAL, 'the served status is the frozen literal');
    assert.notStrictEqual(observed.payload.status, HOSTILE_SERVING_CONFIG.status);
  });

  test('every rejected value is reported, naming the key, the value and the frozen literal', () => {
    const observed = runWithHostileServingConfig(
      'process.stdout.write(JSON.stringify({ conflicts: health.frozenValueConflicts, host: health.config.host }));',
    );

    assert.strictEqual(observed.host, HOSTILE_SERVING_CONFIG.host, 'the injection must have taken effect');

    // Rejecting silently would leave an operator who edited the file to discover
    // the truth from a monitoring gap, so the audit trail is part of the contract.
    assert.deepStrictEqual(observed.conflicts, [
      { key: 'path', configured: HOSTILE_SERVING_CONFIG.path, frozen: HEALTH_PATH },
      { key: 'status', configured: HOSTILE_SERVING_CONFIG.status, frozen: STATUS_LITERAL },
    ]);
  });

  test('the frozen path is what the handler routes on, not the configured path', async () => {
    const observed = runWithHostileServingConfig(`
      const server = health.createHealthServer();
      server.listen(0, ${JSON.stringify(LOOPBACK)}, async () => {
        const origin = 'http://${LOOPBACK}:' + server.address().port;
        const bound = { signal: AbortSignal.timeout(${REQUEST_TIMEOUT_MS}) };
        const frozen = await fetch(origin + ${JSON.stringify(HEALTH_PATH)}, bound);
        const configured = await fetch(origin + ${JSON.stringify(HOSTILE_SERVING_CONFIG.path)}, bound);
        process.stdout.write(JSON.stringify({
          frozenStatus: frozen.status,
          frozenBody: await frozen.text(),
          configuredStatus: configured.status,
          configuredBody: await configured.text(),
          host: health.config.host,
        }));
        server.closeAllConnections();
        server.close();
      });
    `);

    assert.strictEqual(observed.host, HOSTILE_SERVING_CONFIG.host, 'the injection must have taken effect');

    assert.strictEqual(observed.frozenStatus, 200, 'the frozen path must still be served');
    assertContractPayload(JSON.parse(observed.frozenBody), 'GET /health under a hostile configuration');

    assert.strictEqual(
      observed.configuredStatus,
      404,
      'the path named by the configuration must never become a second route',
    );
    assert.strictEqual(observed.configuredBody, NOT_FOUND_BODY);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Group D.2 — a declared status is validated, never trusted
 *
 * Group D.1 proves a hostile document cannot move the resource path. This group
 * proves the same property for the other validated value, and it proves both
 * halves of that property: the declaration really is read, and a declaration that
 * is not the contract's literal is refused in favour of the compiled-in fallback.
 *
 * Asserting that the reported status equals `UP` cannot establish either half on
 * its own. It passes just as happily for an implementation that never reads the
 * file, and just as happily for one that echoes whatever the file says — because
 * the repository's own `config/health.json` declares `UP`. The only assertion that
 * separates the three is a configuration file that declares something *else*, so
 * that is what this group builds: a private workspace outside the repository
 * holding a copy of `health.js`, a copy of `package.json` so identity still
 * resolves normally, and a `config/health.json` identical to the real one except
 * for `status`. Provenance is asserted alongside the value, so a refusal is
 * visibly a refusal rather than a coincidence.
 *
 * The module is loaded in a child process, because resolution happens once at
 * module load and this process has already loaded the real module. Nothing inside
 * the repository is written, and the two real declared sources are asserted
 * byte-for-byte unchanged afterwards.
 * ---------------------------------------------------------------------------
 */

describe('health.js — a declared status is validated, never trusted', () => {
  /** A status no conforming implementation may ever report. */
  const HOSTILE_STATUS = 'DOWN';

  /** A second declared value, so the first is not merely a recognized word. */
  const ARBITRARY_STATUS = 'totally-made-up';

  /** @type {string} Absolute path of the private workspace, outside this repository. */
  let workspace = '';

  /** Bytes of the repository's own declared sources, captured before anything runs. */
  let realServingBytes = Buffer.alloc(0);
  let realManifestBytes = Buffer.alloc(0);

  before(() => {
    realServingBytes = fs.readFileSync(path.join(__dirname, 'config', 'health.json'));
    realManifestBytes = fs.readFileSync(path.join(__dirname, 'package.json'));
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'blitzy-health-status-'));
  });

  after(() => {
    fs.rmSync(workspace, { recursive: true, force: true });

    // The whole technique is only acceptable if it provably touched nothing here.
    assert.deepStrictEqual(
      fs.readFileSync(path.join(__dirname, 'config', 'health.json')),
      realServingBytes,
      "the repository's config/health.json must be untouched by this suite",
    );
    assert.deepStrictEqual(
      fs.readFileSync(path.join(__dirname, 'package.json')),
      realManifestBytes,
      "the repository's package.json must be untouched by this suite",
    );
  });

  /**
   * Load a copy of `health.js` beside a serving file declaring `declared`.
   *
   * Every other setting is copied verbatim from the real document, so the only
   * difference from the real module is the declared status and a failure here can
   * only be about that.
   *
   * @param {string} declared The status to write into the temporary serving file.
   * @returns {{config: Object, sources: Object, payload: Object, declared: string|null,
   *   status: string, conflicts: Array<Object>}} What the freshly loaded copy reports.
   */
  function loadWithDeclaredStatus(declared) {
    const home = fs.mkdtempSync(path.join(workspace, 'case-'));
    fs.mkdirSync(path.join(home, 'config'));
    fs.copyFileSync(path.join(__dirname, 'health.js'), path.join(home, 'health.js'));
    fs.writeFileSync(path.join(home, 'package.json'), realManifestBytes);

    const document = { ...JSON.parse(realServingBytes.toString('utf8')), status: declared };
    const servingPath = path.join(home, 'config', 'health.json');
    fs.writeFileSync(servingPath, JSON.stringify(document));

    const expression = `const h = require(${JSON.stringify(path.join(home, 'health.js'))});
      process.stdout.write(JSON.stringify({
        config: h.config,
        sources: h.configSources,
        payload: h.buildHealthPayload(),
        declared: h.declaredStatus(require(${JSON.stringify(servingPath)})),
        status: h.status,
        conflicts: h.frozenValueConflicts,
      }));`;
    const result = runNode(['-e', expression]);

    assert.strictEqual(result.status, 0, `the copy must load cleanly: ${result.stderr.toString('utf8')}`);
    assert.strictEqual(result.stderr.length, 0, 'requiring the module must stay silent');

    const reported = JSON.parse(result.stdout.toString('utf8'));

    // The premise of every assertion below: the temporary file really does declare
    // the hostile value, and the copy really did read that file.
    assert.strictEqual(reported.declared, declared, 'the temporary file must declare the hostile value');

    return reported;
  }

  test('a declared status is read faithfully but refused when it is not the literal', () => {
    const reported = loadWithDeclaredStatus(HOSTILE_STATUS);

    assert.strictEqual(reported.declared, HOSTILE_STATUS);
    assert.strictEqual(reported.status, STATUS_LITERAL, 'the exported status must refuse the declaration');
    assert.strictEqual(reported.payload.status, STATUS_LITERAL, 'the payload must refuse the declaration');
    assert.strictEqual(
      reported.config.status,
      STATUS_LITERAL,
      'the resolved setting is the compiled-in literal, not the declared value',
    );

    // The refusal is visible rather than inferred: the provenance says the value
    // came from the fallback, and the audit trail names what was rejected.
    assert.strictEqual(reported.sources.status, 'fallback', 'a refused declaration must resolve as fallback');
    assert.deepStrictEqual(reported.conflicts, [
      { key: 'status', configured: HOSTILE_STATUS, frozen: STATUS_LITERAL },
    ]);
  });

  test('an arbitrary declared status is equally powerless', () => {
    const reported = loadWithDeclaredStatus(ARBITRARY_STATUS);

    assert.strictEqual(reported.declared, ARBITRARY_STATUS);
    assert.strictEqual(reported.payload.status, STATUS_LITERAL);
    assert.strictEqual(reported.config.status, STATUS_LITERAL);
    assert.strictEqual(reported.sources.status, 'fallback');
    assert.deepStrictEqual(reported.conflicts, [
      { key: 'status', configured: ARBITRARY_STATUS, frozen: STATUS_LITERAL },
    ]);
  });

  test('a declaration that restates the literal is adopted, and the provenance says so', () => {
    // The counterpart to the two refusals above, and the assertion that proves the
    // chain is live rather than decorative: with a *legal* declaration the value is
    // taken from the file, nothing is rejected, and no fallback is involved.
    const reported = loadWithDeclaredStatus(STATUS_LITERAL);

    assert.strictEqual(reported.declared, STATUS_LITERAL);
    assert.strictEqual(reported.config.status, STATUS_LITERAL);
    assert.strictEqual(reported.payload.status, STATUS_LITERAL);
    assert.strictEqual(reported.sources.status, 'file', 'a legal declaration must be adopted from the file');
    assert.deepStrictEqual(reported.conflicts, [], 'a legal declaration is not a conflict');
  });

  test('the payload keeps its exact shape when a status is declared', () => {
    const { payload } = loadWithDeclaredStatus(HOSTILE_STATUS);

    // The serialized form is what a consumer compares, so it is asserted here too:
    // a hostile declaration must not reach the wire in any form.
    const serialized = JSON.stringify(payload);
    assert.deepStrictEqual(Object.keys(payload), [...PAYLOAD_KEYS]);
    assert.ok(serialized.endsWith(`,"status":"${STATUS_LITERAL}"}`), `unexpected tail: ${serialized}`);
    assert.ok(!serialized.includes(HOSTILE_STATUS), 'the declared value must not appear on the wire');
  });

  test('the other serving values are still read from the declared document', () => {
    // Without this, an implementation that stopped reading the file altogether
    // would be indistinguishable from one that stopped reading only the status.
    const { config, sources } = loadWithDeclaredStatus(HOSTILE_STATUS);

    assert.strictEqual(config.host, servingConfig.host, 'host must still come from the document');
    assert.strictEqual(config.port, servingConfig.port, 'port must still come from the document');
    assert.strictEqual(config.path, HEALTH_PATH, 'the resource path is the literal the file restates');
    assert.strictEqual(config.name, TIER_NAME, 'identity must still resolve from the manifest');
    assert.strictEqual(config.version, TIER_VERSION);

    // One refused member must not turn the whole document into a rejected one.
    assert.deepStrictEqual(sources, {
      name: 'file', version: 'file', host: 'file', port: 'file', path: 'file', status: 'fallback',
    });
  });
});

/*
 * ---------------------------------------------------------------------------
 * Group C.3 — the same contract over a real TCP socket
 *
 * One server serves the whole group: the handler is stateless, so a fresh
 * listener per assertion would only add bind churn. The `after` hook is what
 * guarantees the port is released even when an assertion fails.
 *
 * Every request goes through {@link request}, never through a bare `fetch`, so each
 * one carries an `AbortSignal.timeout`. A handler that stopped answering would
 * otherwise stall the whole run: `fetch` waits forever by default, and an
 * indefinitely hung job reports nothing useful about the defect that caused it.
 * ---------------------------------------------------------------------------
 */

describe('health.js — the /health contract served over a real socket', () => {
  /** @type {import('node:http').Server|null} */
  let server = null;
  /** @type {string} */
  let origin = '';
  /** @type {number} */
  let boundPort = 0;

  before(async () => {
    const started = await startEphemeralServer();
    server = started.server;
    origin = started.origin;
    boundPort = started.port;
  });

  after(async () => {
    await closeServer(server);
    server = null;
  });

  test('listens on an operating-system assigned port on the loopback interface', () => {
    const address = server.address();

    assert.strictEqual(server.listening, true);
    assert.strictEqual(address.address, LOOPBACK, 'a probe must address the loopback interface directly');
    assert.strictEqual(address.port, boundPort);
    assert.ok(Number.isInteger(boundPort) && boundPort > 0, 'the operating system must have assigned a real port');
  });

  test('GET /health returns 200 with both contract headers and the four-member body', async () => {
    const response = await request(`${origin}${HEALTH_PATH}`);
    const body = await response.text();

    assert.strictEqual(response.status, 200, 'a healthy status must be reported with 200');
    assertContractHeaders(response, 'GET /health');
    assert.strictEqual(response.headers.get('allow'), null, 'only a 405 carries Allow');
    assert.strictEqual(
      Number(response.headers.get('content-length')),
      Buffer.byteLength(body, 'utf8'),
      'Content-Length must be the byte length of the body',
    );

    const payload = assertContractPayload(JSON.parse(body), 'GET /health');
    assert.strictEqual(
      body,
      `{"name":"${payload.name}","version":"${payload.version}","timestamp":"${payload.timestamp}","status":"${payload.status}"}`,
      'the body on the wire must be the compact canonical shape',
    );
  });

  test('GET /health?x=1 routes, answers and shapes identically — only the timestamp is newly generated', async () => {
    const baseline = assertContractPayload(await (await request(`${origin}${HEALTH_PATH}`)).json(), 'GET /health');

    const response = await request(`${origin}${HEALTH_PATH}?x=1`);
    const payload = assertContractPayload(await response.json(), 'GET /health?x=1');

    assert.strictEqual(response.status, 200);
    assertContractHeaders(response, 'GET /health?x=1');

    // The query string is ignored by the path comparison, so routing, status,
    // headers, member order and the three stable members all match the bare path.
    // The timestamp deliberately does *not*: it is generated per request, so
    // claiming the two responses are identical in every respect would be false.
    assert.deepStrictEqual(Object.keys(payload), Object.keys(baseline));
    assert.strictEqual(payload.name, baseline.name);
    assert.strictEqual(payload.version, baseline.version);
    assert.strictEqual(payload.status, STATUS_LITERAL);
    assert.strictEqual(payload.status, baseline.status);
    assert.notStrictEqual(payload.timestamp, baseline.timestamp, 'the timestamp must be generated for this request');
  });

  test('HEAD /health returns 200 with the contract headers and no body', async () => {
    // The Content-Length a GET would have produced, measured rather than assumed,
    // so the HEAD comparison is against the real payload size.
    const getResponse = await request(`${origin}${HEALTH_PATH}`);
    const getBodyBytes = Buffer.byteLength(await getResponse.text(), 'utf8');

    const response = await request(`${origin}${HEALTH_PATH}`, { method: 'HEAD' });
    const body = await response.text();

    assert.strictEqual(response.status, 200);
    assertContractHeaders(response, 'HEAD /health');
    assert.strictEqual(body, '', 'a HEAD response must carry no body');
    assert.strictEqual(
      Number(response.headers.get('content-length')),
      getBodyBytes,
      'HEAD must still report the byte length the body would have had',
    );
  });

  test('POST /health returns 405 with Allow: GET, HEAD and the error body', async () => {
    const response = await request(`${origin}${HEALTH_PATH}`, { method: 'POST' });
    const body = await response.text();

    assert.strictEqual(response.status, 405);
    assert.strictEqual(response.headers.get('allow'), ALLOW_HEADER);
    assertContractHeaders(response, 'POST /health');
    assert.strictEqual(body, METHOD_NOT_ALLOWED_BODY);
  });

  test('DELETE /health returns 405 as well — only GET and HEAD are accepted', async () => {
    const response = await request(`${origin}${HEALTH_PATH}`, { method: 'DELETE' });
    const body = await response.text();

    assert.strictEqual(response.status, 405);
    assert.strictEqual(response.headers.get('allow'), ALLOW_HEADER);
    assert.strictEqual(body, METHOD_NOT_ALLOWED_BODY);
  });

  test('GET on an unknown path returns 404 with the small JSON error body', async () => {
    const response = await request(`${origin}/unknown`);
    const body = await response.text();

    assert.strictEqual(response.status, 404);
    assertContractHeaders(response, 'GET /unknown');
    assert.strictEqual(response.headers.get('allow'), null, 'only a 405 carries Allow');
    assert.strictEqual(body, NOT_FOUND_BODY);
    assert.deepStrictEqual(JSON.parse(body), { error: 'Not Found' });
  });

  test('GET /health/ returns 404 — the path comparison is exact', async () => {
    const response = await request(`${origin}${HEALTH_PATH}/`);
    const body = await response.text();

    assert.strictEqual(response.status, 404, 'a trailing slash is not normalized away');
    assert.strictEqual(body, NOT_FOUND_BODY);
  });

  test('GET //health returns 404 — a doubled leading slash is not an alias', async () => {
    // The contract admits exactly one route. A doubled leading slash is a
    // different request target, and it must not resolve to the health resource
    // through any normalization: an undocumented alias for a probe endpoint is a
    // route nothing tests and nothing monitors.
    const response = await request(`${origin}//health`);
    const body = await response.text();

    assert.strictEqual(response.status, 404, 'a doubled leading slash must not reach the payload');
    assertContractHeaders(response, 'GET //health');
    assert.strictEqual(body, NOT_FOUND_BODY);
  });

  test('POST on an unknown path returns 405 — the method is checked before the path', async () => {
    const response = await request(`${origin}/unknown`, { method: 'POST' });
    const body = await response.text();

    assert.strictEqual(response.status, 405, 'the request must never reach the path comparison');
    assert.strictEqual(response.headers.get('allow'), ALLOW_HEADER);
    assert.strictEqual(body, METHOD_NOT_ALLOWED_BODY);
  });

  test('two immediately successive responses differ in timestamp and agree on every other member', async () => {
    // No delay between the two round-trips, so this asserts the contract's
    // freshness clause as written rather than merely that time passed while the
    // suite waited.
    const first = assertContractPayload(await (await request(`${origin}${HEALTH_PATH}`)).json(), 'first response');
    const second = assertContractPayload(await (await request(`${origin}${HEALTH_PATH}`)).json(), 'second response');

    // Proof of liveness rather than of mere reachability: a process frozen after
    // binding its socket could otherwise keep serving a well-formed stale payload.
    assert.notStrictEqual(
      second.timestamp,
      first.timestamp,
      'consecutive responses must differ in timestamp with no delay between them',
    );
    assert.ok(Date.parse(second.timestamp) > Date.parse(first.timestamp));

    assert.strictEqual(second.name, first.name);
    assert.strictEqual(second.version, first.version);
    assert.strictEqual(second.status, first.status);
  });

  test('a burst of requests never repeats a timestamp over the wire', async () => {
    // Back-to-back round-trips on a loopback socket can complete inside one
    // millisecond, which is precisely the case a raw clock read cannot serve. Every
    // other contract member must stay identical across the burst, so the endpoint
    // is proven fresh in exactly one field and stable in the other three.
    const payloads = [];
    for (let index = 0; index < WIRE_BURST_REQUEST_COUNT; index += 1) {
      const response = await request(`${origin}${HEALTH_PATH}`);

      assert.strictEqual(response.status, 200, `burst request ${index} must succeed`);
      payloads.push(assertContractPayload(await response.json(), `burst response ${index}`));
    }

    const timestamps = payloads.map((payload) => payload.timestamp);

    assert.strictEqual(
      new Set(timestamps).size,
      WIRE_BURST_REQUEST_COUNT,
      'every response in a burst must carry a distinct timestamp',
    );

    for (let index = 1; index < payloads.length; index += 1) {
      assert.ok(
        timestamps[index] > timestamps[index - 1],
        `response ${index} must carry a strictly later timestamp than its predecessor`,
      );
      assert.strictEqual(payloads[index].name, payloads[0].name, 'name must stay stable across the burst');
      assert.strictEqual(payloads[index].version, payloads[0].version, 'version must stay stable across the burst');
      assert.strictEqual(payloads[index].status, payloads[0].status, 'status must stay stable across the burst');
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * Group F.1 — a configuration fallback is observable, not silent
 *
 * The failure mode these close is quiet and expensive. A deployment that lost
 * `config/health.json` still serves a perfectly valid `200` carrying the compiled-in
 * fallback identity: every liveness signal reads healthy while the payload no longer
 * describes the build it came from. The fallback itself is required — an endpoint
 * that refuses to answer because of its own configuration turns a running
 * application into one that reports itself unhealthy — so the fix is not to fail, it
 * is to *say so*.
 *
 * Two properties are asserted together throughout, because either alone is
 * insufficient: the reason must be retained and reachable, and requiring the
 * module must still write nothing to either stream. A module that logged at import
 * time would log when a test imported it and twice when two specifiers loaded it.
 * ---------------------------------------------------------------------------
 */

describe('health.js — a degraded configuration source is recorded, never silent', () => {
  const validManifest = JSON.stringify({ name: TIER_NAME, version: TIER_VERSION });
  const validServing = JSON.stringify({
    host: TIER_DEFAULT_HOST,
    port: TIER_DEFAULT_PORT,
    path: HEALTH_PATH,
    status: STATUS_LITERAL,
  });

  test('a fully configured tier reports no degradation at all', () => {
    const surface = loadDiagnostics(buildTierCopy('intact', validManifest, validServing));

    assert.deepStrictEqual(surface.degradations, [], 'a healthy configuration must record nothing');
    assert.strictEqual(surface.line, null, 'the renderer must return null, not an empty string');
    assert.ok(surface.frozen, 'the recorded list must be frozen against mutation by a consumer');
    assert.strictEqual(surface.values.name, TIER_NAME);
    assert.strictEqual(surface.values.version, TIER_VERSION);
  });

  test('both sources absent are reported as missing, in declared order', () => {
    const surface = loadDiagnostics(buildTierCopy('absent', null, null));

    assert.deepStrictEqual(surface.degradations, [
      `${SOURCE_IDENTITY}: ${DEGRADED_MISSING}`,
      `${SOURCE_SERVING}: ${DEGRADED_MISSING}`,
    ]);
    // Identity precedes serving because that is the order the module declares the
    // two sources in. A stable order keeps the rendered line diffable across runs.
    assert.ok(surface.line.startsWith(DEGRADED_PREFIX));
  });

  test('a source that cannot be read is reported as unreadable, not as missing', () => {
    // The distinction is the operator's next action: create the file, or fix its
    // permissions. Reporting a present-but-unreadable file as "missing" sends them
    // to create a file that already exists.
    const surface = loadDiagnostics(buildTierCopy('unreadable', AS_DIRECTORY, AS_DIRECTORY));

    assert.deepStrictEqual(surface.degradations, [
      `${SOURCE_IDENTITY}: ${DEGRADED_UNREADABLE}`,
      `${SOURCE_SERVING}: ${DEGRADED_UNREADABLE}`,
    ]);
  });

  test('serving content that is not JSON is reported as malformed', () => {
    for (const malformed of ['{"host":"0.0.0.0",}', '{"host":', '', '42', 'null', '["host"]']) {
      const surface = loadDiagnostics(buildTierCopy('malformed', validManifest, malformed));

      assert.deepStrictEqual(
        surface.degradations,
        [`${SOURCE_SERVING}: ${DEGRADED_MALFORMED}`],
        `${JSON.stringify(malformed)} must be reported as malformed`,
      );
      // The endpoint must still answer, which is the entire justification for the
      // fallback chain existing at all.
      assert.strictEqual(surface.values.port, TIER_DEFAULT_PORT);
      // A source that cannot be parsed declares nothing, so the validated values
      // resolve to their compiled-in literals and the provenance says `fallback`.
      assert.strictEqual(surface.values.status, STATUS_LITERAL);
      assert.strictEqual(surface.sources.status, 'fallback');
      assert.strictEqual(surface.values.path, HEALTH_PATH);
      assert.strictEqual(surface.sources.path, 'fallback');
      assert.strictEqual(surface.payloadStatus, STATUS_LITERAL);
      // Nothing was *declared*, so nothing was rejected: a malformed source is a
      // degradation, not a conflict.
      assert.deepStrictEqual(surface.conflicts, []);
    }
  });

  test('a source present but carrying none of its members is reported as incomplete', () => {
    const identitySurface = loadDiagnostics(
      buildTierCopy('identity-empty', JSON.stringify({ private: true }), validServing),
    );
    assert.deepStrictEqual(identitySurface.degradations, [
      `${SOURCE_IDENTITY}: ${DEGRADED_INCOMPLETE}`,
    ]);
    assert.strictEqual(identitySurface.values.name, TIER_NAME, 'the literal fallback must fill the gap');

    const servingSurface = loadDiagnostics(
      buildTierCopy('serving-empty', validManifest, JSON.stringify({ note: 'nothing useful' })),
    );
    assert.deepStrictEqual(servingSurface.degradations, [
      `${SOURCE_SERVING}: ${DEGRADED_INCOMPLETE}`,
    ]);
  });

  test('a partially populated serving document is NOT a degradation', () => {
    // Omitting `host` while setting `port` is a documented, supported use of the
    // resolution chain. Reporting it would make the diagnostic fire on correct
    // configurations, which is the fastest way to teach an operator to ignore it.
    const surface = loadDiagnostics(
      buildTierCopy('partial', validManifest, JSON.stringify({ port: 3111 })),
    );

    assert.deepStrictEqual(surface.degradations, []);
    assert.strictEqual(surface.line, null);
    assert.strictEqual(surface.values.port, 3111, 'the supplied member must still be honoured');
    assert.strictEqual(surface.values.host, TIER_DEFAULT_HOST, 'the omitted member falls back');
  });

  test('only the failing source is named when the other one is intact', () => {
    const surface = loadDiagnostics(buildTierCopy('serving-only', validManifest, null));

    assert.deepStrictEqual(surface.degradations, [`${SOURCE_SERVING}: ${DEGRADED_MISSING}`]);
    assert.ok(!surface.line.includes(SOURCE_IDENTITY), 'an intact source must not be blamed');
  });

  test('the rendered line is one line, names the consequence, and discloses nothing', () => {
    const surface = loadDiagnostics(buildTierCopy('disclosure', AS_DIRECTORY, '{"host":'));

    assert.strictEqual(surface.line.split('\n').length, 1, 'one degradation, one line');
    assert.ok(
      surface.line.includes('fallback'),
      'the line must state that the endpoint is still serving, so a configuration ' +
        'problem is not mistaken for an outage',
    );
    // No path, no file name, no byte of file content, no control character.
    assertNoDisclosure(surface.line, 'the degraded-configuration line');
  });

  test('the contract still holds in full while the configuration is degraded', () => {
    const surface = loadDiagnostics(buildTierCopy('contract-degraded', null, null));

    assert.deepStrictEqual(surface.payloadKeys, [...PAYLOAD_KEYS]);
    // With no source at all, every value is the compiled-in literal and every
    // provenance entry says so — the contract is served in full regardless.
    assert.strictEqual(surface.values.status, STATUS_LITERAL);
    assert.strictEqual(surface.status, STATUS_LITERAL);
    assert.strictEqual(surface.payloadStatus, STATUS_LITERAL);
    assert.strictEqual(surface.values.path, HEALTH_PATH);
    assert.strictEqual(surface.values.name, TIER_NAME);
    assert.strictEqual(surface.values.version, TIER_VERSION);
    assert.deepStrictEqual(surface.sources, {
      name: 'fallback',
      version: 'fallback',
      host: 'fallback',
      port: 'fallback',
      path: 'fallback',
      status: 'fallback',
    });
  });

  test('an environment override still applies while a source is degraded', () => {
    const surface = loadDiagnostics(buildTierCopy('override-degraded', null, null), {
      HOST: LOOPBACK,
      PORT: '3222',
    });

    assert.deepStrictEqual(surface.degradations, [
      `${SOURCE_IDENTITY}: ${DEGRADED_MISSING}`,
      `${SOURCE_SERVING}: ${DEGRADED_MISSING}`,
    ]);
    assert.strictEqual(surface.values.host, LOOPBACK, 'HOST outranks a missing configuration file');
    assert.strictEqual(surface.values.port, 3222);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Group F.2 — the entry point announces a degradation exactly once
 *
 * `health.js` records; `server.js` reports. This group asserts the division: the
 * ordinary start-up says nothing on `stderr`, and a degraded start-up says exactly
 * one line there while `stdout` still carries exactly the one bound-address line a
 * consumer parses.
 * ---------------------------------------------------------------------------
 */

describe('server.js — the degraded-configuration start-up warning', () => {
  /**
   * Load a copied `server.js` far enough to exercise `start()`, without leaving a
   * listener behind.
   *
   * The port is one reserved by {@link reserveFreePort} rather than `0`: a resolved
   * configuration port of `0` is rejected, so passing it would fall through to the
   * tier's own 3000 and publish a service on the port an operator expects to be the
   * real application. The child is signalled as soon as it announces itself, so
   * nothing outlives the assertion.
   *
   * @param {string} label Case name.
   * @param {string|symbol|null} identity Manifest content or sentinel.
   * @param {string|symbol|null} serving Serving content or sentinel.
   * @param {number} port A reserved, currently free loopback port.
   * @returns {{stdout: string, stderr: string, status: number|null}} Captured output.
   */
  function startAndStop(label, identity, serving, port) {
    const modulePath = buildTierCopy(label, identity, serving);
    const serverPath = path.join(path.dirname(modulePath), 'server.js');
    // A short, self-terminating wrapper: require the entry point, then raise
    // SIGTERM on this same process once the event loop has turned, so the
    // documented shutdown path runs and the port is released.
    const wrapper =
      `require(${JSON.stringify(serverPath)});` +
      'setTimeout(() => { process.kill(process.pid, "SIGTERM"); }, 250);';
    const result = runNode(['-e', wrapper], { PORT: String(port), HOST: LOOPBACK });
    return {
      stdout: result.stdout.toString('utf8'),
      stderr: result.stderr.toString('utf8'),
      status: result.status,
    };
  }

  const validManifest = JSON.stringify({ name: TIER_NAME, version: TIER_VERSION });
  const validServing = JSON.stringify({ path: HEALTH_PATH, status: STATUS_LITERAL });

  test('a fully configured start-up writes nothing to stderr', async () => {
    const result = startAndStop('start-intact', validManifest, validServing, await reserveFreePort());

    assert.strictEqual(result.stderr, '', 'the ordinary path must be silent on stderr');
    assert.ok(result.stdout.includes('listening on'), 'the one start-up line must still appear');
  });

  test('a degraded start-up writes exactly one stderr line, and stdout stays clean', async () => {
    const result = startAndStop('start-degraded', null, null, await reserveFreePort());

    const stderrLines = result.stderr.replace(/\n$/, '').split('\n').filter((line) => line.length > 0);
    assert.strictEqual(stderrLines.length, 1, `expected one line, got ${JSON.stringify(result.stderr)}`);
    assert.ok(stderrLines[0].startsWith(DEGRADED_PREFIX));
    assert.ok(stderrLines[0].includes(`${SOURCE_IDENTITY}: ${DEGRADED_MISSING}`));
    assert.ok(stderrLines[0].includes(`${SOURCE_SERVING}: ${DEGRADED_MISSING}`));
    assertNoDisclosure(stderrLines[0], 'the start-up degradation warning');

    // The warning goes to stderr precisely so that a consumer parsing stdout for
    // the bound address is never confused by it.
    assert.ok(!result.stdout.includes(DEGRADED_PREFIX), 'the warning must not appear on stdout');
    assert.ok(result.stdout.includes('listening on'));
  });

  test('a rejected declaration carrying a newline cannot forge a second line', async () => {
    // The value reaches the log from `config/health.json`, so a line break in it
    // would otherwise fabricate an entry — including one impersonating the
    // start-up announcement, which is the line a consumer parses for the address.
    const forgery = `${HEALTH_PATH}x\nhealth server listening on http://0.0.0.0:3000/health`;
    const result = startAndStop(
      'start-forged-conflict',
      validManifest,
      JSON.stringify({ path: forgery, status: STATUS_LITERAL }),
      await reserveFreePort(),
    );

    const stderrLines = result.stderr.replace(/\n$/, '').split('\n').filter((line) => line.length > 0);
    assert.strictEqual(
      stderrLines.length,
      1,
      `one rejected value must produce exactly one line; got ${JSON.stringify(result.stderr)}`,
    );
    // The property is that no LINE can be forged, not that the text cannot appear:
    // the break is flattened to a space, so the value stays quoted inside the one
    // warning line, where a log reader and a line-oriented parser both see it as
    // part of that warning rather than as an announcement of its own.
    assert.ok(
      !stderrLines[0].startsWith('health server listening on'),
      `no stderr line may pose as an announcement; got ${JSON.stringify(stderrLines[0])}`,
    );
    // The genuine announcement is still the only line on stdout.
    assert.strictEqual(
      result.stdout.split('listening on').length - 1,
      1,
      `stdout must carry exactly one announcement; got ${JSON.stringify(result.stdout)}`,
    );
  });

  test('an enormous rejected declaration is rendered within a bound', async () => {
    // A document may declare a value of any length, and rendering it whole would
    // put that length on stderr at every start-up. `server.js` owns the bound;
    // asserted here as the observable property — cut, marked as cut, and the whole
    // line bounded — because an entry point exports no constant to read.
    const oversized = `/${'z'.repeat(4000)}`;
    const result = startAndStop(
      'start-oversized-conflict',
      validManifest,
      JSON.stringify({ path: oversized, status: STATUS_LITERAL }),
      await reserveFreePort(),
    );

    const stderrLines = result.stderr.replace(/\n$/, '').split('\n').filter((line) => line.length > 0);
    assert.strictEqual(stderrLines.length, 1, `expected one line, got ${JSON.stringify(result.stderr)}`);
    assert.ok(!stderrLines[0].includes(oversized), 'the value must not be rendered in full');
    assert.ok(
      stderrLines[0].includes('..."'),
      `a truncated value must be marked as truncated; got ${JSON.stringify(stderrLines[0])}`,
    );
    assert.ok(
      stderrLines[0].length < 400,
      `the whole line must stay bounded; it was ${stderrLines[0].length} characters`,
    );
    // Still actionable: the leading characters are what an operator recognises.
    assert.ok(stderrLines[0].includes('/zzzz'), 'the value\'s leading characters must survive');
  });

  test('the degradation is reported before the values it explains', async () => {
    // Ordering is the difference between an operator reading "the manifest was
    // missing" then "listening as parent_repo_10_LOC" — and having to scroll back.
    const modulePath = buildTierCopy('start-order', null, null);
    const serverPath = path.join(path.dirname(modulePath), 'server.js');
    const wrapper =
      'const chunks = [];' +
      'const capture = (stream, tag) => { const write = stream.write.bind(stream);' +
      ' stream.write = (chunk, ...rest) => { chunks.push(tag + ":" + String(chunk).trim()); return write(chunk, ...rest); }; };' +
      'capture(process.stderr, "err"); capture(process.stdout, "out");' +
      `require(${JSON.stringify(serverPath)});` +
      'setTimeout(() => { process.stderr.write = () => true;' +
      ' require("node:fs").writeSync(1, "ORDER=" + chunks.map((c) => c.split(":")[0]).join(",") + "\\n");' +
      ' process.kill(process.pid, "SIGTERM"); }, 250);';
    const result = runNode(['-e', wrapper], { PORT: String(await reserveFreePort()), HOST: LOOPBACK });
    const order = /ORDER=([a-z,]+)/.exec(result.stdout.toString('utf8'));

    assert.ok(order !== null, `expected an ORDER marker in ${result.stdout.toString('utf8')}`);
    assert.ok(
      order[1].startsWith('err'),
      `the degradation must precede the start-up line; observed order was ${order[1]}`,
    );
  });
});

/*
 * ---------------------------------------------------------------------------
 * Group G.1 — an unexpected handler failure is reported, and never misattributed
 *
 * Two populations of failure reach the handler's `catch`, and conflating them is
 * the defect this group locks out. A peer that hangs up mid-response is routine — a
 * poller whose timeout expired, a load balancer that got what it needed — and
 * reporting it would produce a log that grows with poll volume and says nothing. A
 * defect in the handler is rare and must be heard.
 *
 * The load-bearing assertion is that an internal failure no longer answers `404`.
 * A `404` is a statement about the *client's* request target, so returning it after
 * an internal fault blames the caller for this process's defect: a poller records a
 * clean contract-shaped response, a human hunts for a typo in a correct URL, and
 * the real fault leaves no trace. Misreporting is worse than not reporting.
 * ---------------------------------------------------------------------------
 */

describe('health.js — unexpected handler failures are reported, expected ones are not', () => {
  test('every expected peer-disconnect code is handled in complete silence', () => {
    const { stdout, stderrLines, raw } = provokeHandlerFailures('expected-disconnects');

    assert.strictEqual(stderrLines.length, 0, `expected silence, got ${JSON.stringify(raw)}`);
    assert.deepStrictEqual(stdout.reported, [], 'no category may be latched by a disconnect');
    assert.strictEqual(stdout.cases.length, 7, 'all seven documented codes must be exercised');
    for (const observed of stdout.cases) {
      assert.ok(observed.destroyed, `${observed.code} must still close the connection`);
      assert.ok(
        !observed.statuses.includes(404),
        `${observed.code} must not produce a 404 — the peer left, the path was fine`,
      );
    }
  });

  test('an unexpected failure is reported once per category, however often it recurs', () => {
    const { stdout, stderrLines, raw } = provokeHandlerFailures('latched');

    assert.strictEqual(stderrLines.length, 2, `expected two lines, got ${JSON.stringify(raw)}`);
    assert.deepStrictEqual(stdout.reported, ['TypeError', 'RangeError']);
    for (const line of stderrLines) {
      assert.ok(line.startsWith(HANDLER_FAILURE_PREFIX));
      assertNoDisclosure(line, 'a handler-failure diagnostic');
    }
  });

  test('an internal failure does NOT answer 404, while a genuine unknown path still does', () => {
    const { stdout, stderrLines } = provokeHandlerFailures('no-misleading-404');

    // The defect path: nothing fabricated, connection closed, fault reported.
    assert.ok(
      !stdout.defect.statuses.includes(404),
      `an internal failure must never be reported to the client as 404; statuses were ${JSON.stringify(stdout.defect.statuses)}`,
    );
    assert.ok(stdout.defect.destroyed, 'the connection must be closed rather than left hanging');
    assert.ok(!stdout.defect.ended, 'no response may be completed when none could be written');
    assert.strictEqual(stderrLines.length, 1, 'the fault must be visible server-side');

    // The routing path is untouched: a real unknown path is still a real 404.
    assert.deepStrictEqual(stdout.routed.statuses, [404]);
    assert.ok(stdout.routed.hasBody, 'the contract 404 still carries its JSON error body');
  });

  test('a fault before anything is written writes no status at all, and never a 404', () => {
    const { stdout, stderrLines } = provokeHandlerFailures('fault-before-response');

    // The contract enumerates exactly three responses — 200, 405 and 404 — so a
    // fault must not be answered with a fourth. Nothing is written: the connection
    // is closed, which is the honest transport-level outcome and which every probe
    // already treats as unhealthy.
    assert.deepStrictEqual(stdout.statuses, [], 'no status line may be written for an internal fault');
    assert.deepStrictEqual(stdout.bodies, [], 'no body may be written either');
    assert.ok(stdout.destroyed, 'the connection must be closed rather than left hanging');
    assert.ok(!stdout.ended, 'no response may be completed when none could be written');

    // And it is still reported server-side, with the consequence stated accurately:
    // a closed connection alone is indistinguishable from a network blip.
    assert.deepStrictEqual(stdout.reported, ['TypeError']);
    assert.strictEqual(stderrLines.length, 1);
    assert.ok(
      stderrLines[0].includes('closed without a response'),
      `the consequence must name what the client got; got ${JSON.stringify(stderrLines[0])}`,
    );
    assert.ok(
      !/\b(4\d\d|5\d\d)\b/.test(stderrLines[0]),
      `no out-of-contract status may be claimed; got ${JSON.stringify(stderrLines[0])}`,
    );
    assertNoDisclosure(stderrLines[0], 'an internal-fault diagnostic');
  });

  test('a failure after headers are sent ends the response and says so', () => {
    const { stdout, stderrLines } = provokeHandlerFailures('in-flight');

    assert.ok(stdout.ended, 'a response already on the wire must be ended, not left open');
    assert.ok(!stdout.destroyed, 'destroying a completed response would be gratuitous');
    assert.strictEqual(stderrLines.length, 1);
    assert.ok(
      stderrLines[0].includes('in flight'),
      `the consequence must be stated accurately; got ${JSON.stringify(stderrLines[0])}`,
    );
  });

  test('reporting is bounded, so a storm of distinct defects cannot flood the log', () => {
    const { stdout, stderrLines } = provokeHandlerFailures('bounded');

    assert.strictEqual(stderrLines.length, MAX_REPORTED_HANDLER_FAILURES);
    assert.strictEqual(stdout.reported.length, MAX_REPORTED_HANDLER_FAILURES);
  });

  test('a category carrying a newline cannot forge an extra log line', () => {
    const { stdout, stderrLines } = provokeHandlerFailures('injected-name');

    // `error.name` is a writable property, so a value containing a newline could
    // otherwise emit a second line impersonating this server's own start-up output.
    assert.strictEqual(stderrLines.length, 1, 'one failure must produce exactly one line');
    assert.strictEqual(stdout.reported.length, 1);
    assert.ok(!stderrLines[0].includes('listening on'), 'no forged announcement may appear');
    assert.ok(!/\s/.test(stdout.reported[0]), 'the category must contain no whitespace at all');
  });

  test('a thrown non-Error records its type and never its value', () => {
    const { stdout, stderrLines } = provokeHandlerFailures('thrown-primitive');

    assert.deepStrictEqual(stdout.reported, ['Thrown_string']);
    assert.ok(stdout.destroyed);
    assert.strictEqual(stderrLines.length, 1);
    assertNoDisclosure(stderrLines[0], 'a thrown-primitive diagnostic');
  });

  test('the live module has reported nothing, so the suite provoked no real fault', () => {
    // A guard on the suite itself: the groups above run in children, so the
    // in-process latch must still be empty. If it is not, some other test above
    // triggered a genuine handler defect and that is a failure worth seeing.
    assert.deepStrictEqual(health.reportedHandlerFailures(), []);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Group E.1 — the routing decision itself, with no socket in the way
 *
 * `requestTargetPath` is exported precisely so this can be asserted directly.
 * One resource has one spelling, and everything that makes that hard lives in
 * that one function: run before any listener is started, so a routing defect is
 * reported as a routing defect rather than as a puzzling 404 on the wire.
 * ---------------------------------------------------------------------------
 */

describe('health.js — the request target names exactly one path', () => {
  for (const [target, expected] of TARGET_PATH_CASES) {
    test(`${JSON.stringify(target)} names ${JSON.stringify(expected)}`, () => {
      assert.strictEqual(health.requestTargetPath(target), expected);
    });
  }

  test('an absent or non-string target names no path', () => {
    assert.strictEqual(health.requestTargetPath(undefined), null);
    assert.strictEqual(health.requestTargetPath(null), null);
    assert.strictEqual(health.requestTargetPath(''), null);
  });

  test('no alias of the health path is ever reported as the health path', () => {
    // Stated as the claim it is, rather than only as rows in the table above: this
    // is the assertion that fails if the implementation ever goes back to reading a
    // parsed pathname, whichever normalization the runtime happens to apply.
    for (const alias of ['/%68ealth', '///health', '//../health', '/./health', '/health%2F', '/health/']) {
      assert.notStrictEqual(
        health.requestTargetPath(alias),
        HEALTH_PATH,
        `${alias} must not resolve to the served path`,
      );
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * Group G.2 — a configuration-derived host cannot corrupt a diagnostic
 *
 * `HOST` reaches the start-up line and every bind-failure message. Its value is
 * chosen by whoever can set an environment variable or edit a configuration file,
 * which in CI is a broader group than those who can change this source, so every
 * diagnostic that renders it is a log-injection sink. A host carrying a newline
 * would not merely look untidy: it would emit a second line that a collector parses
 * as its own event, and that line can be made to read exactly like this server's
 * successful start-up announcement — telling an operator the endpoint is up when it
 * never bound at all.
 * ---------------------------------------------------------------------------
 */

describe('server.js — a hostile host is rejected before it reaches a diagnostic', () => {
  /**
   * Attempt a bind with a chosen `HOST` and capture the process's output.
   *
   * A reserved concrete port is supplied rather than `0`, because a resolved
   * configuration port of `0` is rejected and would silently fall through to the
   * tier's own 3000 — publishing a service the suite must not publish.
   *
   * @param {string} host The `HOST` value to attempt.
   * @param {number} port A port reserved by {@link reserveFreePort}.
   * @returns {{stdout: string, stderr: string, status: number|null}} Captured output.
   */
  function attemptBind(host, port) {
    const result = runNode([SERVER_PATH], { HOST: host, PORT: String(port) });
    return {
      stdout: result.stdout.toString('utf8'),
      stderr: result.stderr.toString('utf8'),
      status: result.status,
    };
  }

  test('a host carrying a newline cannot forge a start-up announcement', async () => {
    const forgery = `${HANDLER_FAILURE_PREFIX}none\nhealth server listening on http://0.0.0.0:3000/health`;
    const result = attemptBind(forgery, await reserveFreePort());

    assert.notStrictEqual(result.status, 0, 'an unbindable host must fail the start-up');
    assert.ok(
      result.stderr.includes(UNSAFE_TEXT),
      `the host must be replaced wholesale; got ${JSON.stringify(result.stderr)}`,
    );
    assert.ok(
      !result.stdout.includes('listening on'),
      'no forged announcement may reach stdout, where a consumer looks for the bound address',
    );
    assert.strictEqual(
      (result.stderr.match(/listening on/g) || []).length,
      0,
      `the forged text must not survive into stderr either; got ${JSON.stringify(result.stderr)}`,
    );
  });

  test('an unresolvable but well-formed host is reported with a stable category', async () => {
    const result = attemptBind('host.invalid.no-such-tld', await reserveFreePort());

    assert.notStrictEqual(result.status, 0);
    // The host is legitimate-looking, so it is shown verbatim — that is the point
    // of an allowlist rather than blanket redaction.
    assert.ok(
      result.stderr.includes('host.invalid.no-such-tld'),
      `a well-formed host must remain readable; got ${JSON.stringify(result.stderr)}`,
    );
    // What must not appear is Node's own prose, which interpolates the resolver
    // detail and varies with the platform's locale.
    assert.ok(
      !/getaddrinfo|ENOTFOUND .*\n/.test(result.stderr.replace('ENOTFOUND', '')),
      `the raw resolver message must not be forwarded; got ${JSON.stringify(result.stderr)}`,
    );
    assert.ok(
      result.stderr.split('\n').filter((line) => line.length > 0).length <= 2,
      `a bind failure must stay concise; got ${JSON.stringify(result.stderr)}`,
    );
  });

  test('a legitimate loopback host binds and is rendered verbatim', async () => {
    const result = runNode(
      [
        '-e',
        `const s = require(${JSON.stringify(SERVER_PATH)});` +
          'setTimeout(() => { process.kill(process.pid, "SIGTERM"); }, 250);',
      ],
      { HOST: LOOPBACK, PORT: String(await reserveFreePort()) },
    );

    assert.strictEqual(result.stderr.length, 0, 'a valid configuration must produce no diagnostics');
    assert.ok(result.stdout.toString('utf8').includes(`http://${LOOPBACK}:`));
    assert.ok(!result.stdout.toString('utf8').includes(UNSAFE_TEXT));
  });
});

/*
 * ---------------------------------------------------------------------------
 * Group E.2 — the same rule on the wire, with request lines written by hand
 *
 * Group C.3 uses the built-in `fetch`, which is the right client for asserting a
 * normal request. It is the wrong client for asserting a spelling: it builds its
 * request line from a parsed URL, so the normalization under test is applied
 * before the bytes leave this process. These assertions therefore write their own
 * request lines to a socket and read the response bytes back.
 * ---------------------------------------------------------------------------
 */

describe('health.js — one resource, one spelling, asserted on the wire', () => {
  /** @type {import('node:http').Server|null} */
  let server = null;
  /** @type {number} */
  let boundPort = 0;

  before(async () => {
    const started = await startEphemeralServer();
    server = started.server;
    boundPort = started.port;
  });

  after(async () => {
    await closeServer(server);
    server = null;
  });

  for (const target of SERVED_TARGETS) {
    test(`GET ${target} is served with the full contract`, async () => {
      const response = await rawRequest(boundPort, 'GET', target);

      assert.strictEqual(response.statusCode, 200, `${target} must be served`);
      assert.strictEqual(response.headers.get('content-type'), CONTENT_TYPE);
      assert.strictEqual(response.headers.get('cache-control'), CACHE_CONTROL);

      const payload = assertContractPayload(JSON.parse(response.body), `GET ${target}`);
      assert.strictEqual(
        response.body,
        `{"name":"${payload.name}","version":"${payload.version}","timestamp":"${payload.timestamp}","status":"${payload.status}"}`,
      );
    });
  }

  test('an absolute-form request line naming this very authority is still a 404', async () => {
    // A request line may legally carry an absolute-form target, and Node's parser
    // accepts it and hands it to the handler unchanged. Honouring it would make the
    // endpoint answer under an authority the *caller* chose — including this one,
    // which is why the most sympathetic possible spelling is the one asserted here:
    // it is the health path, on the loopback address, on the very port that is
    // serving. It is still a second spelling of the one resource, so it is refused.
    const response = await rawRequest(boundPort, 'GET', `http://${LOOPBACK}:${boundPort}${HEALTH_PATH}`);

    assert.strictEqual(response.statusCode, 404, response.statusLine);
    assert.strictEqual(response.headers.get('content-type'), CONTENT_TYPE);
    assert.strictEqual(response.headers.get('cache-control'), CACHE_CONTROL);
    assert.strictEqual(response.body, NOT_FOUND_BODY);
  });

  for (const target of UNSERVED_TARGETS) {
    test(`GET ${target} answers the contract's 404 rather than the payload`, async () => {
      const response = await rawRequest(boundPort, 'GET', target);

      assert.strictEqual(response.statusCode, 404, `${target} must not be an alias for the served path`);
      assert.strictEqual(response.headers.get('content-type'), CONTENT_TYPE, 'the refusal must be machine-readable');
      assert.strictEqual(response.headers.get('cache-control'), CACHE_CONTROL);
      assert.strictEqual(response.headers.get('allow'), undefined, 'only a 405 carries Allow');
      assert.strictEqual(response.body, NOT_FOUND_BODY);
      assert.ok(!response.body.includes('"status"'), 'the refusal must not claim the application is healthy');
    });
  }

  test('HEAD on an alias is refused with the contract headers and no body', async () => {
    const response = await rawRequest(boundPort, 'HEAD', `${HEALTH_PATH}/`);

    assert.strictEqual(response.statusCode, 404);
    assert.strictEqual(response.headers.get('content-type'), CONTENT_TYPE);
    assert.strictEqual(response.body, '', 'a HEAD response must carry no body');
    assert.strictEqual(
      Number(response.headers.get('content-length')),
      Buffer.byteLength(NOT_FOUND_BODY, 'utf8'),
      'HEAD must still report the byte length the body would have had',
    );
  });

  test('the method is checked before the path, for an alias as much as for the resource', async () => {
    // A refused method against an alias must still be refused as a method: a caller
    // learns the most actionable fact first, and the answer does not depend on
    // whether the path it used happened to be a spelling of anything.
    for (const target of [HEALTH_PATH, '/%68ealth', '///health', '*']) {
      const response = await rawRequest(boundPort, 'POST', target);

      assert.strictEqual(response.statusCode, 405, `POST ${target} must be refused as a method`);
      assert.strictEqual(response.headers.get('allow'), ALLOW_HEADER);
      assert.strictEqual(response.body, METHOD_NOT_ALLOWED_BODY);
    }
  });

  test('every method the runtime admits other than GET and HEAD answers 405, never a 5xx', async () => {
    // The contract defines 200, 404 and 405 and the handler synthesises nothing
    // else: a 5xx would tell a poller the process is broken when it is not, which is
    // the one thing a liveness endpoint must never say. The list deliberately
    // includes methods well outside ordinary use — a health endpoint answers the
    // same way whatever is thrown at it.
    for (const method of REFUSED_METHODS) {
      const response = await rawRequest(boundPort, method, HEALTH_PATH);

      assert.strictEqual(response.statusCode, 405, `${method} must be refused as a method`);
      assert.strictEqual(response.headers.get('allow'), ALLOW_HEADER);
      assert.strictEqual(response.headers.get('content-type'), CONTENT_TYPE);
      assert.strictEqual(response.body, METHOD_NOT_ALLOWED_BODY);
      assert.ok(response.statusCode < 500, `${method} must never be answered with a server error`);
    }
  });

  test('a method token the runtime cannot parse is refused by the runtime, and never served', async () => {
    // A documented runtime boundary rather than a gap in the handler: Node's HTTP
    // parser validates the method token against its own table and answers a token it
    // does not recognise with `400 Bad Request` before any request listener is
    // entered, so the status code below is the runtime's rather than this
    // application's. What matters is asserted and holds: the endpoint is not served
    // through such a request, and the answer never claims the application is
    // healthy. There is no listener-level hook that could reach it.
    for (const token of UNPARSABLE_METHOD_TOKENS) {
      const response = await rawRequest(boundPort, token, HEALTH_PATH);

      assert.strictEqual(response.statusCode, 400, `${token} must be refused by the runtime`);
      assert.ok(!response.body.includes('"status"'), 'the refusal must not claim the application is healthy');
    }
  });

  test('a request target the runtime cannot parse is refused, and the listener survives it', async () => {
    // The second documented runtime boundary at this tier, and the mirror image of
    // the Java tier's: Node's parser rejects a target carrying a scheme, so these
    // four never reach the handler and the `400` below is the runtime's. The
    // assertions are therefore the two properties that hold at every tier — the
    // endpoint is not served through the spelling and no answer carries the payload
    // — plus the one that makes the boundary harmless: the listener is still
    // serving the real resource immediately afterwards, so a caller cannot use an
    // unparsable target to take the endpoint down.
    for (const target of RUNTIME_REFUSED_TARGETS) {
      const response = await rawRequest(boundPort, 'GET', target);

      assert.notStrictEqual(response.statusCode, 200, `${target} must not be served`);
      assert.ok(response.statusCode < 500, `${target} must not produce a server error`);
      assert.ok(!response.body.includes('"status"'), 'the refusal must not claim the application is healthy');

      const stillServing = await rawRequest(boundPort, 'GET', HEALTH_PATH);
      assert.strictEqual(stillServing.statusCode, 200, `the listener must survive ${target}`);
      assertContractPayload(JSON.parse(stillServing.body), `after ${target}`);
    }
  });
});

/*
 * ---------------------------------------------------------------------------
 * Group C.4 — the handler's defensive paths, invoked directly
 *
 * These branches exist so the request listener can never throw and can never
 * leave a client waiting on a socket that will never be answered, and none of
 * them is reachable through a client: Node's HTTP parser rejects a malformed
 * request line before any handler runs, and a response whose write fails is a
 * socket-level fault a test cannot provoke on demand. So `handleRequest` is
 * called directly with a recording response double — the shape `health.js`
 * documents as supported — and what it wrote is asserted.
 *
 * Without these assertions the "never throws" guarantee is a comment rather than
 * a property, and the recovery code could be deleted with every test still green.
 * ---------------------------------------------------------------------------
 */

describe('health.js — defensive request paths that a client cannot provoke', () => {
  test('an absent request target is answered 404, not an exception', () => {
    const { res, recorded } = createResponseDouble();

    health.handleRequest({ method: 'GET', url: undefined }, res);

    assert.strictEqual(recorded.statusCode, 404, 'a target that cannot be parsed is an unknown path');
    assert.strictEqual(recorded.headers['Content-Type'], CONTENT_TYPE);
    assert.strictEqual(recorded.headers['Cache-Control'], CACHE_CONTROL);
    assert.strictEqual(recorded.body.toString('utf8'), NOT_FOUND_BODY);
    assert.strictEqual(recorded.destroyed, false, 'the connection must be answered, not torn down');
  });

  test('an empty request target is answered 404 as well', () => {
    const { res, recorded } = createResponseDouble();

    health.handleRequest({ method: 'GET', url: '' }, res);

    assert.strictEqual(recorded.statusCode, 404);
    assert.strictEqual(recorded.body.toString('utf8'), NOT_FOUND_BODY);
  });

  test('an unparseable request target is answered 404 rather than escaping', () => {
    // `new URL('//', base)` throws: a protocol-relative target with an empty
    // authority is not a URL at all. The handler must classify it as an unknown
    // path, because the contract defines no 5xx and the handler does no work that
    // could justify one.
    const { res, recorded } = createResponseDouble();

    health.handleRequest({ method: 'GET', url: '//' }, res);

    assert.strictEqual(recorded.statusCode, 404);
    assert.strictEqual(recorded.body.toString('utf8'), NOT_FOUND_BODY);
    assert.strictEqual(recorded.endCalls, 1, 'exactly one response must be written');
  });

  test('a lowercase method token is still recognised as GET', () => {
    // Over the wire Node only ever surfaces canonical uppercase tokens, so this is
    // purely the documented defence for direct invocation — and it is a defence
    // only if something asserts it.
    const { res, recorded } = createResponseDouble();

    health.handleRequest({ method: 'get', url: HEALTH_PATH }, res);

    assert.strictEqual(recorded.statusCode, 200);
    assertContractPayload(JSON.parse(recorded.body.toString('utf8')), 'lowercase get');
  });

  test('a non-string method is rejected with 405 and the Allow header', () => {
    const { res, recorded } = createResponseDouble();

    health.handleRequest({ method: undefined, url: HEALTH_PATH }, res);

    assert.strictEqual(recorded.statusCode, 405);
    assert.strictEqual(recorded.headers.Allow, ALLOW_HEADER);
    assert.strictEqual(recorded.body.toString('utf8'), METHOD_NOT_ALLOWED_BODY);
  });

  test('HEAD on an unknown path returns 404 with no body but an accurate length', () => {
    const { res, recorded } = createResponseDouble();

    health.handleRequest({ method: 'HEAD', url: '/unknown' }, res);

    assert.strictEqual(recorded.statusCode, 404);
    assert.strictEqual(recorded.body, null, 'a HEAD response carries no body, on the error path too');
    assert.strictEqual(
      recorded.headers['Content-Length'],
      Buffer.byteLength(NOT_FOUND_BODY, 'utf8'),
      'HEAD must still report the byte length the body would have had',
    );
  });

  test('a response whose status line cannot be written is closed, never answered 404', () => {
    // Simulates a socket that died between routing and writing. Nothing may escape
    // the listener, and no status may be invented: the contract enumerates exactly
    // `200`, `405` and `404`, and a `404` in particular is a statement about the
    // client's request target — the target here was `/health`, which exists, so
    // blaming the caller for a fault inside this process sends an investigation the
    // wrong way. Closing the connection is the honest completion.
    const { res, recorded } = createResponseDouble({ failWriteHeadTimes: 1 });

    health.handleRequest({ method: 'GET', url: HEALTH_PATH }, res);

    assert.strictEqual(recorded.writeHeadCalls, 1, 'the failed write must not be retried with a second status');
    assert.strictEqual(recorded.statusCode, null, 'no status line reached the client');
    assert.strictEqual(recorded.body, null, 'no body reached the client either');
    assert.strictEqual(recorded.destroyed, true, 'the connection must be released');
  });

  test('a response that fails while writing the body is completed, not left hanging', () => {
    // The status line has already gone out, so a second response is impossible and a
    // 5xx cannot be synthesized. Ending the response is the whole of the correct
    // action: the client gets a terminated message instead of an open socket.
    const { res, recorded } = createResponseDouble({ failEndTimes: 1 });

    health.handleRequest({ method: 'GET', url: HEALTH_PATH }, res);

    assert.strictEqual(recorded.statusCode, 200, 'the status line was already sent and must not change');
    assert.strictEqual(recorded.endCalls, 2, 'the in-flight response must be ended after the failure');
    assert.strictEqual(recorded.destroyed, false, 'ending it is enough; the socket need not be torn down');
  });

  test('a response that had already completed is closed rather than written to again', () => {
    // Nothing can be added to a finished response, so the only remaining action is
    // to release the connection — which must happen without throwing.
    const { res, recorded } = createResponseDouble({ failEndTimes: 1, markEndedOnFailure: true });

    health.handleRequest({ method: 'GET', url: HEALTH_PATH }, res);

    assert.strictEqual(recorded.endCalls, 1, 'a completed response must not be ended twice');
    assert.strictEqual(recorded.destroyed, true, 'the connection must be released');
  });

  test('a wholly unusable response ends with the connection destroyed and nothing thrown', () => {
    // Every write fails, so there is no way to answer at all. The only correct
    // action left is to release the socket — and to do it without throwing, because
    // an escaping exception would crash the process a health endpoint exists to
    // report on.
    const { res, recorded } = createResponseDouble({ failWriteHeadTimes: Number.MAX_SAFE_INTEGER });

    health.handleRequest({ method: 'GET', url: HEALTH_PATH }, res);

    assert.strictEqual(recorded.endCalls, 0, 'nothing could be written, so nothing was ended');
    assert.strictEqual(recorded.destroyed, true, 'the connection must not be left hanging');
  });
});

/*
 * ---------------------------------------------------------------------------
 * Group F.3 — configuration source failure, and the literal fallbacks
 *
 * The documented precedence chain is environment variable, then configuration
 * file, then compiled-in literal. Group C.2 covers the first link; this group
 * covers the last, which is the one the contract insists on: the endpoint must
 * still serve a valid response when its configuration cannot be read at all,
 * because that is exactly the failure a health endpoint has to survive.
 *
 * Each case builds a private copy of the tier in a temporary directory under the
 * operating system's temporary root — never inside the working tree — where the
 * identity manifest and the serving configuration are missing, malformed, not
 * JSON objects, or carry members of the wrong type. `health.js` resolves both
 * sources from its own directory, so the copy reads the broken files and the real
 * ones are never touched. The final test proves that, byte-for-byte.
 *
 * One deliberate asymmetry, stated rather than hidden: the identity manifest is
 * never made *syntactically* invalid here. Node's own CommonJS loader reads the
 * nearest `package.json` before it will load any module in that directory and
 * rejects an unparseable one — or one whose `name` is not a string — with
 * `ERR_INVALID_PACKAGE_CONFIG`. That is a platform load failure, not a `health.js`
 * code path: no fallback in this file could ever run, because the file itself
 * could not be required. The parse-failure branch of `readJsonFile` is therefore
 * exercised through the serving configuration, which Node never reads, and the
 * manifest is exercised through the states Node does tolerate — absent, empty, or
 * carrying members of the wrong type or blank content.
 * ---------------------------------------------------------------------------
 */

describe('health.js — configuration source failure falls back to the literals', () => {
  /** @type {string[]} */
  const workspaces = [];
  /** @type {Buffer} */
  let manifestBytesBefore;
  /** @type {Buffer} */
  let servingBytesBefore;

  before(() => {
    // Captured first so the comparison in the last test is honest even if a case
    // fails part-way through.
    manifestBytesBefore = fs.readFileSync(MANIFEST_PATH_ON_DISK);
    servingBytesBefore = fs.readFileSync(SERVING_CONFIG_PATH_ON_DISK);
  });

  after(() => {
    for (const workspace of workspaces) {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
    workspaces.length = 0;
  });

  /** Build an isolated tier and register it for removal in the `after` hook. */
  const isolate = (files) => {
    const workspace = createIsolatedTier(files);
    workspaces.push(workspace);
    return workspace;
  };

  /** Assert that every resolved value is this tier's compiled-in literal. */
  const assertAllLiterals = (config, label) => {
    assert.strictEqual(config.name, TIER_NAME, `${label}: name falls back to the literal`);
    assert.strictEqual(config.version, TIER_VERSION, `${label}: version falls back to the literal`);
    assert.strictEqual(config.host, TIER_DEFAULT_HOST, `${label}: host falls back to the literal`);
    assert.strictEqual(config.port, TIER_DEFAULT_PORT, `${label}: port falls back to the literal`);
    assert.strictEqual(config.path, HEALTH_PATH, `${label}: path falls back to the literal`);
    assert.strictEqual(config.status, STATUS_LITERAL, `${label}: status falls back to the literal`);
  };

  test('with both sources absent, every value is the compiled-in literal', () => {
    const workspace = isolate({});
    const { config, payload } = loadIsolatedTier(workspace);

    assert.strictEqual(fs.existsSync(path.join(workspace, 'package.json')), false, 'the identity source must really be absent');
    assert.strictEqual(fs.existsSync(path.join(workspace, 'config', 'health.json')), false, 'the serving source must really be absent');

    assertAllLiterals(config, 'both sources absent');
    assertContractPayload(payload, 'both sources absent');
  });

  test('an empty identity manifest and a malformed serving file yield the literals', () => {
    // `{}` is a syntactically valid manifest with neither member present, and the
    // serving file is not JSON at all — the two halves of a source that exists but
    // cannot be used.
    const workspace = isolate({
      'package.json': '{}',
      'config/health.json': 'not json at all',
    });
    const { config, payload } = loadIsolatedTier(workspace);

    assertAllLiterals(config, 'empty manifest, malformed serving file');
    assertContractPayload(payload, 'empty manifest, malformed serving file');
  });

  test('a truncated serving document is a parse failure, not a partial configuration', () => {
    const workspace = isolate({ 'config/health.json': '{"host": "127.0.0.9", "port": 39' });
    const { config } = loadIsolatedTier(workspace);

    assert.strictEqual(config.host, TIER_DEFAULT_HOST, 'nothing may be salvaged from an unparseable document');
    assert.strictEqual(config.port, TIER_DEFAULT_PORT);
  });

  test('a JSON array is not a configuration object, so the literals win', () => {
    // An array would answer every member lookup with `undefined`, which must not be
    // mistaken for "configured": rejecting the whole document is what keeps a
    // wrong-shaped file from silently becoming an empty one.
    const workspace = isolate({ 'config/health.json': '["0.0.0.0", 3000]' });
    const { config } = loadIsolatedTier(workspace);

    assertAllLiterals(config, 'array serving document');
  });

  test('a JSON scalar or null serving document is rejected in favour of the literals', () => {
    const scalar = isolate({ 'config/health.json': '"0.0.0.0"' });
    assertAllLiterals(loadIsolatedTier(scalar).config, 'string serving document');

    const nulled = isolate({ 'config/health.json': 'null' });
    assertAllLiterals(loadIsolatedTier(nulled).config, 'null serving document');

    const numeric = isolate({ 'config/health.json': '3000' });
    assertAllLiterals(loadIsolatedTier(numeric).config, 'numeric serving document');
  });

  test('members of the wrong type or with blank content are skipped, member by member', () => {
    // The resolver degrades one value at a time rather than discarding the whole
    // document, so a single mistyped member cannot take the others down with it.
    const workspace = isolate({
      'package.json': JSON.stringify({ name: '   ', version: ['1.0.0'] }),
      'config/health.json': JSON.stringify({ host: '', port: 'not-a-port', path: 17, status: '   ' }),
    });
    const { config, payload } = loadIsolatedTier(workspace);

    assertAllLiterals(config, 'wrong-typed members');
    assertContractPayload(payload, 'wrong-typed members');
  });

  test('an out-of-range or fractional port is skipped in favour of the literal', () => {
    const workspace = isolate({
      'config/health.json': JSON.stringify({ port: 70000, host: 'configured.example' }),
    });
    const { config } = loadIsolatedTier(workspace);

    assert.strictEqual(config.port, TIER_DEFAULT_PORT, 'a port above 65535 is unusable');
    assert.strictEqual(config.host, 'configured.example', 'a usable member is still honoured beside an unusable one');
  });

  test('a configured path that is not the literal is rejected, not repaired', () => {
    // `health` is a plausible typo for `/health`, and guessing at the intent would
    // be the wrong repair: silently accepting a near-miss is how a tier ends up
    // serving under a spelling the contract never defined. The declaration is
    // refused, the literal is served, and the refusal is recorded.
    const workspace = isolate({
      'config/health.json': JSON.stringify({ path: 'health' }),
    });
    const { config, sources, conflicts } = loadIsolatedTier(workspace);

    assert.strictEqual(config.path, HEALTH_PATH);
    assert.strictEqual(sources.path, 'fallback');
    assert.deepStrictEqual(conflicts, [{ key: 'path', configured: 'health', frozen: HEALTH_PATH }]);
  });

  test('a byte-order mark does not stop a source being read', () => {
    // An editor-written UTF-8 file may carry a BOM, and `JSON.parse` rejects it.
    // Tolerating it is deliberate: it keeps a legitimately-authored configuration
    // file from silently degrading to the fallbacks.
    const workspace = isolate({
      'package.json': `\uFEFF${JSON.stringify({ name: 'bom_tier', version: '9.9.9' })}`,
      'config/health.json': `\uFEFF${JSON.stringify({ host: '127.0.0.2', port: 3999, path: '/health', status: 'UP' })}`,
    });
    const { config } = loadIsolatedTier(workspace);

    assert.strictEqual(config.name, 'bom_tier', 'a BOM-prefixed identity source must still be read');
    assert.strictEqual(config.version, '9.9.9');
    assert.strictEqual(config.host, '127.0.0.2');
    assert.strictEqual(config.port, 3999);
  });

  test('an environment override still wins over a broken configuration file', () => {
    // Precedence is not suspended by a failure further down the chain: the
    // environment is consulted first, whatever state the file is in.
    const workspace = isolate({ 'config/health.json': '{{{' });
    const { config } = loadIsolatedTier(workspace, { HOST: LOOPBACK, PORT: '3199' });

    assert.strictEqual(config.host, LOOPBACK);
    assert.strictEqual(config.port, 3199);
    assert.strictEqual(config.name, TIER_NAME, 'identity has no environment override at any tier');
    assert.strictEqual(
      config.status,
      STATUS_LITERAL,
      'status has no environment layer, so an unusable file leaves the literal',
    );
  });

  test('an unusable environment override falls through to the literal when no file remains', () => {
    const workspace = isolate({});
    const { config } = loadIsolatedTier(workspace, { HOST: '   ', PORT: '-1' });

    assert.strictEqual(config.host, TIER_DEFAULT_HOST, 'a blank override is an unset override');
    assert.strictEqual(config.port, TIER_DEFAULT_PORT, 'a negative port is unusable');
  });

  test('the repository’s own configuration sources are byte-for-byte untouched', () => {
    assert.deepStrictEqual(
      fs.readFileSync(MANIFEST_PATH_ON_DISK),
      manifestBytesBefore,
      'package.json must be unchanged by this suite',
    );
    assert.deepStrictEqual(
      fs.readFileSync(SERVING_CONFIG_PATH_ON_DISK),
      servingBytesBefore,
      'config/health.json must be unchanged by this suite',
    );

    // And the already-loaded module still reports the declared values, proving the
    // isolated copies never became the module under test.
    assert.strictEqual(health.config.name, manifest.name);
    assert.strictEqual(health.config.port, servingConfig.port);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Group H — `server.js`, the long-lived entry point
 *
 * Group C.3 serves the contract from a handler this suite binds itself, which is
 * the right way to assert the contract but says nothing about the entry point.
 * `server.js` owns bind-target resolution, the single announced start-up line,
 * the signal handlers, the orderly shutdown and the start-up diagnostics. It calls
 * `start()` at load and exports nothing, so a child process is the only honest way
 * to exercise it.
 *
 * Every child binds a port reserved by {@link reserveFreePort} on `HOST=127.0.0.1`:
 * never the tier's own 3000, because a test must not publish a service on the port an
 * operator expects to be the application, and never `PORT=0`, because a resolved
 * configuration port of `0` is rejected — an endpoint on a port the operating system
 * picked cannot be addressed by a fixed-number probe. Every wait is bounded, and
 * every child is signalled and awaited — the `after` hook escalates to `SIGKILL` — so
 * a failing assertion can never leave a process behind holding a port.
 * ---------------------------------------------------------------------------
 */

describe('server.js — the long-lived entry point', () => {
  /** @type {Array<ReturnType<typeof startServerProcess>>} */
  const processes = [];

  after(async () => {
    for (const managed of processes) {
      await managed.stop();
    }
    processes.length = 0;
  });

  /** Start a child and register it for unconditional teardown. */
  const start = (environmentOverrides) => {
    const managed = startServerProcess(environmentOverrides);
    processes.push(managed);
    return managed;
  };

  test('binds the requested host, announces the real port, and serves the contract there', async () => {
    const requested = await reserveFreePort();
    const managed = start({ HOST: LOOPBACK, PORT: String(requested) });
    const started = await managed.waitForStartup();

    assert.strictEqual(started.host, LOOPBACK, 'HOST must decide the interface that is bound');
    assert.strictEqual(
      started.port,
      requested,
      'the announced port must be the one PORT requested, read back from the bound listener',
    );
    assert.notStrictEqual(started.port, TIER_DEFAULT_PORT, 'the suite must never bind the tier port');
    assert.strictEqual(
      started.line,
      `health server listening on http://${LOOPBACK}:${started.port}${HEALTH_PATH}`,
      'the start-up line must be the single greppable statement of where the endpoint is',
    );
    assert.strictEqual(
      managed.stdout().trim().split('\n').length,
      1,
      'start-up must be exactly one line — the contract says one, and a log is read by people',
    );
    assert.strictEqual(managed.stderr(), '', 'a successful start writes nothing to standard error');

    const origin = `http://${LOOPBACK}:${started.port}`;
    const response = await request(`${origin}${HEALTH_PATH}`);
    const body = await response.text();

    assert.strictEqual(response.status, 200);
    assertContractHeaders(response, 'GET /health from server.js');
    assertContractPayload(JSON.parse(body), 'GET /health from server.js');

    const rejected = await request(`${origin}${HEALTH_PATH}`, { method: 'POST' });
    assert.strictEqual(rejected.status, 405, 'the entry point serves the same handler, negative paths included');
    assert.strictEqual(rejected.headers.get('allow'), ALLOW_HEADER);
    assert.strictEqual(await rejected.text(), METHOD_NOT_ALLOWED_BODY);

    const unknown = await request(`${origin}/unknown`);
    assert.strictEqual(unknown.status, 404);
    assert.strictEqual(await unknown.text(), NOT_FOUND_BODY);
  });

  test('SIGTERM closes the listener promptly, exits 0, and releases the port', async () => {
    const managed = start({ HOST: LOOPBACK, PORT: String(await reserveFreePort()) });
    const started = await managed.waitForStartup();

    // A probe first, so a keep-alive socket is left behind on purpose: that idle
    // connection is what `closeIdleConnections` exists for, and without it the
    // close would wait out the keep-alive timeout and the port would linger —
    // exactly the orphaned binding that makes the next start-up fail.
    const probe = await request(`http://${LOOPBACK}:${started.port}${HEALTH_PATH}`);
    assert.strictEqual(probe.status, 200);
    await probe.text();

    const signalled = Date.now();
    managed.child.kill('SIGTERM');
    const exit = await managed.waitForExit();

    assert.strictEqual(exit.code, 0, 'a shutdown that was requested is a success, not a failure');
    assert.strictEqual(exit.signal, null, 'the process must exit on its own, never die on the signal');
    assert.ok(
      Date.now() - signalled < SHUTDOWN_TIMEOUT_MS,
      `shutdown must complete well inside the grace timer, not depend on it (took ${Date.now() - signalled}ms)`,
    );
    assert.match(
      managed.stdout(),
      /^health server received SIGTERM, closing listener$/m,
      'the shutdown must be announced, naming the signal that caused it',
    );
    assert.strictEqual(managed.stderr(), '', 'an orderly shutdown is not an error condition');

    assert.strictEqual(
      await waitForPortRelease(started.port),
      'ECONNREFUSED',
      'the listening socket must be released, not merely stop answering',
    );
  });

  test('SIGINT is handled identically — Ctrl-C is an orderly stop too', async () => {
    const managed = start({ HOST: LOOPBACK, PORT: String(await reserveFreePort()) });
    const started = await managed.waitForStartup();

    managed.child.kill('SIGINT');
    const exit = await managed.waitForExit();

    assert.strictEqual(exit.code, 0);
    assert.strictEqual(exit.signal, null);
    assert.match(managed.stdout(), /^health server received SIGINT, closing listener$/m);
    assert.strictEqual(await waitForPortRelease(started.port), 'ECONNREFUSED');
  });

  test('a repeated signal cannot start a second shutdown or a second log line', async () => {
    const managed = start({ HOST: LOOPBACK, PORT: String(await reserveFreePort()) });
    await managed.waitForStartup();

    managed.child.kill('SIGTERM');
    managed.child.kill('SIGTERM');
    const exit = await managed.waitForExit();

    assert.strictEqual(exit.code, 0);
    const shutdownLines = managed.stdout().split('\n').filter((line) => line.includes('received'));
    assert.strictEqual(shutdownLines.length, 1, 'shutdown must be idempotent — a repeated Ctrl-C changes nothing');
  });

  test('an occupied port fails fast with an actionable diagnostic and exit 1', async () => {
    // A silent hang on a taken port is among the worst start-up failure modes there
    // is: readiness polling times out and nothing in the log says why. The
    // requirement is therefore both the non-zero status and the message.
    const occupied = await occupyEphemeralPort();

    try {
      const managed = start({ HOST: LOOPBACK, PORT: String(occupied.port) });
      const exit = await managed.waitForExit();

      assert.strictEqual(exit.code, 1, 'a listener that could not be bound must not report success');
      assert.strictEqual(managed.stdout(), '', 'nothing may be announced when nothing was bound');

      const diagnostic = managed.stderr();
      assert.match(diagnostic, /health server cannot start:/, 'the failure must name itself');
      assert.match(
        diagnostic,
        new RegExp(`${LOOPBACK}:${occupied.port} is already in use`),
        'the diagnostic must name the address that could not be taken',
      );
      assert.match(diagnostic, /PORT=<port> node server\.js/, 'the diagnostic must state the remedy');
      assert.doesNotMatch(diagnostic, /at Server\./, 'a stack trace would bury the one fact that matters');
    } finally {
      await new Promise((resolve) => occupied.server.close(resolve));
    }
  });

  test('with HOST unset, the host from the configuration file is the one attempted', async () => {
    // The entry point resolves its bind target through the same chain as the
    // payload, so with the environment cleared it must attempt what
    // `config/health.json` declares. The assertion is made on the diagnostic of a
    // deliberately failing bind rather than on a successful one, because a
    // successful bind here would publish a listener on every interface — which a
    // test must never do. Occupying the port on the loopback is enough to make the
    // wildcard bind fail: a wildcard listener cannot coexist with a specific-address
    // listener on the same port.
    const occupied = await occupyEphemeralPort();

    try {
      const managed = start({ HOST: null, PORT: String(occupied.port) });
      const exit = await managed.waitForExit();

      assert.strictEqual(
        exit.code,
        1,
        `the bind had to fail for this assertion to mean anything; the child announced: ${JSON.stringify(managed.stdout())}`,
      );
      assert.match(
        managed.stderr(),
        new RegExp(`${TIER_DEFAULT_HOST}:${occupied.port} is already in use`),
        'with HOST unset the configured host must be the one attempted',
      );
    } finally {
      await new Promise((resolve) => occupied.server.close(resolve));
    }
  });

  test('an unusable PORT degrades to the configured port instead of refusing to resolve', async () => {
    // A typo in one source must degrade to the next source, never leave the listener
    // unbindable. The host is deliberately an address this machine does not own, so
    // the resolved port is observable in the diagnostic without ever binding port
    // 3000 — the port an operator expects to be the real application.
    const managed = start({ HOST: '192.0.2.1', PORT: 'not-a-port' });
    const exit = await managed.waitForExit();

    assert.strictEqual(exit.code, 1);
    assert.match(
      managed.stderr(),
      new RegExp(`192\\.0\\.2\\.1 is not an address of any local interface`),
      'an unusable PORT must not stop resolution reaching a bind attempt',
    );
    assert.strictEqual(
      managed.stdout(),
      '',
      'nothing may be announced when nothing was bound',
    );
  });

  test('an out-of-range PORT is rejected in favour of the configured port', async () => {
    const managed = start({ HOST: '192.0.2.1', PORT: '70000' });
    const exit = await managed.waitForExit();

    assert.strictEqual(exit.code, 1);
    assert.match(managed.stderr(), /health server cannot start: 192\.0\.2\.1 is not an address/);
  });

  test('an address this host does not own is reported as such, not as a stack trace', async () => {
    // 192.0.2.0/24 is the reserved TEST-NET-1 documentation range, so it is
    // guaranteed not to be an address of any local interface: the bind fails with a
    // different errno than a taken port, and each errno has to produce its own
    // sentence naming the defect and the remedy.
    const managed = start({ HOST: '192.0.2.1', PORT: String(await reserveFreePort()) });
    const exit = await managed.waitForExit();

    assert.strictEqual(exit.code, 1);
    assert.strictEqual(managed.stdout(), '');
    assert.match(managed.stderr(), /health server cannot start: 192\.0\.2\.1 is not an address of any local interface/);
    assert.match(managed.stderr(), /0\.0\.0\.0 for every interface/, 'the remedy must be stated, not implied');
    assert.doesNotMatch(managed.stderr(), /at Server\./, 'a stack trace would bury the one fact that matters');
  });
});
