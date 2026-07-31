/**
 * Hand-run `node:test` suite for this application's health endpoint.
 *
 * Two properties are proved here. The first is that the application still does
 * what it always did: `add(5, 7)` is asserted for the first time in this
 * repository's history, which only became possible once index.js gained an
 * export surface and moved its five writes behind a main-module guard. The
 * second is that `GET /health` honours the response contract shared by all
 * three applications of this composition -- the four-field document, the three
 * mandated headers, `HEAD`, and the fixed error envelopes.
 *
 * Only what the runtime already ships is used: `node:test` and
 * `node:assert/strict` for the harness, the global `fetch` for the client, and
 * `node:net` for the assertions no HTTP client can make -- proving that a
 * `HEAD` reply really put zero bytes on the wire, and that the answer to an
 * unrecognised verb is correct at the byte level, since Node's parser refuses
 * such a request before any response object exists and it is therefore written
 * straight to the socket. Nothing is installed, no runner configuration exists,
 * and this repository keeps its zero-dependency posture. Discovery is left to
 * the defaults, which is why this file is named index.test.js and sits beside
 * index.js:
 *
 *     node --test          # from this directory: 5 tests, 5 pass, 0 fail
 *     npm test             # the same suite, through package.json
 *
 * Every server under test is bound on port 0, so the operating system hands out
 * an ephemeral port. That is what lets the suite run beside an already-running
 * `node index.js --serve` on 3000, and beside the sibling suites at the other
 * two levels of the composition, without ever colliding on a port. Nothing here
 * reads or writes an environment variable, so a run never depends on the shell
 * that started it, and nothing here calls `startServer()`, which would read
 * PORT and HOST, print a banner and install signal handlers.
 *
 * Expected values are spelled out as literals below rather than read back from
 * index.js. Asserting the published contract instead of mirroring the
 * implementation is what lets this suite catch a change made on either side of
 * it, and it is what keeps the three independent implementations of the same
 * four-field payload -- one per level, because the three repositories share no
 * code -- from drifting apart unnoticed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const pkg = require('./package.json');
const app = require('./index.js');

// The contract's timestamp grammar: RFC 3339, UTC, second precision, Z-suffixed.
// No milliseconds, no microseconds and no `+00:00` offset are permitted.
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

// The route, and the name and version the endpoint must report. The name is this
// repository's own; the version is the seed value every level of the composition
// carries.
const HEALTH_PATH = '/health';
const EXPECTED_NAME = 'parent_repo_10_LOC';
const EXPECTED_VERSION = '1.0.0';

// The healthy status value, spelled as the IETF health-check draft accepts it.
const EXPECTED_STATUS = 'UP';

// The document's keys, in the order the wire contract fixes them. JSON.stringify
// follows insertion order, so that order reaches the wire and is assertable.
const EXPECTED_KEYS = ['name', 'version', 'timestamp', 'status'];

// The only media type the endpoint may serve -- never `text/html`.
const EXPECTED_MEDIA_TYPE = 'application/json';

// A liveness answer carries a per-request timestamp, so it must never be cached.
const EXPECTED_CACHE_CONTROL = 'no-store';

// The `Allow` header of a 405 response. The `, ` spacing is part of the contract,
// because all three implementations of this composition emit the identical value.
const EXPECTED_ALLOW = 'GET, HEAD';

// The port the application binds when it is started without PORT set. Asserted
// only to prove that this suite is *not* using it.
const EXPECTED_DEFAULT_PORT = 3000;

// The fixed error bodies. Neither may ever grow to include the path that was
// asked for or the method that was used.
const NOT_FOUND_BODY = '{"error":"Not Found"}';
const METHOD_NOT_ALLOWED_BODY = '{"error":"Method Not Allowed"}';

// Methods the endpoint must refuse. POST, OPTIONS and DELETE are recognised by
// Node's parser and so reach the router; `FOO` is invented on purpose, because an
// unrecognised verb is refused before a request object exists and is therefore
// answered on an entirely different code path. Both paths owe the same envelope.
const REJECTED_METHODS = ['POST', 'OPTIONS', 'DELETE', 'FOO'];

// Paths that must not be mistaken for the route: a trailing slash, a different
// case, a percent-encoded spelling, a doubled separator and an encoded space. The
// comparison is exact, so every one of these is a 404.
const NON_ROUTES = ['/nope', '/health/', '/HEALTH', '/%68ealth', '//health'];

// The address every server under test is bound to. Port 0 is deliberate: the
// operating system assigns an ephemeral port, and the port actually assigned is
// read back from the bound server rather than assumed.
const LOOPBACK_HOST = '127.0.0.1';
const EPHEMERAL_PORT = 0;

// Every raw exchange is bounded, so a hung endpoint fails a test instead of
// stalling the whole run.
const EXCHANGE_TIMEOUT_MS = 5000;

// The head of an HTTP message ends at the first CRLF pair; everything after it is
// body, which is what makes a byte count of the body possible.
const HEAD_TERMINATOR = '\r\n\r\n';

// Binds a server the way only a test can: port 0 means "any free port", so a run
// never competes with a developer's own server on the default port. The port
// actually assigned is read back from the bound server rather than assumed.
function listen(server) {
  return new Promise(function (resolve, reject) {
    server.once('error', reject);
    server.listen(EPHEMERAL_PORT, LOOPBACK_HOST, function () {
      // The bind succeeded, so a later error must not reject a settled promise.
      server.removeListener('error', reject);
      const address = server.address();
      resolve({
        host: address.address,
        port: address.port,
        base: `http://${address.address}:${address.port}`
      });
    });
  });
}

function close(server) {
  return new Promise(function (resolve, reject) {
    server.close(function (error) {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

// Binds one server from the exported factory, hands the test its address, and
// closes it whatever the test does. The `finally` is load-bearing: a failed
// assertion throws, and without it the listener would outlive the test and keep
// the run from ever exiting on its own.
async function withServer(exercise) {
  const server = app.createServer();
  const address = await listen(server);
  try {
    await exercise(address, server);
  } finally {
    // An idle connection is released first: close() would otherwise wait for it,
    // so a client that has been answered but not yet reaped could delay the exit.
    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }
    await close(server);
  }
}

// Speaks one HTTP/1.1 exchange straight over TCP and splits the reply at the
// first CRLF pair, so the caller can count the bytes that genuinely followed the
// header terminator. No HTTP client can make that count: every one of them knows
// a HEAD response carries no body and stops reading at the terminator, so a
// server that wrongly wrote one would still read back as empty. `Connection:
// close` lets the whole reply be read to EOF without first trusting
// Content-Length -- the very header under test.
function rawExchange(address, requestLine) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    const socket = net.createConnection({ host: address.host, port: address.port });
    socket.setTimeout(EXCHANGE_TIMEOUT_MS, function () {
      socket.destroy(new Error(`[${requestLine}] went unanswered for `
        + `${EXCHANGE_TIMEOUT_MS} ms`));
    });
    socket.on('error', reject);
    socket.on('data', function (chunk) {
      chunks.push(chunk);
    });
    socket.on('end', function () {
      const reply = Buffer.concat(chunks);
      const terminator = reply.indexOf(HEAD_TERMINATOR);
      if (terminator < 0) {
        reject(new Error(`the reply to [${requestLine}] never terminated its head`));
        return;
      }
      resolve({
        // latin1 so each byte maps to exactly one character: a head is inspected
        // as bytes rather than decoded, and the body is measured in bytes below.
        head: reply.toString('latin1', 0, terminator),
        body: reply.subarray(terminator + HEAD_TERMINATOR.length)
      });
    });
    socket.on('connect', function () {
      socket.end(`${requestLine} HTTP/1.1\r\nHost: ${address.host}:${address.port}\r\n`
        + 'Connection: close\r\n\r\n');
    });
  });
}

// Every header is read through this, always by a lower-case name. RFC 9110 makes
// field names case-insensitive, and the sibling Java implementation legitimately
// spells these very fields `Content-type` and `Cache-control`, so no assertion in
// this file may depend on the casing a runtime happens to choose. A missing field
// reads back as the empty string, so it fails an assertion with a readable diff
// instead of comparing against null.
function headerValue(response, name) {
  const value = response.headers.get(name);
  return value === null ? '' : value;
}

// Sends one request and returns its status, its headers and its body as the exact
// text that arrived, so every assertion below works from the same single read.
async function request(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  return { response, text };
}

test('the pre-existing addition capability is exported and still returns 12',
  function () {
    // The module's only pre-feature behaviour, and the mechanical guarantee that
    // adding an endpoint preserved it. This could not be asserted at all until
    // index.js gained an export surface: requiring it used to yield {} -- and to
    // print five lines as a side effect -- so no test could ever reach `add`.
    assert.equal(typeof app.add, 'function');
    // The exact call the default program makes, and the value it prints five
    // times. `node index.js` must keep emitting those five lines unchanged, which
    // is why nothing in this suite runs the module as a program.
    assert.equal(app.add(5, 7), 12);
    // Two further pairs, so the function is still computing from its arguments
    // rather than returning the constant the default program happens to print.
    assert.equal(app.add(0, 0), 0);
    assert.equal(app.add(-2, 5), 3);
  });

test('GET /health responds 200 with the four-field health document',
  async function () {
    await withServer(async function (address) {
      // Port 0 was asked for and something else was assigned: proof that
      // createServer() really did hand back an unbound server, and that this
      // suite is not quietly competing for the port the application defaults to.
      assert.ok(address.port > 0, `no ephemeral port was assigned: ${address.port}`);
      assert.notEqual(address.port, app.DEFAULT_PORT);
      assert.equal(app.DEFAULT_PORT, EXPECTED_DEFAULT_PORT);
      // The application's own default bind address is the loopback interface, so
      // an operator has to opt in before the endpoint is reachable off-host.
      assert.equal(app.DEFAULT_HOST, LOOPBACK_HOST);
      assert.equal(address.host, LOOPBACK_HOST);
      // The route is addressed through the exported constant, and the constant is
      // pinned to the contract's literal, so the two can never drift apart.
      assert.equal(app.HEALTH_PATH, HEALTH_PATH);

      const { response, text } = await request(address.base + app.HEALTH_PATH);

      assert.equal(response.status, 200);
      assert.equal(headerValue(response, 'content-type'), EXPECTED_MEDIA_TYPE);
      assert.equal(headerValue(response, 'cache-control'), EXPECTED_CACHE_CONTROL);
      // Content-Length is a byte count, so it is compared against the bytes the
      // body occupies rather than against its count of UTF-16 code units.
      assert.equal(headerValue(response, 'content-length'),
        String(Buffer.byteLength(text)));

      const payload = JSON.parse(text);
      // Re-serialising the parsed document reproduces the exact bytes only when
      // the wire form was already compact and its keys were already in the
      // contract's order, so this one comparison proves both at once.
      assert.equal(JSON.stringify(payload), text);
      assert.deepEqual(Object.keys(payload), EXPECTED_KEYS);
      // Counting the keys is the only way to prove nothing extra leaked into the
      // answer: no host name, process id, uptime, dependency detail, environment
      // value or stack trace belongs in a health document.
      assert.equal(Object.keys(payload).length, EXPECTED_KEYS.length);
      for (const key of EXPECTED_KEYS) {
        // All four values are JSON strings, including the version, which a reader
        // could otherwise be tempted to serve as a number.
        assert.equal(typeof payload[key], 'string', `field ${key} must be a string`);
      }
      assert.equal(payload.name, EXPECTED_NAME);
      assert.equal(payload.name, pkg.name);
      assert.equal(payload.version, EXPECTED_VERSION);
      assert.equal(payload.version, pkg.version);
      assert.equal(payload.status, EXPECTED_STATUS);
      assert.match(payload.timestamp, TIMESTAMP_PATTERN);
      // Nothing names the runtime the endpoint happens to be built on: Node sends
      // no Server header of its own, and nothing in the application adds one.
      assert.equal(response.headers.get('server'), null);

      // The builder behind the document, asserted directly, because a fresh
      // object per call is what makes a per-request timestamp possible: one
      // shared module-level object could be mutated by a single caller for every
      // later caller.
      const built = app.healthPayload();
      assert.deepEqual(Object.keys(built), EXPECTED_KEYS);
      assert.equal(built.status, EXPECTED_STATUS);
      built.status = 'DOWN';
      assert.equal(app.healthPayload().status, EXPECTED_STATUS);
      // Node truncates, Python formats and Java truncates: three mechanisms, one
      // grammar, asserted here so this level cannot drift from the other two
      // while still looking plausible on its own.
      assert.match(app.currentTimestamp(), TIMESTAMP_PATTERN);

      // A load balancer is likely to probe with a query string, which must not
      // defeat the path match.
      const probed = await request(`${address.base}${app.HEALTH_PATH}?probe=lb`);
      assert.equal(probed.response.status, 200);
      assert.equal(headerValue(probed.response, 'content-type'), EXPECTED_MEDIA_TYPE);
      const probedPayload = JSON.parse(probed.text);
      assert.deepEqual(Object.keys(probedPayload), EXPECTED_KEYS);
      assert.equal(probedPayload.status, EXPECTED_STATUS);
      // The query string is not reflected into the answer either.
      assert.ok(!probed.text.includes('probe'),
        `the health document echoed the query string: ${probed.text}`);
    });
  });

test('HEAD /health returns the GET headers without a body', async function () {
  await withServer(async function (address) {
    // The length is compared against a real GET rather than against a literal, so
    // the assertion holds whatever second the timestamp happens to name.
    const get = await request(address.base + app.HEALTH_PATH);
    assert.equal(get.response.status, 200);
    const bodyBytes = Buffer.byteLength(get.text);
    assert.ok(bodyBytes > 0, 'the GET body must carry the health document');

    const head = await request(address.base + app.HEALTH_PATH, { method: 'HEAD' });
    // RFC 9110 expects a general-purpose server to answer HEAD wherever it
    // answers GET, so a 405 here would be a defect rather than a nicety.
    assert.equal(head.response.status, 200);
    assert.equal(headerValue(head.response, 'content-type'), EXPECTED_MEDIA_TYPE);
    assert.equal(headerValue(head.response, 'content-type'),
      headerValue(get.response, 'content-type'));
    assert.equal(headerValue(head.response, 'cache-control'), EXPECTED_CACHE_CONTROL);
    assert.equal(headerValue(head.response, 'cache-control'),
      headerValue(get.response, 'cache-control'));
    // The length a GET would have returned is announced even though nothing is
    // written: the header set is the GET's, only the body is absent.
    const announced = headerValue(head.response, 'content-length');
    assert.notEqual(announced, '', 'Content-Length is mandatory on a HEAD response');
    assert.equal(announced, String(bodyBytes));
    assert.equal(head.text, '');

    // The assertion above cannot stand on its own: every HTTP client knows a HEAD
    // response has no body and stops reading at the header terminator, so a
    // server that wrongly wrote one would still read back as empty. The exchange
    // below therefore speaks HTTP straight over the socket and counts the bytes
    // that really followed the terminator.
    const headWire = await rawExchange(address, `HEAD ${HEALTH_PATH}`);
    assert.ok(headWire.head.startsWith('HTTP/1.1 200'),
      `status line was [${headWire.head.split('\r\n')[0]}]`);
    // Lower-cased on both sides, because a field name's casing is not part of the
    // contract even when the head is read as raw bytes.
    assert.ok(headWire.head.toLowerCase().includes(`content-length: ${bodyBytes}`),
      `the HEAD head did not announce ${bodyBytes} bytes: [${headWire.head}]`);
    assert.equal(headWire.body.length, 0);
    // And the counterpart GET really does put those bytes on the wire, so the
    // zero above is a suppressed body rather than an endpoint with nothing to say.
    const getWire = await rawExchange(address, `GET ${HEALTH_PATH}`);
    assert.equal(getWire.body.length, bodyBytes);
  });
});

test('unknown paths respond 404 with the fixed error envelope', async function () {
  await withServer(async function (address) {
    for (const path of NON_ROUTES) {
      const context = `path ${path}`;
      const { response, text } = await request(address.base + path);
      assert.equal(response.status, 404, context);
      assert.equal(headerValue(response, 'content-type'), EXPECTED_MEDIA_TYPE,
        context);
      assert.equal(headerValue(response, 'cache-control'), EXPECTED_CACHE_CONTROL,
        context);
      assert.equal(headerValue(response, 'content-length'),
        String(Buffer.byteLength(text)), context);
      assert.equal(text, NOT_FOUND_BODY, context);
      // An inbound request is untrusted input, and this endpoint is the first the
      // system has ever accepted, so the answer must never quote the requested
      // path back at the caller -- nor arrive as a markup page that would carry
      // one by convention.
      const requested = path.replace(/^\/+/, '');
      assert.ok(!text.toLowerCase().includes(requested.toLowerCase()),
        `${context}: the error body echoed the request path`);
      assert.ok(!text.includes('<'), `${context}: the error body was not JSON`);
    }
  });
});

test('unsupported methods respond 405 and advertise the allowed methods',
  async function () {
    await withServer(async function (address) {
      // Pinned to the contract literal as well as read from the module, so the
      // `, ` spacing all three implementations emit cannot drift at this level.
      assert.equal(app.ALLOWED_METHODS, EXPECTED_ALLOW);

      for (const method of REJECTED_METHODS) {
        const context = `method ${method}`;
        const { response, text } = await request(address.base + app.HEALTH_PATH,
          { method });
        assert.equal(response.status, 405, context);
        assert.equal(headerValue(response, 'allow'), EXPECTED_ALLOW, context);
        assert.equal(headerValue(response, 'content-type'), EXPECTED_MEDIA_TYPE,
          context);
        assert.ok(!headerValue(response, 'content-type').includes('text/html'),
          context);
        assert.equal(headerValue(response, 'cache-control'), EXPECTED_CACHE_CONTROL,
          context);
        assert.equal(headerValue(response, 'content-length'),
          String(Buffer.byteLength(text)), context);
        assert.equal(text, METHOD_NOT_ALLOWED_BODY, context);
        // The verb the caller chose must not come back in the answer: a stock
        // handler answers an unrecognised method with 501 and a markup page that
        // repeats it, which is a contract break and a disclosure at once.
        assert.ok(!text.includes(method),
          `${context}: the error body echoed the request method`);
      }

      // The invented verb again, at the byte level. `FOO` is refused by Node's own
      // parser before a request object exists, so its answer is written straight
      // to the socket by hand rather than through a ServerResponse: it is the one
      // path whose head no runtime assembled, and reading the wire is the only way
      // to see that head exactly as it was sent.
      const wire = await rawExchange(address, `FOO ${HEALTH_PATH}`);
      assert.ok(wire.head.startsWith('HTTP/1.1 405 Method Not Allowed'),
        `status line was [${wire.head.split('\r\n')[0]}]`);
      const head = wire.head.toLowerCase();
      assert.ok(head.includes(`allow: ${EXPECTED_ALLOW.toLowerCase()}`),
        `the refusal did not advertise the allowed methods: [${wire.head}]`);
      assert.ok(head.includes(`content-type: ${EXPECTED_MEDIA_TYPE}`),
        `the refusal was not served as JSON: [${wire.head}]`);
      assert.ok(head.includes(`cache-control: ${EXPECTED_CACHE_CONTROL}`),
        `the refusal was cacheable: [${wire.head}]`);
      assert.ok(!head.includes('text/html'), `the refusal was markup: [${wire.head}]`);
      const announced = /content-length: (\d+)/.exec(head);
      assert.notEqual(announced, null, `no length was announced: [${wire.head}]`);
      const body = wire.body.toString('utf8');
      // A hand-written head has to count its own bytes correctly, so the announced
      // length is checked against the bytes that actually followed it.
      assert.equal(wire.body.length, Number(announced[1]));
      assert.equal(body, METHOD_NOT_ALLOWED_BODY);
      assert.ok(!body.includes('FOO'),
        `the refusal echoed the request method: ${body}`);
    });
  });
