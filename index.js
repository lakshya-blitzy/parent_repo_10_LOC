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
// The same bound for a refused packet's header block, set to Node's own default
// maximum header size: a block longer than the parser would ever have accepted is
// treated as out of view rather than scanned.
const MAX_HEADER_BLOCK_LENGTH = 16384;
// The only version whose messages must carry a Host field; HTTP/1.0 need not.
const HTTP_1_1 = 'HTTP/1.1';
// RFC 9110 token grammar, which is what separates an extension method the endpoint
// should refuse politely from a request line that is simply not HTTP.
const METHOD_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const SUPPORTED_VERSION = /^HTTP\/1\.[01]$/;
// How long a shutdown lets a response in flight finish before the sockets carrying it are
// destroyed. Long enough that an answer already being written completes, short enough that a
// supervisor's signal is honoured promptly rather than at the end of its grace period.
const SHUTDOWN_GRACE_MS = 250;

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

// Whether a parsed request is an HTTP/1.1 message carrying no Host field, which RFC 9112
// requires a server to answer with a 400 - and which it requires of no HTTP/1.0 message, so
// only 1.1 is held to it. Node checks this itself, but its rejection answers with a chunked,
// bodiless 400 written before any code here is reached - no Content-Type, no Content-Length,
// no Cache-Control and no JSON - so the check is made here instead, with Node's own one turned
// off at createServer. One predicate serves both paths that receive a parsed request, the
// router and the CONNECT listener, so neither can drift from the other's ordering; the packet
// counterpart for a request the parser refused outright is lacksHostField. A request whose
// header map is missing entirely is not treated as one that omitted the field: an absent map
// is not evidence about what was sent, and this predicate answers a question about the wire.
function lacksHostHeader(req) {
  const fields = req.headers || {};
  return req.httpVersionMajor === 1 && req.httpVersionMinor === 1
    && fields.host === undefined;
}

// The single routing decision: Host first, then path, then method - the order the Python and
// Java siblings apply, so a request that is wrong in more than one way is answered the same way
// by all three. Every inbound entry point below dispatches through here or, where there is no
// ServerResponse to write through, applies the same ordering against the same predicates.
// Query and fragment are stripped as the siblings strip them; the error bodies are fixed
// literals that echo nothing of the request.
function routeRequest(req, res) {
  if (lacksHostHeader(req)) {
    sendJson(res, 400, { error: 'Bad Request' });
    return;
  }
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

// The field lines of a refused packet's header block, or null when the blank line that
// terminates the block is not in view. Both terminators are looked for, because a client
// that ends its lines with a bare LF still produces a block a parser would accept.
// Bounded as MAX_HEADER_BLOCK_LENGTH describes, and read as latin1 for the reason given
// on requestLineOf: a refused packet may contain any byte.
function headerFieldsOf(rawPacket) {
  if (!Buffer.isBuffer(rawPacket) && typeof rawPacket !== 'string') {
    return null;
  }
  const packet = Buffer.isBuffer(rawPacket)
    ? rawPacket.toString('latin1', 0, Math.min(rawPacket.length, MAX_HEADER_BLOCK_LENGTH))
    : rawPacket.slice(0, MAX_HEADER_BLOCK_LENGTH);
  const crlf = packet.indexOf('\r\n\r\n');
  const lf = packet.indexOf('\n\n');
  let terminator = crlf;
  if (terminator < 0 || (lf >= 0 && lf < terminator)) {
    terminator = lf;
  }
  if (terminator < 0) {
    return null;
  }
  // The first line is the request line, so the fields are everything after it.
  return packet.slice(0, terminator).split(/\r?\n/).slice(1);
}

// Whether a refused packet carried no Host field. Matched at the start of a line and
// case-insensitively, so a value that merely mentions the word - `User-Agent: host-probe`
// - is never taken for the field, and a folded continuation line, which begins with
// whitespace, never is either. A packet whose header block is not in view answers false:
// not seeing the field is not the same as knowing it was never sent.
function lacksHostField(rawPacket) {
  const fields = headerFieldsOf(rawPacket);
  if (fields === null) {
    return false;
  }
  return !fields.some(function (field) {
    return /^host:/i.test(field);
  });
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
  // Host before path before method, which is the order routeRequest applies, so a request
  // wrong in more than one way is answered the same whether the parser accepted it or not -
  // and the same way the Python and Java siblings answer it. RFC 9112 requires the field of
  // every HTTP/1.1 message and of no HTTP/1.0 one.
  if (parts[2] === HTTP_1_1 && lacksHostField(rawPacket)) {
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

// A CONNECT request is taken out of the normal request pipeline by Node, which hands it to a
// 'connect' listener and, when there is none, closes the socket without answering at all. Silence
// is not one of this contract's answers, so the request is routed here instead - with the same
// Host-then-target ordering, through the same socket-level writer a refused request uses. There is
// no ServerResponse to write through on this path, and no body to serve either: CONNECT is never
// GET or HEAD, so the route can only owe it a 405, and any other target a 404 - unless the request
// is an HTTP/1.1 one with no Host, which is answered 400 before either is looked at, exactly as
// routeRequest and refusedRequestStatus answer it. Being handed a request outside the normal
// pipeline is not a reason to judge it by a different order. (An Upgrade request needs no
// counterpart: Node leaves those in the normal pipeline, where routeRequest answers them.)
function handleConnect(req, socket) {
  if (!socket || !socket.writable) {
    return;
  }
  if (lacksHostHeader(req)) {
    sendRawJson(socket, 400);
    return;
  }
  const path = (req.url || '').split('?')[0].split('#')[0];
  sendRawJson(socket, path === HEALTH_PATH ? 405 : 404);
}

// Returned unbound so a caller can choose its address, which is what lets a test suite
// listen on port 0. Every entry point Node offers for an inbound request is wired to
// application code here, so no answer this listener produces is a framework default.
function createServer() {
  // requireHostHeader is turned off so that Node's own bodiless, chunked 400 cannot be written
  // ahead of the router; lacksHostHeader makes the same check on both paths that receive a
  // parsed request, and each answers it through this contract's own writer.
  const server = http.createServer({ requireHostHeader: false }, routeRequest);
  server.on('clientError', handleClientError);
  server.on('checkContinue', handleExpect);
  server.on('checkExpectation', handleExpect);
  server.on('connect', handleConnect);
  return server;
}

// Loopback unless HOST names something, so the listener stays off external interfaces
// by default; a padded value is trimmed to the address it names rather than handed to
// the socket with its spaces. The mapping is a parameter, defaulting to the real
// environment, because reading it and deciding what it means are separate concerns:
// as a pure function of a mapping, every documented form is exercisable without a test
// having to write into process.env, which every other module in the process shares.
function resolveHost(env) {
  const configured = ((env || process.env).HOST || '').trim();
  return configured === '' ? DEFAULT_HOST : configured;
}

// An unset, blank, non-numeric or out-of-range PORT falls back to the default rather
// than aborting start-up, while 0 is honoured as a request for an ephemeral port.
// The mapping is a parameter for the reason given on resolveHost.
function resolvePort(env) {
  const configured = ((env || process.env).PORT || '').trim();
  // Strictly numeric before parsing, so a value such as '3000abc' is rejected
  // outright rather than read as 3000, and the signed forms '+3000' and '-0' with it:
  // the siblings screen the same way, so the three resolve one value from one string.
  const requested = /^\d+$/.test(configured)
    ? Number.parseInt(configured, 10)
    : Number.NaN;
  return Number.isInteger(requested) && requested <= 65535 ? requested : DEFAULT_PORT;
}

// Binds the address the environment resolves to and reports it. The signal handlers are
// installed here, not at module scope, so requiring this module registers none.
function startServer() {
  const host = resolveHost();
  const port = resolvePort();

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

  let closing = false;
  const shutdown = function () {
    // A second signal while the first is still being honoured must not start over: close() would
    // report ERR_SERVER_NOT_RUNNING and another timer would be armed for nothing.
    if (closing) {
      return;
    }
    closing = true;
    // Stop accepting, then exit as soon as the last connection has gone.
    server.close(function () {
      process.exit(0);
    });
    // A connection with no request in flight is released first, because close() would otherwise
    // wait for it.
    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }
    // That is not enough on its own: a caller that opened a socket and sent nothing - which is
    // exactly what a load-balancer TCP probe and a port scanner do, and this endpoint attracts
    // both - is not counted as idle, so close() would wait on it indefinitely and the process
    // would outlive its signal until the peer hung up or SIGKILL arrived. Destroying every
    // remaining connection after a short grace window bounds the exit while still letting a
    // response already being written finish. unref() so the timer itself never keeps the loop
    // alive once there is nothing left to wait for.
    const escalation = setTimeout(function () {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
    }, SHUTDOWN_GRACE_MS);
    escalation.unref();
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
  resolveHost,
  resolvePort,
  startServer,
  HEALTH_PATH,
  ALLOWED_METHODS,
  DEFAULT_HOST,
  DEFAULT_PORT
};
