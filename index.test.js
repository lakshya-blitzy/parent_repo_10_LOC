const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const pkg = require('./package.json');
const app = require('./index.js');

// RFC 3339 UTC timestamp to whole-second precision.
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const HEALTH_PATH = '/health';
const EXPECTED_NAME = 'parent_repo_10_LOC';
const EXPECTED_VERSION = '1.0.0';

const EXPECTED_STATUS = 'UP';

// Field order is part of the wire contract.
const EXPECTED_KEYS = ['name', 'version', 'timestamp', 'status'];

const EXPECTED_MEDIA_TYPE = 'application/json';

const EXPECTED_CACHE_CONTROL = 'no-store';

const EXPECTED_ALLOW = 'GET, HEAD';

const EXPECTED_DEFAULT_PORT = 3000;

const NOT_FOUND_BODY = '{"error":"Not Found"}';
const METHOD_NOT_ALLOWED_BODY = '{"error":"Method Not Allowed"}';
const BAD_REQUEST_BODY = '{"error":"Bad Request"}';

// FOO exercises Node's parser-refusal path; the other verbs reach routing.
const REJECTED_METHODS = ['POST', 'OPTIONS', 'DELETE', 'FOO'];

const NON_ROUTES = ['/nope', '/health/', '/HEALTH', '/%68ealth', '//health'];

// What `node index.js` must write, byte for byte, when it is given no arguments:
// the sum on five lines and nothing else. Built from the repeat rather than typed
// out so the count is stated once and cannot drift from the assertion below.
const DEFAULT_RUN_LINES = 5;
const DEFAULT_RUN_STDOUT = '12\n'.repeat(DEFAULT_RUN_LINES);

// Resolved rather than joined, so the assertion follows the module under test.
const ENTRY_POINT = require.resolve('./index.js');

// A default run must not be able to outlive the suite, whatever it does.
const DEFAULT_RUN_TIMEOUT_MS = 10000;

// Bind tests to loopback port 0 to avoid collisions.
const LOOPBACK_HOST = '127.0.0.1';
const EPHEMERAL_PORT = 0;

// Bound exchanges so a nonresponding handler cannot hang the suite.
const EXCHANGE_TIMEOUT_MS = 5000;

// Poll across a second boundary to verify a per-request timestamp.
const FRESHNESS_TIMEOUT_MS = 5000;
const FRESHNESS_POLL_MS = 100;

// A listener run as a child process must announce its port, and must then end when it is
// signalled, inside bounds the suite can fail on rather than hang on. The shutdown bound is
// deliberately far larger than the grace window the program itself waits out, so a pass means
// the process decided to end rather than that the assertion was generous.
const SERVE_START_TIMEOUT_MS = 10000;
const SHUTDOWN_TIMEOUT_MS = 5000;

// Both signals a supervisor sends must end the process the same way.
const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'];

// The startup banner is the only thing that tells a caller where a PORT=0 listener bound, so
// its whole shape is matched: name, version, host, port and path are each captured and checked.
const BANNER_PATTERN = /^(\S+) (\S+) health endpoint listening on http:\/\/([^:/]+):(\d+)(\/\S*)\n/;

const HEAD_TERMINATOR = '\r\n\r\n';

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

// Always close the listener after the exercise, including assertion failures.
async function withServer(exercise) {
  const server = app.createServer();
  const address = await listen(server);
  try {
    await exercise(address, server);
  } finally {
    // Release idle connections before close so teardown cannot wait on them.
    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }
    await close(server);
  }
}

// Write exact bytes on a raw socket and collect the answer to end of stream. Exact bytes,
// because an HTTP client cannot express several of the inbound shapes this endpoint still owes
// an answer to: a request line the parser refuses, a CONNECT, or a request carrying no Host
// field at all. Reading to EOF also counts the bytes after the head, which is what proves a
// HEAD response carries none.
function rawSend(address, request, label) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    const socket = net.createConnection({ host: address.host, port: address.port });
    socket.setTimeout(EXCHANGE_TIMEOUT_MS, function () {
      socket.destroy(new Error(`[${label}] went unanswered for `
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
        reject(new Error(`the reply to [${label}] never terminated its head`));
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
      socket.end(request);
    });
  });
}

// The well-formed case: a request line completed with the fields a client would have added.
function rawExchange(address, requestLine) {
  return rawSend(address,
    `${requestLine} HTTP/1.1\r\nHost: ${address.host}:${address.port}\r\n`
      + 'Connection: close\r\n\r\n',
    requestLine);
}

// HTTP field names are case-insensitive; normalize raw-header comparisons.
function headerValue(response, name) {
  const value = response.headers.get(name);
  return value === null ? '' : value;
}

// Bound each exchange so a nonresponding handler fails the test instead of hanging it.
async function request(url, options) {
  const settings = Object.assign({}, options);
  if (settings.signal === undefined) {
    settings.signal = AbortSignal.timeout(EXCHANGE_TIMEOUT_MS);
  }
  try {
    const response = await fetch(url, settings);
    const text = await response.text();
    return { response, text };
  } catch (cause) {
    throw new Error(`[${settings.method || 'GET'} ${url}] did not complete within `
      + `${EXCHANGE_TIMEOUT_MS} ms: ${cause.message}`, { cause });
  }
}

function delay(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

// Fail awaited work at a bound rather than let it hang the suite. The timer is cleared on
// every outcome, so a settled race cannot keep the event loop alive after the test returns.
function withDeadline(work, ms, message) {
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () {
      reject(new Error(message));
    }, ms);
    work.then(function (value) {
      clearTimeout(timer);
      resolve(value);
    }, function (error) {
      clearTimeout(timer);
      reject(error);
    });
  });
}

// The listener as an operator runs it: a real child process, given PORT=0 so it cannot collide
// with anything and must report the port it was actually assigned. Its banner is the only thing
// that tells this test where to reach it, and `ready` resolves with the parsed banner.
function startServeProcess() {
  const started = {
    child: spawn(process.execPath, [ENTRY_POINT, '--serve'], {
      env: Object.assign({}, process.env, { PORT: '0', HOST: LOOPBACK_HOST }),
      // Piped rather than inherited, so the banner lands in a buffer this test can parse
      // instead of in the reporter's stream.
      stdio: ['ignore', 'pipe', 'pipe']
    }),
    stdout: '',
    stderr: ''
  };
  started.child.stdout.setEncoding('utf8');
  started.child.stderr.setEncoding('utf8');
  started.child.stderr.on('data', function (chunk) {
    started.stderr += chunk;
  });
  started.ready = new Promise(function (resolve, reject) {
    started.child.stdout.on('data', function (chunk) {
      started.stdout += chunk;
      const announced = BANNER_PATTERN.exec(started.stdout);
      if (announced !== null) {
        resolve(announced);
      }
    });
    started.child.once('error', reject);
    // Exiting before the banner means the bind failed, which is a start-up failure rather
    // than a timeout, so it is reported as one along with everything the child wrote.
    started.child.once('exit', function (code, signal) {
      reject(new Error(`the listener exited (code ${code}, signal ${signal}) before it `
        + `announced a port; stdout was ${JSON.stringify(started.stdout)} and stderr `
        + `${JSON.stringify(started.stderr)}`));
    });
  });
  return started;
}

function hasEnded(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function exitOf(child) {
  return new Promise(function (resolve) {
    if (hasEnded(child)) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once('exit', function (code, signal) {
      resolve({ code, signal });
    });
  });
}

// A caller that connects and then sends nothing at all: what a load-balancer TCP probe and a
// port scanner both do, and what a health endpoint attracts most of. The error handler is
// permanent because the listener destroys this socket while shutting down, and the reset that
// follows must not surface as an unhandled event.
function connectSilently(address) {
  return new Promise(function (resolve, reject) {
    let connected = false;
    const socket = net.createConnection({ host: address.host, port: address.port });
    socket.on('error', function (error) {
      if (!connected) {
        reject(error);
      }
    });
    socket.once('connect', function () {
      connected = true;
      resolve(socket);
    });
  });
}

// A refused connection is how a released port answers. Anything else - a completed connection,
// or a connection that neither completes nor is refused - means the port is still held.
function portIsReleased(port) {
  return new Promise(function (resolve) {
    let settled = false;
    const socket = net.createConnection({ host: LOOPBACK_HOST, port });
    const settle = function (released) {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(released);
    };
    socket.on('error', function () {
      settle(true);
    });
    socket.setTimeout(EXCHANGE_TIMEOUT_MS, function () {
      settle(false);
    });
    socket.on('connect', function () {
      settle(false);
    });
  });
}

// Poll until the second-precision timestamp changes, with a bounded wait.
async function awaitLaterTimestamp(address, seen) {
  const deadline = Date.now() + FRESHNESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await delay(FRESHNESS_POLL_MS);
    const { text } = await request(address.base + HEALTH_PATH);
    const timestamp = JSON.parse(text).timestamp;
    assert.match(timestamp, TIMESTAMP_PATTERN);
    if (timestamp !== seen) {
      return timestamp;
    }
  }
  assert.fail(`GET ${HEALTH_PATH} kept reporting ${seen} for `
    + `${FRESHNESS_TIMEOUT_MS} ms, so the timestamp is not generated per request`);
}

test('the pre-existing capability is exported, and the default run still prints it '
  + 'five times', function () {
    assert.equal(typeof app.add, 'function');
    assert.equal(app.add(5, 7), 12);
    assert.equal(app.add(0, 0), 0);
    assert.equal(app.add(-2, 5), 3);

    // Calling add() proves the function. It cannot prove the program: the
    // `require.main === module` branch is what an operator actually runs, and it is
    // the branch the --serve gate exists to protect, because a process that binds a
    // socket never exits and would have replaced these writes rather than added to
    // them. So the program is run, in a real child process, with no arguments.
    const run = spawnSync(process.execPath, [ENTRY_POINT], {
      encoding: 'utf8',
      timeout: DEFAULT_RUN_TIMEOUT_MS,
      // An inherited stdio would let the child write into the reporter's stream
      // instead of into a buffer this test can compare.
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // spawnSync reports a failure to start, or a timeout, through `error` rather
    // than through the exit code, so that is checked before anything else.
    assert.equal(run.error, undefined,
      `node ${ENTRY_POINT} did not run to completion: ${run.error && run.error.message}`);
    // A listener started without the flag would have been killed by the timeout,
    // which surfaces as a signal rather than a status.
    assert.equal(run.signal, null, `the default run was terminated by ${run.signal}`);
    assert.equal(run.status, 0, `the default run exited ${run.status}`);
    // Every observable result is part of the preserved behaviour, so each is
    // asserted: a startup banner, a deprecation warning on stderr or a changed exit
    // code is a change even when the first line still reads correctly.
    assert.equal(run.stderr, '', `the default run wrote to stderr: ${run.stderr}`);
    assert.equal(run.stdout, DEFAULT_RUN_STDOUT);
    assert.equal(run.stdout.split('\n').length - 1, DEFAULT_RUN_LINES);
    // The gate is stated in bytes, so the byte length is what is compared.
    assert.equal(Buffer.byteLength(run.stdout), 15);
  });

test('GET /health responds 200 with the four-field health document',
  async function () {
    await withServer(async function (address) {
      assert.ok(address.port > 0, `no ephemeral port was assigned: ${address.port}`);
      assert.equal(app.DEFAULT_PORT, EXPECTED_DEFAULT_PORT);
      assert.equal(app.DEFAULT_HOST, LOOPBACK_HOST);
      assert.equal(address.host, LOOPBACK_HOST);
      assert.equal(app.HEALTH_PATH, HEALTH_PATH);

      const { response, text } = await request(address.base + app.HEALTH_PATH);

      assert.equal(response.status, 200);
      assert.equal(headerValue(response, 'content-type'), EXPECTED_MEDIA_TYPE);
      assert.equal(headerValue(response, 'cache-control'), EXPECTED_CACHE_CONTROL);
      // Compare Content-Length with encoded bytes, not JS character length.
      assert.equal(headerValue(response, 'content-length'),
        String(Buffer.byteLength(text)));

      const payload = JSON.parse(text);
      // Round-trip equality checks compact serialization and field order.
      assert.equal(JSON.stringify(payload), text);
      assert.deepEqual(Object.keys(payload), EXPECTED_KEYS);
      assert.equal(Object.keys(payload).length, EXPECTED_KEYS.length);
      for (const key of EXPECTED_KEYS) {
        assert.equal(typeof payload[key], 'string', `field ${key} must be a string`);
      }
      assert.equal(payload.name, EXPECTED_NAME);
      assert.equal(payload.name, pkg.name);
      assert.equal(payload.version, EXPECTED_VERSION);
      assert.equal(payload.version, pkg.version);
      assert.equal(payload.status, EXPECTED_STATUS);
      assert.match(payload.timestamp, TIMESTAMP_PATTERN);
      assert.equal(response.headers.get('server'), null);

      // Mutating one payload result must not affect a later result.
      const built = app.healthPayload();
      assert.deepEqual(Object.keys(built), EXPECTED_KEYS);
      assert.equal(built.status, EXPECTED_STATUS);
      built.status = 'DOWN';
      assert.equal(app.healthPayload().status, EXPECTED_STATUS);
      assert.match(app.currentTimestamp(), TIMESTAMP_PATTERN);

      const probed = await request(`${address.base}${app.HEALTH_PATH}?probe=lb`);
      assert.equal(probed.response.status, 200);
      assert.equal(headerValue(probed.response, 'content-type'), EXPECTED_MEDIA_TYPE);
      const probedPayload = JSON.parse(probed.text);
      assert.deepEqual(Object.keys(probedPayload), EXPECTED_KEYS);
      assert.equal(probedPayload.status, EXPECTED_STATUS);
      assert.ok(!probed.text.includes('probe'),
        `the health document echoed the query string: ${probed.text}`);

      const later = await awaitLaterTimestamp(address, payload.timestamp);
      assert.match(later, TIMESTAMP_PATTERN);
      assert.notEqual(later, payload.timestamp);
    });
  });

test('HEAD /health returns the GET headers without a body', async function () {
  await withServer(async function (address) {
    const get = await request(address.base + app.HEALTH_PATH);
    assert.equal(get.response.status, 200);
    const bodyBytes = Buffer.byteLength(get.text);
    assert.ok(bodyBytes > 0, 'the GET body must carry the health document');

    const head = await request(address.base + app.HEALTH_PATH, { method: 'HEAD' });
    // HEAD must be supported wherever this endpoint supports GET.
    assert.equal(head.response.status, 200);
    assert.equal(headerValue(head.response, 'content-type'), EXPECTED_MEDIA_TYPE);
    assert.equal(headerValue(head.response, 'content-type'),
      headerValue(get.response, 'content-type'));
    assert.equal(headerValue(head.response, 'cache-control'), EXPECTED_CACHE_CONTROL);
    assert.equal(headerValue(head.response, 'cache-control'),
      headerValue(get.response, 'cache-control'));
    const announced = headerValue(head.response, 'content-length');
    assert.notEqual(announced, '', 'Content-Length is mandatory on a HEAD response');
    assert.equal(announced, String(bodyBytes));
    assert.equal(head.text, '');

    const headWire = await rawExchange(address, `HEAD ${HEALTH_PATH}`);
    assert.ok(headWire.head.startsWith('HTTP/1.1 200'),
      `status line was [${headWire.head.split('\r\n')[0]}]`);
    assert.ok(headWire.head.toLowerCase().includes(`content-length: ${bodyBytes}`),
      `the HEAD head did not announce ${bodyBytes} bytes: [${headWire.head}]`);
    assert.equal(headWire.body.length, 0);
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
        assert.ok(!text.includes(method),
          `${context}: the error body echoed the request method`);
      }

      // Send FOO over the raw socket because Node rejects it before request routing.
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
      assert.equal(wire.body.length, Number(announced[1]));
      assert.equal(body, METHOD_NOT_ALLOWED_BODY);
      assert.ok(!body.includes('FOO'),
        `the refusal echoed the request method: ${body}`);
    });
  });

// Every inbound shape Node takes out of the normal request pipeline, paired with the answer the
// contract owes it. A CONNECT is handed to a 'connect' listener and, with none, the socket is
// closed unanswered; an HTTP/1.1 request with no Host is refused by Node itself, ahead of the
// router, with a chunked bodiless 400; a request line the parser refuses is handed to
// 'clientError'. None of them reaches routeRequest, and every one of them must still be answered
// as JSON with the same three headers every routed answer carries. Status lines are written out
// in full rather than composed, so the test states the wire bytes it expects.
function bypassCases(address) {
  const authority = `${address.host}:${address.port}`;
  return [
    {
      name: 'CONNECT on the route',
      request: `CONNECT ${HEALTH_PATH} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`,
      statusLine: 'HTTP/1.1 405 Method Not Allowed',
      body: METHOD_NOT_ALLOWED_BODY,
      allow: EXPECTED_ALLOW,
      absent: ['CONNECT']
    },
    {
      // The authority form RFC 9110 defines for CONNECT: a host and port, no path at all.
      name: 'CONNECT in authority form',
      request: `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`,
      statusLine: 'HTTP/1.1 404 Not Found',
      body: NOT_FOUND_BODY,
      allow: null,
      absent: ['CONNECT', address.host]
    },
    {
      name: 'HTTP/1.1 with no Host field',
      request: `GET ${HEALTH_PATH} HTTP/1.1\r\n\r\n`,
      statusLine: 'HTTP/1.1 400 Bad Request',
      body: BAD_REQUEST_BODY,
      allow: null,
      absent: []
    },
    {
      name: 'a method token split by a space',
      request: `GE T ${HEALTH_PATH} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`,
      statusLine: 'HTTP/1.1 400 Bad Request',
      body: BAD_REQUEST_BODY,
      allow: null,
      absent: ['GE T']
    },
    {
      name: 'an empty request target',
      request: `GET  HTTP/1.1\r\nHost: ${authority}\r\n\r\n`,
      statusLine: 'HTTP/1.1 400 Bad Request',
      body: BAD_REQUEST_BODY,
      allow: null,
      absent: []
    }
  ];
}

test('requests that never reach the router are still answered inside the JSON contract',
  async function () {
    await withServer(async function (address) {
      for (const shape of bypassCases(address)) {
        const context = shape.name;
        const wire = await rawSend(address, shape.request, context);
        const statusLine = wire.head.split('\r\n')[0];
        const body = wire.body.toString('utf8');
        const head = wire.head.toLowerCase();

        // Silence is not one of this contract's answers, so the answer is checked before
        // anything about it: an empty reply never terminates its head and rawSend would
        // already have failed, and a wrong status is reported with the line that arrived.
        assert.equal(statusLine, shape.statusLine, context);
        assert.ok(head.includes(`content-type: ${EXPECTED_MEDIA_TYPE}`),
          `${context}: not served as JSON: [${wire.head}]`);
        assert.ok(!head.includes('text/html'),
          `${context}: answered with markup: [${wire.head}]`);
        assert.ok(head.includes(`cache-control: ${EXPECTED_CACHE_CONTROL}`),
          `${context}: a liveness answer was left cacheable: [${wire.head}]`);
        // RFC 9110 requires Date from a server that has a clock, and this path writes it
        // by hand because no ServerResponse does it here.
        assert.ok(head.includes('date: '), `${context}: no Date was sent: [${wire.head}]`);
        // Nothing is read from the request, so the socket must not be offered for reuse
        // with unread bytes still on it.
        assert.ok(head.includes('connection: close'),
          `${context}: the connection was offered for reuse: [${wire.head}]`);
        const announced = /content-length: (\d+)/.exec(head);
        assert.notEqual(announced, null,
          `${context}: no length was announced: [${wire.head}]`);
        assert.equal(wire.body.length, Number(announced[1]), context);
        assert.equal(body, shape.body, context);
        if (shape.allow === null) {
          assert.ok(!head.includes('allow:'),
            `${context}: advertised allowed methods on a non-405: [${wire.head}]`);
        } else {
          assert.ok(head.includes(`allow: ${shape.allow.toLowerCase()}`),
            `${context}: did not advertise the allowed methods: [${wire.head}]`);
        }
        // No name, version, runtime or diagnostic beyond the status may be disclosed.
        assert.ok(!head.includes('server:'),
          `${context}: disclosed a Server field: [${wire.head}]`);
        // The status line and the body are what the request could have been reflected
        // into; the field names around them are the writer's own.
        const answer = `${statusLine}\r\n${body}`;
        for (const token of shape.absent) {
          assert.ok(!answer.includes(token),
            `${context}: the answer echoed [${token}]: ${answer}`);
        }
      }

      // Host is mandatory only from HTTP/1.1 onward, so answering its absence must not turn a
      // valid HTTP/1.0 request into a refusal.
      const legacy = await rawSend(address, `GET ${HEALTH_PATH} HTTP/1.0\r\n\r\n`,
        'HTTP/1.0 with no Host field');
      assert.equal(legacy.head.split('\r\n')[0], 'HTTP/1.1 200 OK',
        `an HTTP/1.0 request was refused: [${legacy.head}]`);
      const document = JSON.parse(legacy.body.toString('utf8'));
      assert.deepEqual(Object.keys(document), EXPECTED_KEYS);
      assert.equal(document.status, EXPECTED_STATUS);
      assert.equal(document.name, EXPECTED_NAME);
    });
  });

test('a signal ends the listener promptly even while a caller holds a connection it '
  + 'never used', async function () {
    for (const signal of SHUTDOWN_SIGNALS) {
      const context = `signal ${signal}`;
      const started = startServeProcess();
      const announced = await withDeadline(started.ready, SERVE_START_TIMEOUT_MS,
        `${context}: the listener announced no port within ${SERVE_START_TIMEOUT_MS} ms`);
      const boundPort = Number(announced[4]);
      let silent = null;
      try {
        assert.equal(announced[1], pkg.name, context);
        assert.equal(announced[2], pkg.version, context);
        assert.equal(announced[3], LOOPBACK_HOST, context);
        assert.equal(announced[5], HEALTH_PATH, context);
        // PORT=0 was asked for, so the banner must name the port actually assigned rather
        // than the one requested.
        assert.ok(boundPort > 0, `${context}: the banner reported port ${announced[4]}`);

        const probe = await request(`http://${LOOPBACK_HOST}:${boundPort}${HEALTH_PATH}`);
        assert.equal(probe.response.status, 200,
          `${context}: the listener never served the endpoint`);
        assert.equal(JSON.parse(probe.text).status, EXPECTED_STATUS, context);

        silent = await withDeadline(
          connectSilently({ host: LOOPBACK_HOST, port: boundPort }),
          EXCHANGE_TIMEOUT_MS,
          `${context}: no connection could be opened to port ${boundPort}`);

        const ended = exitOf(started.child);
        started.child.kill(signal);
        // A second signal arriving while the first is still being honoured must change
        // nothing: no second close, no second grace window, no error on the way out.
        started.child.kill(signal);
        const outcome = await withDeadline(ended, SHUTDOWN_TIMEOUT_MS,
          `${context}: the listener was still running ${SHUTDOWN_TIMEOUT_MS} ms after the `
            + 'signal while a caller held a connection it had sent nothing on');

        // Exit 0 with no signal code: the process must end because its handler closed the
        // listener and returned, not because the signal killed it or a default handler did.
        assert.equal(outcome.signal, null,
          `${context}: the process was terminated by ${outcome.signal} instead of exiting`);
        assert.equal(outcome.code, 0, `${context}: exited ${outcome.code}`);
        assert.equal(started.stderr, '',
          `${context}: wrote to stderr while shutting down: ${started.stderr}`);
        // Exactly one banner line and nothing else: shutdown is silent.
        assert.equal(started.stdout.split('\n').length - 1, 1,
          `${context}: wrote more than the banner: ${JSON.stringify(started.stdout)}`);
        assert.equal(await portIsReleased(boundPort), true,
          `${context}: port ${boundPort} was still reachable after the process exited`);
      } finally {
        if (silent !== null) {
          silent.destroy();
        }
        // Whatever the assertions found, no listener may outlive the test that started it.
        if (!hasEnded(started.child)) {
          started.child.kill('SIGKILL');
        }
      }
    }
  });
