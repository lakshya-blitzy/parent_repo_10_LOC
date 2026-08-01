# parent_repo_10_LOC

## Health endpoint

The JavaScript application at the apex of this composition answers a read-only
health check at `GET /health`. The listener is opt-in: it starts only when
`index.js` is run with `--serve`, so every invocation that worked before this
endpoint existed still behaves exactly as it did.

### Route

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Returns the health document |
| `HEAD` | `/health` | Returns the `GET` headers with no body |

`HEAD` is answered wherever `GET` is, as RFC 9110 expects of a general-purpose
server. There is no other route. A query string is ignored when the route is
matched, so `GET /health?probe=lb` is answered exactly like `GET /health`.

### Response

`GET /health` returns `200 OK` and this compact JSON document:

```json
{"name":"parent_repo_10_LOC","version":"1.0.0","timestamp":"2026-07-31T06:20:00Z","status":"UP"}
```

| Field | Type | Value |
|---|---|---|
| `name` | string | `parent_repo_10_LOC` — this application's name |
| `version` | string | `1.0.0` — this application's version |
| `timestamp` | string | The UTC instant at which the request was answered |
| `status` | string | `UP` — the literal healthy value |

All four values are JSON strings, the keys are always serialised in the order
`name`, `version`, `timestamp`, `status`, and the body carries no whitespace
between tokens: the document above is exactly 96 bytes. Those four fields are
the whole body — nothing else is reported, and no host name, process identifier,
uptime, runtime detail, environment value or downstream check appears in it.

`name` and `version` are read from `package.json`, which is their only source of
truth: `index.js` requires the manifest rather than restating either value.

`timestamp` is generated per request as a second-precision UTC instant of the
form `YYYY-MM-DDTHH:MM:SSZ`, matching
`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$`.

### Response headers

Every answer, success or error, carries the same header fields:

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `Content-Length` | The body's length in bytes |
| `Cache-Control` | `no-store` |
| `Connection` | `close` |

`Cache-Control: no-store` is mandatory here rather than cosmetic. The timestamp
is generated per request, so a cached liveness answer would be worse than no
answer at all; the directive stops any intermediary from retaining a stale one.

`Connection: close` is the connection policy the three applications of this
composition share, and it is deliberate rather than incidental: this endpoint
never reads a request body, and ending the connection means body bytes left
unread can never be parsed as a following request on the same stream. A probe
therefore gets one answer per connection, which is all a liveness check needs.

Every response also carries a `Date` field, which RFC 9110 expects of a server
that has a clock. Beyond those, and the `Allow` field a `405` adds, nothing is
sent — in particular no `Server` field, so the response says nothing about the
runtime underneath it. Field names are case-insensitive under the same document,
so compare them case-insensitively rather than matching a spelling: the three
applications of this composition are written in three languages and none of them
promises a particular capitalisation.

### Status semantics

| Request | Response |
|---|---|
| `GET /health` | `200 OK` with the four-field body above |
| `HEAD /health` | `200 OK`, the same headers (including the `Content-Length` a `GET` would return), and a zero-byte body |
| Any other method on `/health` | `405 Method Not Allowed` with `Allow: GET, HEAD` and body `{"error":"Method Not Allowed"}` |
| Any other path | `404 Not Found` with body `{"error":"Not Found"}` |

Both error bodies are fixed strings derived from the status code alone. Neither
ever repeats the path that was asked for or the method that was used, and
neither is ever HTML. An unrecognised method — `OPTIONS`, or a verb invented on
the spot — is answered `405` with the same JSON envelope and the same `Allow`
field, never `501`.

A request too malformed to be routed at all is answered `400 Bad Request` with
body `{"error":"Bad Request"}`: an HTTP/1.1 request that carries no `Host` field,
for instance, or a request line the parser refuses. Those answers are written
inside the same contract as every other one — the same header fields, always
`application/json`, and a body derived from the status code — so no path, method,
header value or body from the request can reach a caller on any status path.

### How the request target is matched

The target is compared to `/health` exactly as it arrived, with only a query
string or fragment removed. It is never percent-decoded, so `/%68ealth` is a
different target rather than another spelling of the route, and it is never
re-normalised, so `/health/`, `/HEALTH` and `//health` are different targets too.
Each of them is answered `404` with the fixed envelope. The path is decided
before the method, so an unsupported method on a target that is not the route is
answered `404` rather than `405`.

Point probes at the exact target `/health`, and note that a base URL already
ending in `/` concatenated with `/health` produces `//health`, one of them.

### Running the server

```bash
node index.js --serve
```

or, equivalently, through the script the manifest declares:

```bash
npm start
```

One startup line names the address it bound, and it then serves until the
process is stopped:

```text
parent_repo_10_LOC 1.0.0 health endpoint listening on http://127.0.0.1:3000/health
```

Probe it from another shell:

```bash
curl -s http://127.0.0.1:3000/health
```

`Ctrl-C` stops it, and so does `SIGTERM`: the listener stops accepting, a
response already being written is allowed to finish, and the process then exits
`0` without printing anything further.

### Configuration

Two optional environment variables are read. Both have defaults, so `--serve`
needs no configuration at all.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | TCP port to bind; `0` requests an ephemeral port from the operating system, which the startup line then reports |
| `HOST` | `127.0.0.1` | Bind address; loopback by default, so the listener is not exposed on external interfaces unless an operator opts in |

```bash
PORT=3000 HOST=127.0.0.1 node index.js --serve
```

`PORT` is read as an unsigned run of ASCII decimal digits naming a value from
`0` to `65535`; leading zeros are allowed, so `PORT=000080` names port 80. Every
other value falls back to `3000` rather than failing to start — blank,
non-numeric such as `3000abc`, signed such as `+3000`, and out of range such as
`65536`. None of them aborts start-up and none of them prints a stack trace:

```bash
PORT=65536 node index.js --serve   # binds 3000, the documented fallback
```

A blank or whitespace-only `HOST` falls back to loopback for the same reason. If
the chosen address cannot be bound at all, the process writes one fixed line
naming the two variables to check — without echoing either value — and exits `1`.

The three applications of this composition default to different ports — `3000`,
`8000` and `8080` — so all three can serve `/health` side by side on one host.

### Existing behaviour is unchanged

Run with no arguments, `index.js` does exactly what it always did:

```bash
node index.js
```

```text
12
12
12
12
12
```

It prints that value five times — 15 bytes, byte for byte as before — writes
nothing to standard error, and exits `0`. The HTTP listener starts **only** when
`--serve` is passed, and only for that exact token. That gate is the whole reason
the flag exists: a process that binds a socket never exits, so an unconditional
listener would have replaced the original behaviour instead of adding to it.

Requiring the module is side-effect free as well. It prints nothing and binds
nothing, and it returns the pre-existing `add` alongside the health endpoint's
own functions and constants, so that capability is directly assertable:

```bash
node -e "const app = require('./index.js'); console.log(app.add(5, 7));"
```

### Tests

The suite is run by hand from this directory; nothing runs it automatically.

```bash
node --test
```

or, equivalently:

```bash
npm test
```

Default discovery finds `index.test.js` beside `index.js` and reports `# tests 7`
with `# pass 7` and `# fail 0`. The seven tests cover the pre-existing `add`
behaviour **and the no-argument program itself** — run in a real child process,
with its standard output, its standard error and its exit status all compared
byte for byte, so the five writes are proven rather than assumed and a listener
that started without the flag would fail the suite — the health document with its
timestamp grammar and its per-request freshness, `HEAD` over both a client and a
raw socket, every `404` target above, every method the route rejects including an
invented verb, the requests that never reach the router at all, and a signal
ending the listener promptly while a caller holds a connection it never used.

The suite is built only from what the runtime already ships — `node:test`,
`node:assert/strict`, `node:net`, `node:child_process` and the global `fetch` —
and every server it exercises is bound on port `0`, so it takes an ephemeral port
and never collides with a `--serve` you already have running.

A syntax-only check, if that is all you need:

```bash
node --check index.js
```

### Requirements

- **Node.js `>= 18.0.0`**, as declared in `package.json` under `engines.node`.
  Node 18 is where `node:test` and the global `fetch` the suite uses arrive.
- **No dependencies.** The application and its suite are built entirely from
  Node's standard library, so there is nothing to install and no lock file to
  resolve: `node index.js` works immediately after checkout. `package.json`
  declares no `dependencies` and no `devDependencies`, and it deliberately omits
  a `type` field so `index.js` keeps resolving as CommonJS.

### Operational notes

The endpoint is served by `node:http` from the standard library, and the exposure
it adds is bounded deliberately:

- the listener binds `127.0.0.1` unless an operator sets `HOST`;
- the body carries only the four fields above, and no request data is ever echoed
  back on any status path — including the paths a request takes when it is
  refused before routing;
- the response names this application and its version, and nothing about the
  runtime it happens to be built on;
- the endpoint reads no request body and exposes no dynamic input path;
- nothing about a caller reaches the process output: `--serve` prints its single
  startup banner and then stays silent for as long as it runs.

The child submodule and the nested submodule serve the same four-field `/health`
contract from their own applications, each with its own default port and its own
commands; see `child_repo_10_LOC/README.md` and the nested README it points to.
