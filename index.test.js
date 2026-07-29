'use strict';

/**
 * Level 1 (apex) unit suite — `parent_repo_10_LOC`, JavaScript, port 3000.
 *
 * This is one of the first three test files in this composition's history: no
 * test artifact of any kind had ever existed in any commit of any branch of any
 * of the three repositories before this feature. The suite exists because the
 * feature requires a pipeline that *validates* the `/health` endpoint, and
 * validation without assertions is not validation.
 *
 * The file name is load-bearing. `node --test`, invoked with no arguments and no
 * configuration, discovers `*.test.js` by default, so `index.test.js` at the tier
 * root is picked up with zero setup and zero dependencies. Renaming it, moving it
 * into a `tests/` directory or switching to `.spec.js` would silently remove it
 * from the default run.
 *
 * What is asserted, and why each group is here:
 *
 *   A. **Preserved behavior.** `add` still returns `12` for `(5, 7)` and is now
 *      reachable as an export. Before this feature `Object.keys(require('./index.js'))`
 *      was `[]` and `typeof m.add` was `undefined`, so this group is what locks in
 *      the new export surface rather than merely restating arithmetic.
 *   B. **Non-regression, measured rather than intended.** Importing `index.js` must
 *      write nothing (previously a bare require printed `12` five times), and
 *      running it directly must still emit exactly the historical five lines and
 *      fifteen bytes whose md5 is `b07373a80ad21069e41be538e6506d00`. Both are
 *      checked in a real child process, because `require`'s module cache makes any
 *      in-process check of load-time output unreliable and monkey-patching
 *      `console.log` would test the patch rather than the program.
 *   C. **The frozen `/health` contract**, first against the payload builder in
 *      isolation and then over a real TCP socket: status line, both contract
 *      headers, exactly four body members in a fixed order, the literal `UP`, an
 *      RFC 3339 UTC timestamp that is provably fresh, compact serialization, and
 *      the two negative paths (`405` with `Allow: GET, HEAD`, and `404`).
 *
 * The contract asserted here is defined normatively in `docs/health-endpoint.md`
 * and implemented in `health.js`. That document is documentation only — it is
 * never read, parsed or imported at run time, by this file or any other.
 *
 * Design constraints this file honors, each for a concrete reason:
 *
 *   - **Standard library only.** `node:test`, `node:assert/strict`, `node:crypto`,
 *     `node:child_process` and `node:path` are the only external modules required,
 *     and the built-in global `fetch` is the HTTP client. The composition's
 *     third-party dependency count is zero and this suite keeps it there: no test
 *     runner, no assertion library, no HTTP client package, no coverage package.
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
 *     the real port is read back from `server.address().port`. Port 3000 belongs
 *     to the long-lived `server.js` process, which the pipeline starts in the same
 *     job, so binding it here would make the suite and the pipeline race for it.
 *   - **Leaves nothing running.** Every server is closed in an `after` hook, and
 *     idle keep-alive sockets are destroyed explicitly, so the process exits on its
 *     own and no port stays bound. Nothing is written to disk.
 *
 * Run it with `node --test`, `node --test index.test.js`, or `npm test`.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { add } = require('./index.js');
const health = require('./health.js');
const manifest = require('./package.json');
const servingConfig = require('./config/health.json');

/*
 * ---------------------------------------------------------------------------
 * The contract, expressed once as literals.
 *
 * These are deliberately hard-coded rather than read back from the module under
 * test. A test that sources its expected values from its subject asserts only
 * self-consistency: it passes whether the subject is right or wrong. Every value
 * below is the independent, normative expectation from `docs/health-endpoint.md`,
 * so a drift in either direction is a failure with a named cause.
 * ---------------------------------------------------------------------------
 */

/** This tier's declared application identity — the `name` member of the payload. */
const TIER_NAME = 'parent_repo_10_LOC';

/** This tier's declared version — the first version identity in the composition's history. */
const TIER_VERSION = '1.0.0';

/** The tier's default port. Asserted as a *declaration*, never bound by this suite. */
const TIER_DEFAULT_PORT = 3000;

/** The tier's declared bind address. `0.0.0.0` is a bind address only, never a destination. */
const TIER_DEFAULT_HOST = '0.0.0.0';

/** The health resource path. */
const HEALTH_PATH = '/health';

/** The literal healthy status value. */
const STATUS_LITERAL = 'UP';

/** Contract content type, asserted byte for byte including the charset parameter. */
const CONTENT_TYPE = 'application/json; charset=utf-8';

/** Contract cache directive: a poller must never be served a cached answer. */
const CACHE_CONTROL = 'no-store';

/** `Allow` header value on a `405`: uppercase methods, one comma, one space. */
const ALLOW_HEADER = 'GET, HEAD';

/** The four payload members, in the frozen order. Both count and order are asserted. */
const PAYLOAD_KEYS = Object.freeze(['name', 'version', 'timestamp', 'status']);

/** RFC 3339 UTC, `Z` suffix, exactly three fractional digits. */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Body returned for any path other than the health resource. */
const NOT_FOUND_BODY = '{"error":"Not Found"}';

/** Body returned for any method other than `GET` or `HEAD`. */
const METHOD_NOT_ALLOWED_BODY = '{"error":"Method Not Allowed"}';

/** The historical standard output of `node index.js`: five lines, fifteen bytes. */
const GOLDEN_STDOUT = '12\n12\n12\n12\n12\n';

/** Byte length of {@link GOLDEN_STDOUT}, asserted on the raw buffer rather than a string. */
const GOLDEN_STDOUT_BYTES = 15;

/** Line count of {@link GOLDEN_STDOUT}. */
const GOLDEN_STDOUT_LINES = 5;

/**
 * md5 of the standard output of `node index.js`. This digest means exactly that
 * and nothing else, and it is the permanent regression gate for the user's
 * "preserve the existing functionality" requirement.
 */
const GOLDEN_STDOUT_MD5 = 'b07373a80ad21069e41be538e6506d00';

/** Absolute path to the program under test, so the suite never depends on the CWD. */
const INDEX_PATH = path.join(__dirname, 'index.js');

/** Loopback interface. A probe asserts the state of *this* process, so it addresses `127.0.0.1`. */
const LOOPBACK = '127.0.0.1';

/** Port `0` asks the operating system for an ephemeral port. */
const EPHEMERAL_PORT = 0;

/**
 * Upper bound on a child process, so a hung child fails the run with a clear
 * timeout instead of stalling the pipeline indefinitely. Every child spawned here
 * exits in a few tens of milliseconds; this bound exists only to fail safely.
 */
const CHILD_TIMEOUT_MS = 30000;

/**
 * Deliberate wait used by the two freshness assertions.
 *
 * `timestamp` has millisecond precision, so two calls inside the same millisecond
 * would legitimately produce the same string. Waiting past a millisecond boundary
 * is the correct fix; weakening the assertion to "differ or equal" would delete
 * the very property being tested — that a frozen process cannot masquerade as a
 * healthy one by serving a stale payload.
 */
const CLOCK_ADVANCE_MS = 8;

/*
 * ---------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------
 */

/**
 * Wait for real time to pass so the millisecond clock advances.
 *
 * Uses the global `setTimeout`, whose timer is cleared when it fires, so nothing
 * is left pending that could keep the process alive after the suite finishes.
 *
 * @param {number} ms Milliseconds to wait.
 * @returns {Promise<void>} Resolves once the delay has elapsed.
 */
function advanceClock(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
 *
 * @param {ReadonlyArray<string>} args Arguments passed to the Node executable.
 * @param {Object<string, string>} [environmentOverrides] Variables layered over the
 *   inherited environment, used to exercise the documented `HOST` and `PORT`
 *   overrides in isolation. Layering rather than replacing keeps the child able to
 *   resolve its own runtime.
 * @returns {import('node:child_process').SpawnSyncReturns<Buffer>} The completed result.
 */
function runNode(args, environmentOverrides = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: __dirname,
    timeout: CHILD_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...environmentOverrides },
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
 *
 * @param {Buffer} buffer Bytes to digest.
 * @returns {string} Lowercase hex digest.
 */
function md5(buffer) {
  return createHash('md5').update(buffer).digest('hex');
}

/**
 * Assert that a value satisfies the frozen payload contract in full.
 *
 * Shared by the in-process payload group and the over-the-wire HTTP group so that
 * both hold the response to exactly one definition of correct — a contract
 * asserted two slightly different ways is two contracts.
 *
 * @param {unknown} payload The parsed payload.
 * @param {string} label Context included in every failure message.
 * @returns {{name: string, version: string, timestamp: string, status: string}} The payload, narrowed.
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
 *
 * @param {Response} response The response to inspect.
 * @param {string} label Context included in every failure message.
 * @returns {void}
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
 *
 * @returns {Promise<{server: import('node:http').Server, origin: string, port: number}>}
 *   The listening server, its origin for building request URLs, and its real port.
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
 *
 * @param {import('node:http').Server|null} server The server to close.
 * @returns {Promise<void>} Resolves once the port is released.
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

/*
 * ---------------------------------------------------------------------------
 * Group A — the preserved program and its new export surface
 * ---------------------------------------------------------------------------
 */

describe('index.js — preserved arithmetic and the new export surface', () => {
  test('exposes exactly one member, the add function', () => {
    const moduleSurface = require('./index.js');

    // Before this feature the export surface was empty, so `add` was unreachable
    // and a test of it failed with "add is not a function". Asserting the whole
    // key list, not merely that `add` exists, also pins the surface closed: the
    // guarded emission must stay a side effect of direct invocation and never
    // leak out as an export.
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

/*
 * ---------------------------------------------------------------------------
 * Group B — non-regression, measured in a real child process
 * ---------------------------------------------------------------------------
 */

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

/*
 * ---------------------------------------------------------------------------
 * Group C.1 — the payload contract, asserted without opening a socket
 * ---------------------------------------------------------------------------
 */

describe('health.js — the /health payload contract', () => {
  test('exposes the documented public surface', () => {
    assert.strictEqual(typeof health.buildHealthPayload, 'function');
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

  test('status is the literal UP, single-sourced from the serving configuration', () => {
    const payload = health.buildHealthPayload();

    assert.strictEqual(payload.status, STATUS_LITERAL);
    assert.strictEqual(payload.status, servingConfig.status);
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

  test('two payloads differ in timestamp and agree on every other member', async () => {
    const first = health.buildHealthPayload();
    // A deliberate wait past a millisecond boundary, because the timestamp's
    // precision is milliseconds and two calls in the same one would legitimately
    // match. This is the fix for that; weakening the assertion is not.
    await advanceClock(CLOCK_ADVANCE_MS);
    const second = health.buildHealthPayload();

    assertContractPayload(first, 'first payload');
    assertContractPayload(second, 'second payload');

    assert.notStrictEqual(
      second.timestamp,
      first.timestamp,
      'the timestamp must be evaluated per call, never captured at start-up',
    );
    assert.ok(
      Date.parse(second.timestamp) > Date.parse(first.timestamp),
      'the later call must carry the later instant',
    );

    assert.strictEqual(second.name, first.name);
    assert.strictEqual(second.version, first.version);
    assert.strictEqual(second.status, first.status);
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
    assert.strictEqual(health.config.status, STATUS_LITERAL);
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
 * ---------------------------------------------------------------------------
 * Group C.2 — the documented configuration precedence
 *
 * These run in child processes because the resolution happens once, at module
 * load: changing `process.env` inside this already-loaded process would prove
 * nothing. They exercise the chain that makes every payload and serving value
 * traceable to a declared source, and they are the reason the assertions above
 * pin the *declared* defaults rather than the effective ones — an operator who
 * exports `PORT` is using a documented feature, not breaking the suite.
 *
 * Nothing here binds a socket: requiring the module resolves configuration and
 * returns.
 * ---------------------------------------------------------------------------
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
    // environment variable may change what the payload claims to be.
    assert.strictEqual(config.name, TIER_NAME);
    assert.strictEqual(config.version, TIER_VERSION);
    assert.strictEqual(config.status, STATUS_LITERAL);
    assert.strictEqual(config.path, HEALTH_PATH);
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
});

/*
 * ---------------------------------------------------------------------------
 * Group C.3 — the same contract over a real TCP socket
 *
 * One server serves the whole group: the handler is stateless, so a fresh
 * listener per assertion would only add bind churn. The `after` hook is what
 * guarantees the port is released even when an assertion fails.
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
    const response = await fetch(`${origin}${HEALTH_PATH}`);
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

  test('GET /health?x=1 is identical in every respect — the query string is ignored', async () => {
    const response = await fetch(`${origin}${HEALTH_PATH}?x=1`);
    const payload = assertContractPayload(await response.json(), 'GET /health?x=1');

    assert.strictEqual(response.status, 200);
    assertContractHeaders(response, 'GET /health?x=1');
    assert.strictEqual(payload.status, STATUS_LITERAL);
  });

  test('HEAD /health returns 200 with the contract headers and no body', async () => {
    // The Content-Length a GET would have produced, measured rather than assumed,
    // so the HEAD comparison is against the real payload size.
    const getResponse = await fetch(`${origin}${HEALTH_PATH}`);
    const getBodyBytes = Buffer.byteLength(await getResponse.text(), 'utf8');

    const response = await fetch(`${origin}${HEALTH_PATH}`, { method: 'HEAD' });
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
    const response = await fetch(`${origin}${HEALTH_PATH}`, { method: 'POST' });
    const body = await response.text();

    assert.strictEqual(response.status, 405);
    assert.strictEqual(response.headers.get('allow'), ALLOW_HEADER);
    assertContractHeaders(response, 'POST /health');
    assert.strictEqual(body, METHOD_NOT_ALLOWED_BODY);
  });

  test('DELETE /health returns 405 as well — only GET and HEAD are accepted', async () => {
    const response = await fetch(`${origin}${HEALTH_PATH}`, { method: 'DELETE' });
    const body = await response.text();

    assert.strictEqual(response.status, 405);
    assert.strictEqual(response.headers.get('allow'), ALLOW_HEADER);
    assert.strictEqual(body, METHOD_NOT_ALLOWED_BODY);
  });

  test('GET on an unknown path returns 404 with the small JSON error body', async () => {
    const response = await fetch(`${origin}/unknown`);
    const body = await response.text();

    assert.strictEqual(response.status, 404);
    assertContractHeaders(response, 'GET /unknown');
    assert.strictEqual(response.headers.get('allow'), null, 'only a 405 carries Allow');
    assert.strictEqual(body, NOT_FOUND_BODY);
    assert.deepStrictEqual(JSON.parse(body), { error: 'Not Found' });
  });

  test('GET /health/ returns 404 — the path comparison is exact', async () => {
    const response = await fetch(`${origin}${HEALTH_PATH}/`);
    const body = await response.text();

    assert.strictEqual(response.status, 404, 'a trailing slash is not normalized away');
    assert.strictEqual(body, NOT_FOUND_BODY);
  });

  test('POST on an unknown path returns 405 — the method is checked before the path', async () => {
    const response = await fetch(`${origin}/unknown`, { method: 'POST' });
    const body = await response.text();

    assert.strictEqual(response.status, 405, 'the request must never reach the path comparison');
    assert.strictEqual(response.headers.get('allow'), ALLOW_HEADER);
    assert.strictEqual(body, METHOD_NOT_ALLOWED_BODY);
  });

  test('two successive responses differ in timestamp and agree on every other member', async () => {
    const first = assertContractPayload(await (await fetch(`${origin}${HEALTH_PATH}`)).json(), 'first response');
    await advanceClock(CLOCK_ADVANCE_MS);
    const second = assertContractPayload(await (await fetch(`${origin}${HEALTH_PATH}`)).json(), 'second response');

    // Proof of liveness rather than of mere reachability: a process frozen after
    // binding its socket could otherwise keep serving a well-formed stale payload.
    assert.notStrictEqual(second.timestamp, first.timestamp);
    assert.ok(Date.parse(second.timestamp) > Date.parse(first.timestamp));

    assert.strictEqual(second.name, first.name);
    assert.strictEqual(second.version, first.version);
    assert.strictEqual(second.status, first.status);
  });
});
