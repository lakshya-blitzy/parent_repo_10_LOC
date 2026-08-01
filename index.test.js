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

// The startup line `--serve` prints, and the whole of it: the application's own name
// and version, the address it bound, and the route it serves. Anchored, so a banner
// that grew a host name, a process identifier or an environment value fails here.
const SERVE_BANNER_PATTERN =
  /^parent_repo_10_LOC 1\.0\.0 health endpoint listening on http:\/\/127\.0\.0\.1:(\d+)\/health\n$/;

// How long a spawned `--serve` process is given to print its banner, and then to honour
// the signal that stops it. Generous enough for a cold start on a loaded machine, short
// enough that a listener which ignores its signal fails an assertion rather than hanging.
const SERVE_TIMEOUT_MS = 15000;



// Bind tests to loopback port 0 to avoid collisions.
const LOOPBACK_HOST = '127.0.0.1';
const EPHEMERAL_PORT = 0;

// Every documented HOST form, and what it must resolve to. A blank or absent value must
// never be read as "every interface", which is the one mistake here that would put the
// endpoint on the network; a padded value is trimmed to the address it names.
const HOST_CASES = [
  [{}, LOOPBACK_HOST],
  [{ HOST: '' }, LOOPBACK_HOST],
  [{ HOST: '   ' }, LOOPBACK_HOST],
  [{ HOST: ' 0.0.0.0 ' }, '0.0.0.0'],
  [{ HOST: '127.0.0.2' }, '127.0.0.2']
];

// Every documented PORT form. All but the last three are malformed in some way, and each
// must fall back rather than abort start-up: a typo in a supervisor's unit file must not
// become a crash loop. 0 is honoured, because it is how an ephemeral port is asked for.
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

// The environment a spawned child sees: this process's, with the overrides applied and
// any key given as undefined removed. Built as a copy so that setting a variable for a
// child never sets it for the suite - process.env is shared by every module in this
// process, and a resolver case or a startup probe must not be observable outside itself.
function childEnvironment(overrides) {
  const environment = Object.assign({}, process.env, overrides);
  for (const name of Object.keys(overrides)) {
    if (overrides[name] === undefined) {
      delete environment[name];
    }
  }
  return environment;
}

// Runs `node index.js --serve` under the given environment, resolves once it has written
// its startup line, and then stops it with the signal a supervisor would send.
//
// This is the only exercise of the --serve branch end to end: everything else in this
// file binds its own server through createServer(), which never reads the environment and
// never installs a signal handler. The child is bounded twice over - a timeout on the
// banner and a timeout on the shutdown - so neither a listener that never reports itself
// nor one that ignores its signal can hang the suite.
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
      // One complete line is the whole banner, and the point at which the listener is
      // known to be bound, so that is when the signal goes.
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

// Bound each exchange so a nonresponding handler fails the test instead of hanging it.
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

test('the pre-existing capability is exported, requiring the module has no effect of its '
  + 'own, the default run still prints it five times, --serve binds only where HOST and '
  + 'PORT say, and a signalled listener exits cleanly', async function () {
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

    // Requiring the module must be silent too, and this file's own require() cannot show
    // that: by the time any test runs the module is already in require.cache, and
    // anything it wrote at load time went to the reporter's streams before the first test
    // was collected. So a fresh process is asked to require it and do nothing else. A
    // write at module scope fails here; so does a listener started at load, because the
    // process would never reach its own exit and the timeout would end the test instead.
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

    // Where the listener is placed is decided by two resolvers, asserted as the pure
    // functions of a mapping they are: no case writes into process.env, which the whole
    // process shares, and none has to bind a socket to be observed.
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

    // And then the branch those resolvers serve, run for real. PORT=0 asks for an
    // ephemeral port, so the check never competes for the default one, and HOST is removed
    // from the child's environment alone so the default bind address is what is observed.
    const served = await serve({ PORT: String(EPHEMERAL_PORT), HOST: undefined });
    const banner = SERVE_BANNER_PATTERN.exec(served.stdout);
    assert.notEqual(banner, null, `the startup line was [${served.stdout}]`);
    const boundPort = Number(banner[1]);
    assert.ok(boundPort > 0, `no ephemeral port was reported: ${boundPort}`);
    assert.notEqual(boundPort, EXPECTED_DEFAULT_PORT,
      'an ephemeral request bound the default port, so PORT=0 was not honoured');
    assert.equal(served.stderr, '', `--serve wrote to stderr: ${served.stderr}`);
    // The signal handler closes the server and exits 0 of its own accord, so a clean
    // status - rather than a termination by signal - is what proves it ran and that the
    // port was released instead of being held until the process was killed.
    assert.ok(served.signalled, 'the child was never signalled, so it printed no banner');
    assert.equal(served.signal, null, `--serve was killed by ${served.signal}`);
    assert.equal(served.code, 0, `--serve exited ${served.code} on SIGTERM`);

    // And the same listener held to the rest of what an operator needs of it: both signals a
    // supervisor sends, a second one arriving while the first is still being honoured, a caller
    // holding a connection it has sent nothing on, and the port given back afterwards.
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

// Every inbound shape Node takes out of the normal request pipeline, paired with the answer the
// contract owes it. A CONNECT is handed to a 'connect' listener and, with none, the socket is
// closed unanswered; an HTTP/1.1 request with no Host is refused by Node itself, ahead of the
// router; a request line the parser refuses is handed to 'clientError'. None of them reaches
// routeRequest, and every one of them must still be answered as JSON with the same three headers
// every routed answer carries. Each shape is asserted by the test that owns the status it is owed:
// the 405 shape below by the method test, the rest by the refusal test. Status lines are written
// out in full rather than composed, so the test states the wire bytes it expects.
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
      // The authority form RFC 9110 defines for CONNECT: a host and port, no path at all.
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
      // The same missing field on a request Node's parser refuses before a request object
      // exists. The classifier makes the check the router makes, and in the same order, so
      // this is a 400 rather than the 405 the method alone would have earned - which is what
      // the Python and Java siblings answer too.
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

// Asserts one of those shapes against the contract. Shared by the two tests below rather than
// owned by a test of its own, so each shape is asserted alongside the routed requests that are
// answered with the same status.
async function assertRefusedInsideContract(address, shape) {
  const context = shape.name;
  const wire = await rawSend(address, shape.request, context);
  const statusLine = wire.head.split('\r\n')[0];
  const body = wire.body.toString('utf8');
  const head = wire.head.toLowerCase();

  // Silence is not one of this contract's answers, so the answer is checked before anything
  // about it: an empty reply never terminates its head and rawSend would already have failed,
  // and a wrong status is reported with the line that arrived.
  assert.equal(statusLine, shape.statusLine, context);
  assert.ok(head.includes(`content-type: ${EXPECTED_MEDIA_TYPE}`),
    `${context}: not served as JSON: [${wire.head}]`);
  assert.ok(!head.includes('text/html'),
    `${context}: answered with markup: [${wire.head}]`);
  assert.ok(head.includes(`cache-control: ${EXPECTED_CACHE_CONTROL}`),
    `${context}: a liveness answer was left cacheable: [${wire.head}]`);
  // RFC 9110 requires Date from a server that has a clock, and this path writes it by hand
  // because no ServerResponse does it here.
  assert.ok(head.includes('date: '), `${context}: no Date was sent: [${wire.head}]`);
  // Nothing is read from the request, so the socket must not be offered for reuse with unread
  // bytes still on it.
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
  // The status line and the body are what the request could have been reflected into; the
  // field names around them are the writer's own.
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
      // A 404 owes no Allow field and must not send one: naming a method that would have
      // worked would be an answer about an address this endpoint does not serve.
      assert.equal(headerValue(response, 'allow'), '', context);
    }

    // The same unknown paths with the methods the route refuses. The target is judged before
    // the method, so a request that is wrong in both ways is answered 404 and not 405 - the
    // precedence both siblings apply as well - and it still advertises nothing. POST and
    // DELETE are routed; OPTIONS and the invented verb FOO are refused by Node's parser
    // first, so this covers the router and the classifier with one matrix.
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

    // The same refusal, for the shapes that never reach the router at all: a CONNECT whose
    // target is not the route, an HTTP/1.1 request with no Host field, and two request lines
    // Node's own parser rejects before a request object exists.
    for (const shape of bypassCases(address)) {
      if (shape.status !== 405) {
        await assertRefusedInsideContract(address, shape);
      }
    }

    // Only the absent field breaks the rule: a field that arrived empty was still sent, and
    // the field name is matched as HTTP compares field names. Both are served, so the refusal
    // above cannot be over-broad, and both are sent over a socket because no client library
    // will omit or misspell the field for you. The third boundary - that the rule belongs to
    // HTTP/1.1 alone - is asserted on the success path by the GET case above and again in the
    // classifier table below, so it is not repeated here.
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

    // The classifier those refusals are routed through, asserted directly as well: it is
    // exported, so every verdict can be checked without a socket. A packet that carries the
    // Host field is judged on its target and then its method; one that does not is a 400
    // whatever they are, because the field is checked first - the order routeRequest applies.
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

      // A CONNECT is the one unsupported method no client will send for you: Node hands it to a
      // 'connect' listener instead of the router, and with none the socket would be closed
      // unanswered. It owes the route the same 405 every other verb does.
      for (const shape of bypassCases(address)) {
        if (shape.status === 405) {
          await assertRefusedInsideContract(address, shape);
        }
      }
      // The verdict behind the raw exchange above, asserted through the exported classifier.
      // The packet carries the Host field a client sends, because without it the answer is
      // not a 405 at all: the field is checked before the method, here as in the router and
      // in both siblings, so the second assertion is the contrast that pins that ordering.
      const hostField = `Host: ${address.host}:${address.port}\r\n`;
      assert.equal(app.refusedRequestStatus('HPE_INVALID_METHOD',
        Buffer.from(`FOO ${HEALTH_PATH} HTTP/1.1\r\n${hostField}\r\n`)), 405);
      assert.equal(app.refusedRequestStatus('HPE_INVALID_METHOD',
        Buffer.from(`FOO ${HEALTH_PATH} HTTP/1.1\r\n\r\n`)), 400);
    });
  });

// Asserted from the default-run case above rather than as a case of its own: the listener is the
// other half of running this file as a program, and it is only worth opting into if it also gives
// the port back, so the signal path is held to the same standard as the banner it prints.
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
