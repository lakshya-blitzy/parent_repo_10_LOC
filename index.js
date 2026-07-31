const http = require('node:http');
const pkg = require('./package.json');

const HEALTH_PATH = '/health';
// The sibling Python and Java implementations emit the identical `Allow` value, so
// the exact `, ` spacing is part of the contract rather than incidental formatting.
const ALLOWED_METHODS = 'GET, HEAD';
// Loopback by default, so the listener stays off external interfaces unless an
// operator opts in by setting HOST.
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
// Bounds the refusal classifier below: a longer request line is treated as
// unintelligible rather than scanned, so one oversized packet cannot drive a
// large string comparison.
const MAX_REQUEST_LINE_LENGTH = 8192;
// RFC 9110 token grammar, which is what separates an extension method the endpoint
// should refuse politely from a request line that is simply not HTTP.
const METHOD_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const SUPPORTED_VERSION = /^HTTP\/1\.[01]$/;

function add(a, b) {
  return a + b;
}

// toISOString() emits milliseconds, so the sub-second fragment is dropped to reach
// the second-precision grammar the contract fixes for all three applications.
function currentTimestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// JSON.stringify preserves insertion order, which is why the keys are written in the
// contract's order. Exactly these four fields: nothing about the host, the process,
// the runtime or the environment is disclosed, and no request data is reflected back.
function healthPayload() {
  return {
    name: pkg.name,
    version: pkg.version,
    timestamp: currentTimestamp(),
    status: 'UP'
  };
}

// Buffer.byteLength so Content-Length counts bytes rather than UTF-16 code units;
// no-store because a cached liveness answer would be worse than none; close because
// the endpoint reads no request body, and a connection reused while unread bytes remain
// lets them be parsed as the next request. Node suppresses the body of a HEAD itself.
function sendJson(res, status, body, extraHeaders) {
  const payload = JSON.stringify(body);
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    Connection: 'close'
  };
  Object.assign(headers, extraHeaders || {});
  res.writeHead(status, headers);
  res.end(payload);
}

// The single routing decision: path first, method second, and every inbound entry
// point below dispatches through here. Query and fragment are stripped as the siblings
// strip them; the error bodies are fixed literals that echo nothing of the request.
function routeRequest(req, res) {
  const path = (req.url || '/').split('?')[0].split('#')[0];
  if (path !== HEALTH_PATH) {
    sendJson(res, 404, { error: 'Not Found' });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'Method Not Allowed' }, { Allow: ALLOWED_METHODS });
    return;
  }
  sendJson(res, 200, healthPayload());
}

// Resuming the stream with no consumer discards any bytes a client sends after it
// has been answered, instead of leaving them in the parser to be read as a request.
function discardBody(req) {
  req.resume();
}

// Both `Expect` events land here, because the header changes nothing about what this
// endpoint owes a caller: it reads no request body, so there is no expectation to meet.
// Left to Node, `100-continue` would be answered with an interim response that invites
// an upload before the route and the method have been looked at, and any other value
// with a bare 417 the siblings never send. Routing instead sends one final response,
// which RFC 9110 permits in place of the interim one.
function handleExpect(req, res) {
  routeRequest(req, res);
  discardBody(req);
}

// Read as latin1 so each byte maps to exactly one character: a rejected packet may
// contain any byte, and a UTF-8 decode would replace the invalid sequences before
// they could be examined.
function requestLineOf(rawPacket) {
  if (!Buffer.isBuffer(rawPacket) && typeof rawPacket !== 'string') {
    return null;
  }
  const limit = MAX_REQUEST_LINE_LENGTH + 2;
  const packet = Buffer.isBuffer(rawPacket)
    ? rawPacket.toString('latin1', 0, Math.min(rawPacket.length, limit))
    : rawPacket.slice(0, limit);
  const terminator = packet.indexOf('\r\n');
  if (terminator < 0 || terminator > MAX_REQUEST_LINE_LENGTH) {
    return null;
  }
  return packet.slice(0, terminator);
}

function isRequestTarget(value) {
  if (value.length === 0) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) {
      return false;
    }
  }
  return true;
}

// A refused request never becomes a req/res pair, but its packet still carries the
// request line the router would have used, so classifying it here keeps one contract
// across both paths. Any other refusal leaves the request malformed, so it stays a 400.
function refusedRequestStatus(code, rawPacket) {
  if (code !== 'HPE_INVALID_METHOD' && code !== 'HPE_INVALID_URL') {
    return 400;
  }
  const requestLine = requestLineOf(rawPacket);
  if (requestLine === null) {
    return 400;
  }
  // RFC 9112 fixes the request line as three single-space-separated tokens.
  const parts = requestLine.split(' ');
  if (parts.length !== 3) {
    return 400;
  }
  const method = parts[0];
  const target = parts[1];
  if (!METHOD_TOKEN.test(method) || !SUPPORTED_VERSION.test(parts[2])
    || !isRequestTarget(target)) {
    return 400;
  }
  // Stripped exactly as the router strips it and compared as it arrived: never
  // percent-decoded, so no encoded spelling of the route is mistaken for the route.
  const path = target.split('?')[0].split('#')[0];
  if (path !== HEALTH_PATH) {
    return 404;
  }
  // The parser accepts GET and HEAD, so a refusal naming one of them was caused by
  // something else in the request; that is malformed, not unsupported.
  if (method === 'GET' || method === 'HEAD') {
    return 400;
  }
  return 405;
}

// The socket-level counterpart of sendJson, for a refusal that has no ServerResponse
// to write through. The body comes from the status code alone, so nothing from the
// request can reach it. Date is written by hand because nothing else does on this path,
// and RFC 9110 requires it on a 4xx from a server that has a clock.
function sendRawJson(socket, status) {
  const reason = http.STATUS_CODES[status];
  const payload = JSON.stringify({ error: reason });
  const head = [
    `HTTP/1.1 ${status} ${reason}`,
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(payload)}`,
    'Cache-Control: no-store',
    `Date: ${new Date().toUTCString()}`
  ];
  if (status === 405) {
    head.push(`Allow: ${ALLOWED_METHODS}`);
  }
  head.push('Connection: close');
  socket.end(`${head.join('\r\n')}\r\n\r\n${payload}`);
}

// A request Node's own parser refuses never reaches the router, because no request
// object is created for it; the parser hands the refused packet here instead.
function handleClientError(error, socket) {
  if (error.code === 'ECONNRESET' || !socket.writable) {
    return;
  }
  sendRawJson(socket, refusedRequestStatus(error.code, error.rawPacket));
}

// Returned unbound so a caller can choose its address, which is what lets a test suite
// listen on port 0. Every entry point Node offers for an inbound request is wired to
// application code here, so no answer this listener produces is a framework default.
function createServer() {
  const server = http.createServer(routeRequest);
  server.on('clientError', handleClientError);
  server.on('checkContinue', handleExpect);
  server.on('checkExpectation', handleExpect);
  return server;
}

// An unset, blank, non-numeric or out-of-range PORT falls back to the default rather
// than aborting start-up, while 0 is honoured as a request for an ephemeral port. The
// signal handlers are installed here, not at module scope, so requiring registers none.
function startServer() {
  const configuredHost = (process.env.HOST || '').trim();
  const host = configuredHost === '' ? DEFAULT_HOST : configuredHost;
  const configuredPort = (process.env.PORT || '').trim();
  // Strictly numeric before parsing, so a value such as '3000abc' is rejected
  // outright rather than read as 3000.
  const requestedPort = /^\d+$/.test(configuredPort)
    ? Number.parseInt(configuredPort, 10)
    : Number.NaN;
  const port = Number.isInteger(requestedPort) && requestedPort <= 65535
    ? requestedPort
    : DEFAULT_PORT;

  const server = createServer();
  // Left unhandled a bind failure prints the configured host, Node's own version and a
  // stack trace; this reduces it to one fixed sentence naming the variables to check
  // without echoing either value. exitCode rather than exit() so the line is flushed.
  server.once('error', function () {
    const failure = 'could not bind the health endpoint; check HOST and PORT';
    console.error(`${pkg.name} ${pkg.version} ${failure}`);
    process.exitCode = 1;
  });
  server.listen(port, host, function () {
    // The port is read back from the running server so an ephemeral bind
    // (PORT=0) reports the port actually assigned rather than the one requested.
    const boundPort = server.address().port;
    console.log(`${pkg.name} ${pkg.version} health endpoint listening on `
      + `http://${host}:${boundPort}${HEALTH_PATH}`);
  });

  const shutdown = function () {
    // A connection with no request in flight is released first: close() would wait
    // for it, so a caller that opened a socket and sent nothing would delay the exit.
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
  refusedRequestStatus,
  createServer,
  startServer,
  HEALTH_PATH,
  ALLOWED_METHODS,
  DEFAULT_HOST,
  DEFAULT_PORT
};
