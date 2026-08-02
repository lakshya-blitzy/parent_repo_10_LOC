const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const pkg = require('./package.json');
const app = require('./index.js');

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

// Built from the repeat rather than typed out, so the count is stated once and the byte
// gate below cannot drift from it.
const DEFAULT_RUN_LINES = 5;
const DEFAULT_RUN_STDOUT = '12\n'.repeat(DEFAULT_RUN_LINES);

// Resolved rather than joined, so the assertion follows the module under test.
const ENTRY_POINT = require.resolve('./index.js');

const DEFAULT_RUN_TIMEOUT_MS = 10000;

// Anchored on the whole line, so a banner that grew a host name, a process identifier or an
// environment value fails here.
const SERVE_BANNER_PATTERN =
  /^parent_repo_10_LOC 1\.0\.0 health endpoint listening on http:\/\/127\.0\.0\.1:(\d+)\/health\n$/;

const SERVE_TIMEOUT_MS = 15000;

// Bind tests to loopback port 0 to avoid collisions.
const LOOPBACK_HOST = '127.0.0.1';
const EPHEMERAL_PORT = 0;

// A blank or absent value read as "every interface" is the one mistake here that would put the
// endpoint on the network; a padded value is trimmed to the address it names.
const HOST_CASES = [
  [{}, LOOPBACK_HOST],
  [{ HOST: '' }, LOOPBACK_HOST],
  [{ HOST: '   ' }, LOOPBACK_HOST],
  [{ HOST: ' 0.0.0.0 ' }, '0.0.0.0'],
  [{ HOST: '127.0.0.2' }, '127.0.0.2']
];

// Each malformed form must fall back rather than abort start-up: a typo in a supervisor's unit
// file must not become a crash loop. 0 is honoured, because it asks for an ephemeral port.
const PORT_CASES = [
  [{}, EXPECTED_DEFAULT_PORT],
  [{ PORT: '' }, EXPECTED_DEFAULT_PORT],
  [{ PORT: '   ' }, EXPECTED_DEFAULT_PORT],
  [{ PORT: '3000abc' }, EXPECTED_DEFAULT_PORT],
  [{ PORT: '+3000' }, EXPECTED_DEFAULT_PORT],
  [{ PORT: '-1' }, EXPECTED_DEFAULT_PORT],
  [{ PORT: '65536' }, EXPECTED_DEFAULT_PORT],
  [{ PORT: '99999999999' }, EXPECTED_DEFAULT_PORT],
  [{ PORT: '0' }, EPHEMERAL_PORT],
  [{ PORT: ' 000080 ' }, 80],
  [{ PORT: '8123' }, 8123]
];

const EXCHANGE_TIMEOUT_MS = 5000;

const FRESHNESS_TIMEOUT_MS = 5000;
const FRESHNESS_POLL_MS = 100;

// The shutdown bound is deliberately far larger than the grace window the program waits out, so
// a pass means the process decided to end rather than that the assertion was generous.
const SERVE_START_TIMEOUT_MS = 10000;
const SHUTDOWN_TIMEOUT_MS = 5000;

const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'];

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

// Exact bytes, because an HTTP client cannot express several of the shapes this endpoint still
// owes an answer to: a request line the parser refuses, a CONNECT, or a request carrying no Host
// field. Reading to EOF also counts the bytes after the head, proving a HEAD response has none.
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
        // latin1 so each byte maps to exactly one character.
        head: reply.toString('latin1', 0, terminator),
        body: reply.subarray(terminator + HEAD_TERMINATOR.length)
      });
    });
    socket.on('connect', function () {
      socket.end(request);
    });
  });
}

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

// A copy, so setting a variable for a child never sets it for the suite: process.env is shared
// by every module in this process. A key given as undefined is removed rather than emptied.
function childEnvironment(overrides) {
  const environment = Object.assign({}, process.env, overrides);
  for (const name of Object.keys(overrides)) {
    if (overrides[name] === undefined) {
      delete environment[name];
    }
  }
  return environment;
}

// The only exercise of the --serve branch end to end: everything else here binds through
// createServer(), which never reads the environment and never installs a signal handler. The
// child is bounded twice - on the banner and on the shutdown - so neither a listener that never
// reports itself nor one that ignores its signal can hang the suite.
function serve(overrides) {
  return new Promise(function (resolve, reject) {
    const child = spawn(process.execPath, [ENTRY_POINT, '--serve'], {
      env: childEnvironment(overrides),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let stopping = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const abandon = setTimeout(function () {
      child.kill('SIGKILL');
    }, SERVE_TIMEOUT_MS);
    child.stdout.on('data', function (chunk) {
      stdout += chunk;
      // A complete line is the point at which the listener is known to be bound.
      if (!stopping && stdout.endsWith('\n')) {
        stopping = true;
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', function (chunk) {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', function (code, signal) {
      clearTimeout(abandon);
      resolve({ stdout, stderr, code, signal, signalled: stopping });
    });
  });
}

// Fails awaited work at a bound rather than letting it hang the suite. The timer is cleared on
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

// PORT=0 so the child cannot collide with anything and must report the port it was assigned:
// its banner is the only thing that tells this test where to reach it.
function startServeProcess() {
  const started = {
    child: spawn(process.execPath, [ENTRY_POINT, '--serve'], {
      env: Object.assign({}, process.env, { PORT: '0', HOST: LOOPBACK_HOST }),
      // Piped so the banner lands in a buffer rather than in the reporter's stream.
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

// A caller that connects and sends nothing: what a load-balancer probe and a port scanner do.
// The error handler is permanent because the listener destroys this socket while shutting down,
// and the reset that follows must not surface as an unhandled event.
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

test('the pre-existing capability is exported, requiring the module has no effect of its '
  + 'own, the default run still prints it five times, --serve binds only where HOST and '
  + 'PORT say, and a signalled listener exits cleanly', async function () {
    assert.equal(typeof app.add, 'function');
    assert.equal(app.add(5, 7), 12);
    assert.equal(app.add(0, 0), 0);
    assert.equal(app.add(-2, 5), 3);

    // Calling add() cannot prove the program: the `require.main === module` branch is
    // what an operator runs, and it is the branch the --serve gate protects, because a
    // process that binds a socket never exits. So the program is run for real.
    const run = spawnSync(process.execPath, [ENTRY_POINT], {
      encoding: 'utf8',
      timeout: DEFAULT_RUN_TIMEOUT_MS,
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
    assert.equal(run.stderr, '', `the default run wrote to stderr: ${run.stderr}`);
    assert.equal(run.stdout, DEFAULT_RUN_STDOUT);
    assert.equal(run.stdout.split('\n').length - 1, DEFAULT_RUN_LINES);
    assert.equal(Buffer.byteLength(run.stdout), 15);

    // This file's own require() cannot show that requiring is silent: by the time a test
    // runs the module is already in require.cache and anything it wrote reached the
    // reporter's streams before collection. So a fresh process requires it and nothing else.
    const imported = spawnSync(process.execPath,
      ['-e', `require(${JSON.stringify(ENTRY_POINT)});`], {
        encoding: 'utf8',
        timeout: DEFAULT_RUN_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    assert.equal(imported.error, undefined,
      `requiring ${ENTRY_POINT} did not run to completion: `
        + `${imported.error && imported.error.message}`);
    assert.equal(imported.signal, null,
      `requiring the module was terminated by ${imported.signal}`);
    assert.equal(imported.status, 0, `requiring the module exited ${imported.status}`);
    assert.equal(imported.stdout, '',
      `requiring the module wrote to stdout: ${imported.stdout}`);
    assert.equal(imported.stderr, '',
      `requiring the module wrote to stderr: ${imported.stderr}`);

    for (const [environment, expected] of HOST_CASES) {
      assert.equal(app.resolveHost(environment), expected,
        `HOST=${JSON.stringify(environment.HOST)}`);
    }
    for (const [environment, expected] of PORT_CASES) {
      assert.equal(app.resolvePort(environment), expected,
        `PORT=${JSON.stringify(environment.PORT)}`);
    }
    assert.equal(app.resolveHost(), app.DEFAULT_HOST);
    assert.equal(app.resolvePort(), app.DEFAULT_PORT);

    const served = await serve({ PORT: String(EPHEMERAL_PORT), HOST: undefined });
    const banner = SERVE_BANNER_PATTERN.exec(served.stdout);
    assert.notEqual(banner, null, `the startup line was [${served.stdout}]`);
    const boundPort = Number(banner[1]);
    assert.ok(boundPort > 0, `no ephemeral port was reported: ${boundPort}`);
    assert.notEqual(boundPort, EXPECTED_DEFAULT_PORT,
      'an ephemeral request bound the default port, so PORT=0 was not honoured');
    assert.equal(served.stderr, '', `--serve wrote to stderr: ${served.stderr}`);
    assert.ok(served.signalled, 'the child was never signalled, so it printed no banner');
    assert.equal(served.signal, null, `--serve was killed by ${served.signal}`);
    assert.equal(served.code, 0, `--serve exited ${served.code} on SIGTERM`);

    await assertASignalledListenerExitsCleanly();
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

      // Host is mandatory only from HTTP/1.1 onward, so a valid HTTP/1.0 request that omits it
      // must still be served the document rather than refused. Sent over a raw socket because a
      // client will not speak HTTP/1.0 without a Host field on request.
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

test('HEAD /health returns the GET headers without a body', async function () {
  await withServer(async function (address) {
    const get = await request(address.base + app.HEALTH_PATH);
    assert.equal(get.response.status, 200);
    const bodyBytes = Buffer.byteLength(get.text);
    assert.ok(bodyBytes > 0, 'the GET body must carry the health document');

    const head = await request(address.base + app.HEALTH_PATH, { method: 'HEAD' });
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

// Every inbound shape Node takes out of the normal request pipeline, paired with the answer the
// contract owes it. None reaches routeRequest, and every one must still be answered as JSON with
// the headers a routed answer carries. Status lines are written out in full, so the test states
// the wire bytes it expects.
//
// The CONNECT shapes differ only in what is wrong with the request, which is how they pin the
// ordering: being taken out of the pipeline is not a reason to be judged by a different order,
// so a missing Host field is answered before the target and the method - and the HTTP/1.0 shape
// holds that rule to the version that carries it, owing no Host field and so still a 405.
function bypassCases(address) {
  const authority = `${address.host}:${address.port}`;
  return [
    {
      name: 'CONNECT on the route',
      request: `CONNECT ${HEALTH_PATH} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`,
      status: 405,
      statusLine: 'HTTP/1.1 405 Method Not Allowed',
      body: METHOD_NOT_ALLOWED_BODY,
      allow: EXPECTED_ALLOW,
      absent: ['CONNECT']
    },
    {
      // Node does not refuse it - the server turns its own Host check off - so it reaches the
      // 'connect' listener, where the field is checked before the target. Without that check the
      // method alone would earn the 405 above, a different answer to the same omission.
      name: 'CONNECT on the route with no Host field',
      request: `CONNECT ${HEALTH_PATH} HTTP/1.1\r\n\r\n`,
      status: 400,
      statusLine: 'HTTP/1.1 400 Bad Request',
      body: BAD_REQUEST_BODY,
      allow: null,
      absent: ['CONNECT']
    },
    {
      // And the contrast that keeps the check from being over-broad: the field belongs to
      // HTTP/1.1, so a 1.0 CONNECT that omits it is owed the 405 its method earns.
      name: 'CONNECT on the route as HTTP/1.0, which owes no Host field',
      request: `CONNECT ${HEALTH_PATH} HTTP/1.0\r\n\r\n`,
      status: 405,
      statusLine: 'HTTP/1.1 405 Method Not Allowed',
      body: METHOD_NOT_ALLOWED_BODY,
      allow: EXPECTED_ALLOW,
      absent: ['CONNECT']
    },
    {
      name: 'CONNECT in authority form',
      request: `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`,
      status: 404,
      statusLine: 'HTTP/1.1 404 Not Found',
      body: NOT_FOUND_BODY,
      allow: null,
      absent: ['CONNECT', address.host]
    },
    {
      name: 'HTTP/1.1 with no Host field',
      request: `GET ${HEALTH_PATH} HTTP/1.1\r\n\r\n`,
      status: 400,
      statusLine: 'HTTP/1.1 400 Bad Request',
      body: BAD_REQUEST_BODY,
      allow: null,
      absent: []
    },
    {
      // The classifier makes the check the router makes, and in the same order, so this is a
      // 400 rather than the 405 the method alone would have earned.
      name: 'an unsupported method with no Host field',
      request: `FOO ${HEALTH_PATH} HTTP/1.1\r\n\r\n`,
      status: 400,
      statusLine: 'HTTP/1.1 400 Bad Request',
      body: BAD_REQUEST_BODY,
      allow: null,
      absent: ['FOO']
    },
    {
      name: 'an unsupported method on an unknown path with no Host field',
      request: 'FOO /nope HTTP/1.1\r\n\r\n',
      status: 400,
      statusLine: 'HTTP/1.1 400 Bad Request',
      body: BAD_REQUEST_BODY,
      allow: null,
      absent: ['FOO', 'nope']
    },
    {
      name: 'a method token split by a space',
      request: `GE T ${HEALTH_PATH} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`,
      status: 400,
      statusLine: 'HTTP/1.1 400 Bad Request',
      body: BAD_REQUEST_BODY,
      allow: null,
      absent: ['GE T']
    },
    {
      name: 'an empty request target',
      request: `GET  HTTP/1.1\r\nHost: ${authority}\r\n\r\n`,
      status: 400,
      statusLine: 'HTTP/1.1 400 Bad Request',
      body: BAD_REQUEST_BODY,
      allow: null,
      absent: []
    }
  ];
}

async function assertRefusedInsideContract(address, shape) {
  const context = shape.name;
  const wire = await rawSend(address, shape.request, context);
  const statusLine = wire.head.split('\r\n')[0];
  const body = wire.body.toString('utf8');
  const head = wire.head.toLowerCase();

  assert.equal(statusLine, shape.statusLine, context);
  assert.ok(head.includes(`content-type: ${EXPECTED_MEDIA_TYPE}`),
    `${context}: not served as JSON: [${wire.head}]`);
  assert.ok(!head.includes('text/html'),
    `${context}: answered with markup: [${wire.head}]`);
  assert.ok(head.includes(`cache-control: ${EXPECTED_CACHE_CONTROL}`),
    `${context}: a liveness answer was left cacheable: [${wire.head}]`);
  assert.ok(head.includes('date: '), `${context}: no Date was sent: [${wire.head}]`);
  assert.ok(head.includes('connection: close'),
    `${context}: the connection was offered for reuse: [${wire.head}]`);
  const announced = /content-length: (\d+)/.exec(head);
  assert.notEqual(announced, null, `${context}: no length was announced: [${wire.head}]`);
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
  assert.ok(!head.includes('server:'), `${context}: disclosed a Server field: [${wire.head}]`);
  const answer = `${statusLine}\r\n${body}`;
  for (const token of shape.absent) {
    assert.ok(!answer.includes(token), `${context}: the answer echoed [${token}]: ${answer}`);
  }
}

test('requests this endpoint does not serve are refused as JSON - 404 for an unknown path, '
  + '400 for a request the router never sees', async function () {
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
      assert.equal(headerValue(response, 'allow'), '', context);
    }

    // The target is judged before the method, so a request wrong in both ways is 404 and not
    // 405, and advertises nothing. POST and DELETE are routed while OPTIONS and FOO are refused
    // by Node's parser first, so one matrix covers the router and the classifier.
    for (const path of NON_ROUTES) {
      for (const method of REJECTED_METHODS) {
        const context = `method ${method} on path ${path}`;
        const { response, text } = await request(address.base + path, { method });
        assert.equal(response.status, 404, context);
        assert.equal(headerValue(response, 'allow'), '', context);
        assert.equal(headerValue(response, 'content-type'), EXPECTED_MEDIA_TYPE, context);
        assert.equal(headerValue(response, 'cache-control'), EXPECTED_CACHE_CONTROL,
          context);
        assert.equal(headerValue(response, 'content-length'),
          String(Buffer.byteLength(text)), context);
        assert.equal(text, NOT_FOUND_BODY, context);
        assert.ok(!text.includes(method), `${context}: the body echoed the method`);
        assert.ok(!text.includes('<'), `${context}: the body was not JSON`);
      }
    }

    for (const shape of bypassCases(address)) {
      if (shape.status !== 405) {
        await assertRefusedInsideContract(address, shape);
      }
    }

    // Only the absent field breaks the rule: one that arrived empty was still sent, and the name
    // is matched as HTTP compares field names. Both are served, so the refusal above cannot be
    // over-broad, and both go over a socket because no client will misspell the field for you.
    const authority = `${address.host}:${address.port}`;
    for (const [name, packet] of [
      ['an empty Host field',
        `GET ${HEALTH_PATH} HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n`],
      ['a lower-case host field',
        `GET ${HEALTH_PATH} HTTP/1.1\r\nhost: ${authority}\r\nConnection: close\r\n\r\n`]
    ]) {
      const wire = await rawSend(address, packet, name);
      assert.ok(wire.head.startsWith('HTTP/1.1 200 OK'),
        `${name} must still be served; status line was [${wire.head.split('\r\n')[0]}]`);
      assert.equal(JSON.parse(wire.body.toString('utf8')).status, EXPECTED_STATUS, name);
    }

    // The classifier is exported, so every verdict can be checked without a socket: a packet
    // carrying the Host field is judged on target then method, and one without it is a 400
    // whatever they are, because the field is checked first.
    const hostField = `Host: ${authority}\r\n`;
    for (const [name, code, packet, expected] of [
      ['a target that is not the route', 'HPE_INVALID_URL',
        `GET /nope HTTP/1.1\r\n${hostField}\r\n`, 404],
      ['the same target with no Host field', 'HPE_INVALID_URL',
        'GET /nope HTTP/1.1\r\n\r\n', 400],
      ['a method the parser accepts, so the refusal was something else',
        'HPE_INVALID_METHOD', `GET ${HEALTH_PATH} HTTP/1.1\r\n${hostField}\r\n`, 400],
      ['a refusal code that is neither the method nor the target',
        'HPE_INVALID_CONSTANT', `FOO ${HEALTH_PATH} HTTP/1.1\r\n${hostField}\r\n`, 400],
      ['an unsupported method on the route', 'HPE_INVALID_METHOD',
        `FOO ${HEALTH_PATH} HTTP/1.1\r\n${hostField}\r\n`, 405],
      ['the same method with no Host field', 'HPE_INVALID_METHOD',
        `FOO ${HEALTH_PATH} HTTP/1.1\r\n\r\n`, 400],
      ['an HTTP/1.0 request, which owes no Host field', 'HPE_INVALID_METHOD',
        `FOO ${HEALTH_PATH} HTTP/1.0\r\n\r\n`, 405],
      ['a lower-case host field', 'HPE_INVALID_METHOD',
        `FOO ${HEALTH_PATH} HTTP/1.1\r\nhost: x\r\n\r\n`, 405],
      ['a field that merely mentions the word host', 'HPE_INVALID_METHOD',
        `FOO ${HEALTH_PATH} HTTP/1.1\r\nUser-Agent: host-probe\r\n\r\n`, 400],
      ['a header block that never terminated, so its absence proves nothing',
        'HPE_INVALID_METHOD', `FOO ${HEALTH_PATH} HTTP/1.1\r\nX-Probe: a\r\n`, 405],
      ['an empty packet', 'HPE_INVALID_URL', '', 400]
    ]) {
      assert.equal(app.refusedRequestStatus(code, Buffer.from(packet, 'latin1')), expected,
        `the classifier's verdict on ${name}`);
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

      for (const shape of bypassCases(address)) {
        if (shape.status === 405) {
          await assertRefusedInsideContract(address, shape);
        }
      }
      const hostField = `Host: ${address.host}:${address.port}\r\n`;
      assert.equal(app.refusedRequestStatus('HPE_INVALID_METHOD',
        Buffer.from(`FOO ${HEALTH_PATH} HTTP/1.1\r\n${hostField}\r\n`)), 405);
      assert.equal(app.refusedRequestStatus('HPE_INVALID_METHOD',
        Buffer.from(`FOO ${HEALTH_PATH} HTTP/1.1\r\n\r\n`)), 400);
    });
  });

async function assertASignalledListenerExitsCleanly() {
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
      // Whatever the assertions found, no listener may outlive the run that started it.
      if (!hasEnded(started.child)) {
        started.child.kill('SIGKILL');
      }
    }
  }
}
