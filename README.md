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
truth: `index.js` requires the manifest rather than restating either value. Change
them there and the endpoint reports the new values; nothing else needs editing.

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
| A request the endpoint cannot act on | `400 Bad Request` with body `{"error":"Bad Request"}` |

All three error bodies are fixed strings derived from the status code alone. None
of them ever repeats the path that was asked for or the method that was used, and
none of them is ever HTML. An unrecognised method — `OPTIONS`, or a verb invented
on the spot — is answered `405` with the same JSON envelope and the same `Allow`
field, never `501`. A `CONNECT` is answered too — `405` on the route and `404`
anywhere else — because silence is not one of this contract's answers.

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
re-normalised: a run of slashes is never collapsed and a dot segment is never
resolved, so `/health/`, `/HEALTH`, `//health`, `///health` and `/a/../health` are
different targets too, as is the absolute form `http://host/health`. Each of them
is answered `404` with the fixed envelope. The path is decided before the method,
so an unsupported method on a target that is not the route is answered `404`
rather than `405`.

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

`SIGINT` — what `Ctrl-C` sends — and `SIGTERM` are both handled: the listener
stops accepting, a response already being written is allowed to finish, the
connections it still holds are released, and the process then exits `0` without
printing anything further. A supervisor's signal therefore frees the port promptly
rather than at the end of a grace period.

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

`PORT` is read as an unsigned run of ASCII decimal digits, and it is the
**significant** digits — whatever is left once any leading zeros are dropped —
that have to name a value from `0` to `65535`. Leading zeros are ignored however
many of them there are, so `PORT=000080` and a value padded with four thousand
zeros both name port 80, while a value of nothing but zeros names port `0` and so
requests an ephemeral one. Every value that fails that reading falls back to
`3000` rather than failing to start — blank, non-numeric such as `3000abc`,
signed such as `+3000`, separated such as `30_00`, fractional such as `8.5`,
written in the digits of another script, and any significant run out of range,
whether that is `65536`, `99999` or four thousand nines. None of them throws, so a
malformed value never aborts start-up and never prints a stack trace:

```bash
PORT=65536 node index.js --serve   # binds 3000, the documented fallback
```

A blank or whitespace-only `HOST` falls back to loopback for the same reason. If
the address cannot be bound — most often because something else already holds the
port — one fixed sentence is written to standard error and the process exits `1`,
naming the two variables to check without echoing either value:

```text
parent_repo_10_LOC 1.0.0 could not bind the health endpoint; check HOST and PORT
```

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

It prints that value five times — 5 lines, 15 bytes, md5
`b07373a80ad21069e41be538e6506d00`, byte for byte as before — writes nothing to
standard error, and exits `0`. The HTTP listener starts **only** when
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

Default discovery finds `index.test.js` beside `index.js` and reports `# tests 5`
with `# pass 5` and `# fail 0`. The five tests cover:

- **the program itself** — the pre-existing `add` behaviour; a fresh process asked
  only to `require` the module, which must write nothing on either stream and exit
  `0`, so a side effect at module load fails the suite rather than hiding inside
  it; the no-argument run, in a real child process, with its five lines, its byte
  count, its empty standard error and its exit status all compared byte for byte,
  so the five writes are proven rather than assumed and a listener that started
  without the flag would fail the suite; every documented `HOST` and `PORT` form,
  asserted through the two resolvers as the pure functions of a mapping they are,
  so no case has to write into the `process.env` the whole process shares; and
  `--serve` itself, spawned with `PORT=0`, which must announce the ephemeral port
  it was actually given, write nothing but that one banner line, and exit `0` on
  `SIGINT` and on `SIGTERM` — promptly, while a caller holds a connection it has
  sent nothing on, giving the port back rather than being killed still holding it;
- **`GET /health`** — the status, the contract header fields, the four-field
  document with its key order and a byte-accurate `Content-Length`, the
  `?probe=lb` form, an `HTTP/1.0` request that omits `Host`, and a fresh timestamp
  on a later response;
- **`HEAD /health`** — the `GET` header set with a zero-byte body, counted over a
  raw socket as well as through a client;
- **every target that is not the route** — `404` for each of them, and `400` for
  the requests the router never sees;
- **every method the route rejects** — `405` with its `Allow` field, including a
  verb invented on the spot and a `CONNECT` that never reaches the router.

The suite is built only from what the runtime already ships — `node:test`,
`node:assert/strict`, `node:net`, `node:child_process` and the global `fetch` —
and every server it exercises is bound on port `0`, so it takes an ephemeral port
and never collides with a `--serve` you already have running.

A syntax-only check, if that is all you need:

```bash
node --check index.js
```

### Keeping the tree clean

Nothing above writes a file: the application produces no output artefact, Node
caches no bytecode beside the sources, and there is no build step to leave
anything behind, so `git status --porcelain --untracked-files=all` should still be
empty after any of it.

The one command that would change that is `npm install`. There is nothing to
install — see **Requirements** below — and running it anyway would create a
`package-lock.json` and a `node_modules` directory that this repository does not
track. `npm start` and `npm test` both work immediately after checkout without it.

### Requirements

- **Node.js `>= 18.0.0`**, as declared in `package.json` under `engines.node`.
  Node 18 is where `node:test` and the global `fetch` the suite uses arrive.
- **No dependencies.** The application and its suite are built entirely from
  Node's standard library, so there is nothing to install, no lock file to commit
  and no `node_modules` to create: `node index.js` works immediately after
  checkout. `package.json` declares neither `dependencies` nor `devDependencies`.
- **CommonJS.** `package.json` deliberately omits a `type` field, so `index.js`
  keeps resolving under Node's default CommonJS goal — which is what `require`,
  the `require.main === module` guard and the test suite all depend on.

### Operational notes

The endpoint is served by `node:http` from the standard library, and the exposure
it adds is bounded deliberately:

- the listener binds `127.0.0.1` unless an operator sets `HOST`;
- the body carries only the four fields above, and no request data is ever echoed
  back on any status path — including the paths a request takes when it is
  refused before routing;
- the response names this application and its version, and nothing about the
  runtime it happens to be built on, the host, the process or a file path, and no
  stack trace can reach a caller — even a bind failure is reported as the one
  fixed sentence above, on standard error, naming the variables to check without
  printing their values;
- the endpoint reads no request body and exposes no dynamic input path, and
  anything a caller sends after being answered is discarded rather than left to be
  read as another request;
- every answer ends its own connection, so a socket is never offered for reuse
  with unread bytes still on it;
- `SIGINT` and `SIGTERM` stop the listener and exit `0` promptly, including when a
  caller is holding a connection it has sent nothing on — which is exactly what a
  TCP liveness probe and a port scanner do — so the process never outlives its
  signal still holding the port;
- no access log is written, so nothing about a caller reaches the process output:
  `--serve` prints its single startup banner and then stays silent for as long as
  it runs.

The child submodule and the nested submodule serve the same four-field `/health`
contract from their own applications, each with its own default port and its own
commands; see `child_repo_10_LOC/README.md` and the nested README it points to.
