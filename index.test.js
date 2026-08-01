const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
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

// FOO exercises Node's parser-refusal path; the other verbs reach routing.
const REJECTED_METHODS = ['POST', 'OPTIONS', 'DELETE', 'FOO'];

const NON_ROUTES = ['/nope', '/health/', '/HEALTH', '/%68ealth', '//health'];

// Bind tests to loopback port 0 to avoid collisions.
const LOOPBACK_HOST = '127.0.0.1';
const EPHEMERAL_PORT = 0;

// Bound exchanges so a nonresponding handler cannot hang the suite.
const EXCHANGE_TIMEOUT_MS = 5000;

// Poll across a second boundary to verify a per-request timestamp.
const FRESHNESS_TIMEOUT_MS = 5000;
const FRESHNESS_POLL_MS = 100;

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

// Use a raw socket to count bytes after the HTTP head; clients suppress HEAD bodies.
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

test('the pre-existing addition capability is exported and still returns 12',
  function () {
    assert.equal(typeof app.add, 'function');
    assert.equal(app.add(5, 7), 12);
    assert.equal(app.add(0, 0), 0);
    assert.equal(app.add(-2, 5), 3);
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
