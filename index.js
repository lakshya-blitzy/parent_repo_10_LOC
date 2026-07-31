/**
 * Apex application of the parent/child/nested repository composition.
 *
 * Requiring this module has no side effect: it writes nothing to stdout, binds
 * no socket and registers no signal handler. Run directly with no arguments it
 * prints the computed sum exactly as it always has; run with `--serve` it
 * starts an HTTP listener that answers `GET` and `HEAD` on `/health` with a
 * compact JSON document reporting the application name, version, the current
 * UTC instant and a status of `UP`. The optional `HOST` and `PORT` environment
 * variables override the bind address.
 *
 * The response shape is fixed by a contract shared with the sibling Python and
 * Java applications of this composition. Those repositories have no dependency
 * mechanism between them, so the four-field builder is implemented once per
 * language against that single contract rather than factored into a library.
 */

const http = require('node:http');
// The manifest is this application's only source of truth for its identity.
// Loading it adds a second entry to require.cache, which is expected.
const pkg = require('./package.json');

/** Absolute request path the health document is served from. */
const HEALTH_PATH = '/health';
/**
 * Emitted verbatim as the `Allow` header value of a 405. The sibling Python and
 * Java implementations emit the identical string, so the exact `, ` spacing is
 * part of the contract rather than incidental formatting.
 */
const ALLOWED_METHODS = 'GET, HEAD';
/**
 * Loopback by default, so the listener stays off external interfaces unless an
 * operator opts in by setting `HOST`.
 */
const DEFAULT_HOST = '127.0.0.1';
/**
 * 3000 here, 8000 in the Python application and 8080 in the Java one, so all
 * three applications of the composition can run side by side on one host.
 */
const DEFAULT_PORT = 3000;

/**
 * Sums two operands.
 *
 * This is the application's pre-existing capability, preserved verbatim and now
 * exported so it can be asserted from a test. Its behaviour is unchanged.
 *
 * @param {number} a left operand
 * @param {number} b right operand
 * @returns {number} the sum of the two operands
 */
function add(a, b) {
  return a + b;
}

/**
 * The current UTC instant as `YYYY-MM-DDTHH:MM:SSZ`.
 *
 * `toISOString()` emits milliseconds, so the sub-second fragment is dropped to
 * reach the second-precision RFC 3339 grammar the contract fixes for all three
 * applications: `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$`.
 *
 * @returns {string} a second-precision UTC timestamp
 */
function currentTimestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Builds the health document as a fresh object in wire key order.
 *
 * A new object is returned on every call and the timestamp is generated per
 * request, never cached, so consecutive probes observe distinct instants.
 * `JSON.stringify` preserves insertion order, which is why the keys are written
 * in the contract's order of `name`, `version`, `timestamp`, `status`.
 *
 * The document carries exactly these four fields. Nothing about the host, the
 * process, the runtime or the environment is disclosed, and no request data is
 * reflected back.
 *
 * @returns {{name: string, version: string, timestamp: string, status: string}}
 *          the health document
 */
function healthPayload() {
  return {
    name: pkg.name,
    version: pkg.version,
    timestamp: currentTimestamp(),
    status: 'UP'
  };
}

/**
 * Writes `body` as compact JSON with an accurate `Content-Length`.
 *
 * `Buffer.byteLength` is used rather than the string length so the header
 * counts bytes rather than UTF-16 code units. `Cache-Control: no-store` is
 * always sent because the timestamp is generated per request and a cached
 * liveness answer would be worse than none at all.
 *
 * `HEAD` is deliberately not special-cased: Node suppresses the body of a
 * `HEAD` response itself, so this single path yields the full `GET` header set,
 * including the `Content-Length` a `GET` would have returned, with a zero-byte
 * body.
 *
 * @param {http.ServerResponse} res response to write to
 * @param {number} status HTTP status code
 * @param {object} body value to serialise as the response body
 * @param {Object<string, string>} [extraHeaders] additional headers, used by the
 *        405 path to attach `Allow`
 * @returns {void}
 */
function sendJson(res, status, body, extraHeaders) {
  const payload = JSON.stringify(body);
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  };
  Object.assign(headers, extraHeaders || {});
  res.writeHead(status, headers);
  res.end(payload);
}

/**
 * Creates the health server without binding it.
 *
 * The server is returned unbound so a caller can choose its address, which is
 * what lets a test suite listen on port `0` and take an ephemeral port.
 *
 * Routing is deliberately narrow: `/health` is the only request path served,
 * and no error response contains the requested path, the requested method, a
 * header value, a host name, a file path, an environment value or a stack
 * trace. Every error body is a fixed literal string.
 *
 * @returns {http.Server} an unbound server implementing the health contract
 */
function createServer() {
  const server = http.createServer(function (req, res) {
    // The query string is stripped before the comparison so a probe that adds
    // one, such as /health?probe=lb, still reaches the health document.
    const path = (req.url || '/').split('?')[0];
    // Path first, then method: the same ordering as the Java implementation.
    if (path !== HEALTH_PATH) {
      sendJson(res, 404, { error: 'Not Found' });
      return;
    }
    // GET and HEAD only. RFC 9110 expects both of a general-purpose server, and
    // requires a 405 to advertise the methods that are permitted; the refused
    // verb itself is never echoed back.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method Not Allowed' }, { Allow: ALLOWED_METHODS });
      return;
    }
    sendJson(res, 200, healthPayload());
  });

  // A request Node's own parser refuses never reaches the handler above, so the
  // parser answers it directly. That is the one class of request this
  // application cannot route: a method name outside `http.METHODS`, for
  // instance, is rejected before the request object exists, and Node offers no
  // supported way to widen the parser's method set. This hook keeps that path
  // inside the JSON contract all the same, answering with the same media type
  // and cache directive as every other response and a fixed literal body that
  // reflects nothing from the malformed request.
  server.on('clientError', function (error, socket) {
    if (error.code === 'ECONNRESET' || !socket.writable) {
      return;
    }
    const payload = JSON.stringify({ error: 'Bad Request' });
    socket.end(
      'HTTP/1.1 400 Bad Request\r\n'
      + 'Content-Type: application/json\r\n'
      + `Content-Length: ${Buffer.byteLength(payload)}\r\n`
      + 'Cache-Control: no-store\r\n'
      + 'Connection: close\r\n'
      + '\r\n'
      + payload
    );
  });

  return server;
}

/**
 * Binds the health endpoint and reports the address it bound.
 *
 * `HOST` and `PORT` are read from the environment. An unset or blank `HOST`
 * keeps the loopback default; an unset, blank, non-numeric or out-of-range
 * `PORT` falls back to {@link DEFAULT_PORT} instead of aborting start-up, while
 * `0` is honoured as a request for an ephemeral port. Nothing else is read from
 * the environment and no other argument is interpreted.
 *
 * The `SIGINT` and `SIGTERM` handlers are installed here rather than at module
 * scope so that requiring this module registers nothing.
 *
 * @returns {http.Server} the listening server, so a caller can close it
 */
function startServer() {
  const configuredHost = (process.env.HOST || '').trim();
  const host = configuredHost === '' ? DEFAULT_HOST : configuredHost;
  const configuredPort = (process.env.PORT || '').trim();
  // A strictly numeric test is applied before parsing so a value such as
  // '3000abc' is rejected outright rather than read as 3000, matching the
  // sibling implementations whose parsers refuse it.
  const requestedPort = /^\d+$/.test(configuredPort)
    ? Number.parseInt(configuredPort, 10)
    : Number.NaN;
  const port = Number.isInteger(requestedPort) && requestedPort <= 65535
    ? requestedPort
    : DEFAULT_PORT;

  const server = createServer();
  // A bind failure, such as an address already in use, is reported as one line
  // on stderr with a deterministic exit code rather than as an uncaught
  // exception; stdout stays reserved for the single start-up line below.
  server.on('error', function (error) {
    process.stderr.write(`failed to bind ${host}:${port}: ${error.code || error.message}\n`);
    process.exit(1);
  });
  server.listen(port, host, function () {
    // The port is read back from the running server so an ephemeral bind
    // (PORT=0) reports the port actually assigned rather than the one requested.
    const boundPort = server.address().port;
    console.log(`${pkg.name} ${pkg.version} health endpoint listening on `
      + `http://${host}:${boundPort}${HEALTH_PATH}`);
  });

  const shutdown = function () {
    // Idle keep-alive sockets are released first: close() otherwise waits for
    // them, and a probe that left a connection open would delay the exit.
    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }
    server.close(function () {
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}

// Script behaviour, reached only when this file is the entry point. The listener
// is gated behind an exact `--serve` match because a process that binds a socket
// never exits: starting one unconditionally would replace the output this
// application has always produced. Any other invocation, including none at all,
// prints the computed sum exactly as before.
if (require.main === module) {
  if (process.argv.includes('--serve')) {
    startServer();
  } else {
    const result = add(5, 7);
    console.log(result);
    console.log(result);
    console.log(result);
    console.log(result);
    console.log(result);
  }
}

module.exports = {
  add,
  currentTimestamp,
  healthPayload,
  sendJson,
  createServer,
  startServer,
  HEALTH_PATH,
  ALLOWED_METHODS,
  DEFAULT_HOST,
  DEFAULT_PORT
};
