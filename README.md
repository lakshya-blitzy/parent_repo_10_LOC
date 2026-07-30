# parent_repo_10_LOC

The apex repository of a three-level Git submodule composition, and the home of its JavaScript application.

This repository holds two programs. The pre-existing one is a one-shot script, [`index.js`](index.js), which prints an arithmetic result and exits; what it prints when run directly is unchanged by everything described below, and [Preserved behavior](#preserved-behavior) records both the measurement that proves it and the two additive changes the file did receive. The new one is a long-lived HTTP server, [`server.js`](server.js), which serves a single machine-readable `/health` resource on **port 3000**. Both are written against the Node.js standard library alone, and this repository declares no third-party runtime dependency.

## The composition

Three applications, in three languages, in three separate Git repositories bound by two submodule links:

| Level | Repository | Language | `/health` port |
| --- | --- | --- | --- |
| 1 | `parent_repo_10_LOC` — this repository | JavaScript | **3000** |
| 2 | `child_repo_10_LOC` | Python | 8000 |
| 3 | `nested_child_repo_10_LOC` | Java | 8080 |

Level 2 is a submodule of this repository, declared in `.gitmodules` as `https://github.com/lakshya-blitzy/child_repo_10_LOC.git`. Level 3 is a submodule of Level 2, declared in that repository's own `.gitmodules` as `https://github.com/lakshya-blitzy/nested_child_repo_10_LOC.git`. Clone the whole composition with `git clone --recurse-submodules`, or run `git submodule update --init --recursive` inside an existing clone.

All three applications serve the **same** `/health` response contract, differing only in the `name` member of the payload and in the port they bind. They share that contract as *documentation* and share no code: no application at any level imports, reads or executes a file belonging to another level. Each level owns a distinct default port so that all three can run side by side on one host.

## The `/health` endpoint

`GET /health` reports **process liveness** — whether this process is running and able to answer. It runs no dependency checks and performs no input or output beyond reading values it resolved once at start-up plus a single clock reading, which is what keeps it cheap enough to be polled continuously. It is the only path that answers with anything other than an error.

### Run it

From this repository root:

```bash
node server.js
```

`server.js` is a **second, explicit entry point**, deliberately separate from `index.js`: binding a listener inside `index.js` would make that program long-lived and destroy the invariant described under [Preserved behavior](#preserved-behavior). It binds `0.0.0.0:3000`, stays alive serving requests, and logs exactly one line — naming the address it bound:

```text
health server listening on http://0.0.0.0:3000/health
```

**Nothing is written per request**, because a resource polled every few seconds would otherwise become the loudest thing in the log. `SIGTERM` and `SIGINT` are both handled: each writes one further line, closes the listener in an orderly fashion, releases the port and exits `0`, so a `docker stop` and an interactive Ctrl-C are clean stops rather than hard kills, and a request still in flight is given up to five seconds to finish.

```text
health server received SIGTERM, closing listener
```

Those two lines — one on binding, one on stopping — are the whole of the process's normal output. Anything else on either stream is a diagnostic reporting a real problem: a listener that cannot bind at all, because its port is already taken for instance, prints the reason to standard error and exits `1`, so an automated consumer fails loudly instead of waiting on a port that will never answer.

`npm start` runs exactly the same command.

### Probe it

```bash
curl -i http://127.0.0.1:3000/health
```

The probe targets loopback, `127.0.0.1` — never a public hostname and never a container name — because a health probe asserts the state of *this* process on *this* machine. `0.0.0.0` is a bind address, never a destination.

### Example response

The transcript below is what that command prints against a running server:

```text
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
Content-Length: 100
Date: Tue, 28 Jul 2026 13:35:56 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"name":"parent_repo_10_LOC","version":"1.0.0","timestamp":"2026-07-28T13:35:56.452Z","status":"UP"}
```

The body on its own, which is the exact byte shape served:

```json
{"name":"parent_repo_10_LOC","version":"1.0.0","timestamp":"2026-07-28T13:35:56.452Z","status":"UP"}
```

No space follows a `:` or a `,`, there is no indentation and no line break inside the body, and the four members always appear in the order `name`, `version`, `timestamp`, `status`. That byte shape is part of the contract rather than a formatting preference: the sibling Python and Java applications emit the same bytes for the same values, so a consumer can compare shapes and not merely parsed fields.

`Content-Type` and `Cache-Control` are the two contract headers, and the application writes both on every response it produces, including its error responses. `Content-Length` is written by the application too — the byte length of the body — so it is fixed for a given response and is the value a `HEAD` reports as well. `Date` and the connection-management headers come from the runtime and vary between requests, so a conformance check asserts the two contract headers and makes no assertion about the rest. This application sends no `Server` header.

Two consecutive calls return the same `name`, `version` and `status`, and a different `timestamp`.

### Response fields

| Field | Type | Source | Notes |
| --- | --- | --- | --- |
| `name` | string | `name` in `package.json` | This application's identity, `parent_repo_10_LOC`, so a caller knows which of the three applications answered rather than reading a shared constant |
| `version` | string, SemVer | `version` in `package.json` | `1.0.0`. Carried so that an operator can confirm **which build is live** during a deployment, which is the specific reason established practice recommends including it |
| `timestamp` | string | the system clock, read **per request** | RFC 3339 / ISO-8601 UTC with a `Z` suffix and millisecond precision, matching `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$` |
| `status` | string | `status` in `config/health.json`, accepted only if it equals the contract value | Always the literal `UP`. Never derived from a check and never settable from the environment, because a settable status would let a deployment lie about its own health |

`name`, `version` and `status` are resolved once at start-up and reused for the lifetime of the process; only `timestamp` is evaluated on every call. Two consecutive requests therefore differ in `timestamp` while the other three members stay stable — and that difference is the point: a frozen process cannot masquerade as a healthy one by serving a cached response. `Cache-Control: no-store` closes the same gap on the other side of the wire, guaranteeing that a poller reads live state rather than an intermediary's stored copy.

The body carries exactly those four members, and no fifth member is ever emitted.

### Response contract

| Element | Behavior |
| --- | --- |
| Resource path | `/health`, compared exactly against the origin-form path of the raw request target — a query string, if present, is discarded before the comparison and nothing else is — so a trailing slash is not an alias |
| Methods accepted | `GET` and `HEAD` |
| Success status | `200 OK` — mandatory for a healthy status |
| Content type | `application/json; charset=utf-8` |
| Cache directive | `no-store` |
| Body members | exactly four, in the fixed order `name`, `version`, `timestamp`, `status` |
| Serialization | compact — no insignificant whitespace, no pretty-printing |
| `HEAD /health` | `200` with the same headers as the equivalent `GET`, including the `Content-Length` that `GET` would have returned, and **no body** |
| `GET /health?x=1` | `200` — a query string is tolerated, because a request for the health path with parameters attached is still the health path |
| `GET /health/` | `404` — one resource, one spelling |
| Any other method | `405 Method Not Allowed`, header `Allow: GET, HEAD`, body `{"error":"Method Not Allowed"}` |
| Any other path | `404 Not Found`, body `{"error":"Not Found"}` |

The method is evaluated **before** the path, which settles one non-obvious case: `POST /unknown` answers `405`, not `404`. The ordering is deliberate — "you may not do that here" and "there is nothing here" are different facts and should not be reported with the same status.

Both error bodies above use the same single-member shape, `{"error":"<reason phrase>"}`, serialized with the same compact separators as the success body, so a caller never has to parse two formats from one endpoint. Every other error the application can write — a malformed request line, for instance — takes that same shape. The `Allow` value is exactly `GET, HEAD`: uppercase method names, one comma, one space, in that order. No routed request produces a 5xx.

### Standards basis

The response vocabulary is not ad hoc. The IETF Internet-Draft *Health Check Response Format for HTTP APIs* (draft-inadarei-api-health-check-06) makes `status` the single mandatory root field, explicitly lists `up` among the acceptable values for a healthy publisher, names `version` among its optional members, and requires a 2xx–3xx code for a healthy status — which is why `200` above is mandatory rather than merely conventional.

Four departures from that draft are deliberate, and each is a choice rather than an oversight. The payload carries a `name` member, which is not one of the draft's nine root fields — the nearest members it defines are the optional `serviceId`, a unique identifier for the service, and `description`, a human-friendly description of it — because a reader polling three sibling endpoints needs to know which tier answered, in a field whose name says so. The field is named `timestamp` rather than the draft's `time`, because what this endpoint reports is the *current* time, whereas the draft scopes `time` to the moment an observed value was recorded. The media type is `application/json` rather than the draft's `application/health+json`, so that ordinary tooling — `curl`, `jq`, a continuous-integration runner — parses the payload with no special handling. And `Cache-Control: no-store` deliberately declines the draft's own recommendation that a health response be given a freshness lifetime, such as `max-age=3600`, so that clients may cache it: this endpoint reports process liveness, and a cached liveness answer is worse than no answer, because a stopped process would keep appearing healthy for as long as the entry survived. The cost the draft is guarding against — a poller fetching more often than it needs to — is accepted knowingly, and it is small here precisely because the handler does no work beyond reading a clock.

Carrying `version` in the payload and keeping the handler free of any dependency check both follow established operational practice for health endpoints, and neither is in tension with the draft.

### Configuration

Two files supply every served value; nothing is hard-coded at its point of use.

| File | Supplies |
| --- | --- |
| [`package.json`](package.json) | the identity pair — `name` and `version`, the first two members of the payload |
| [`config/health.json`](config/health.json) | the serving parameters — `host`, `port`, `path` and the `status` literal |

`config/health.json` as shipped, verbatim:

```json
{
  "host": "0.0.0.0",
  "port": 3000,
  "path": "/health",
  "status": "UP"
}
```

That file is formatted for a human to read and edit. The compact, whitespace-free serialization described above is a property of the **response body** only, and it is produced by the handler rather than copied from this document.

Two environment variables redirect the listener without editing either file:

- **`PORT`** overrides the port. It must denote a decimal integer from `1` to `65535`, with surrounding whitespace trimmed before it is read; anything else is ignored in favour of the next link of the chain below, so a typo cannot stop the process from serving. `0` is refused along with the rest, even though it is a legal argument to a socket bind, because it asks the operating system for a random port — and an endpoint on an unpredictable port cannot be probed.
- **`HOST`** overrides the bind address. Set it to `127.0.0.1` to confine the listener to the loopback interface during local development.

```bash
PORT=3100 node server.js
PORT=3100 HOST=127.0.0.1 node server.js
```

Every setting resolves through one precedence chain, highest first — with `package.json` standing in for the file link when the setting is `name` or `version`:

```text
environment variable  ->  config/health.json  ->  compiled-in literal fallback
```

[`.env.example`](.env.example) is a tracked template documenting both variables and their defaults. Nothing parses it at run time — there is no dotenv package, because this repository carries zero third-party dependencies — so set the values explicitly as shown above, or hand a file to `docker run --env-file`. A real `.env` is never committed.

Four of the six values are deliberately narrower than the chain suggests, leaving `host` and `port` as the only two that follow it in full:

- `name` and `version` come from [`package.json`](package.json) rather than from `config/health.json`, and they skip the environment link entirely. They describe the build rather than the deployment, so letting the environment rewrite them would let a deployment misreport which application answered. There is no `APP_NAME` and no `APP_VERSION`, and neither may be added.
- The resource path and the `status` value are read from `config/health.json` like the other settings from that file, but are **validated** against the contract before they are adopted, and the contract admits exactly one legal value for each — `/health` and `UP`. A declaration equal to it, once surrounding whitespace is trimmed, is adopted from the file; anything else is refused, `server.js` prints one warning line naming the rejected value, and the endpoint keeps serving the contract value. Neither has an environment variable and neither may be given one: a settable path would move the endpoint away from where a probe looks for it, and a settable status would let a deployment lie about its own health.

The compiled-in fallback is the link that matters most. It exists so that `/health` **still serves a valid contract when `config/health.json` is missing from a container image** — precisely the failure a health endpoint has to survive. An absent file, an unreadable file, a malformed file, a non-numeric port and an out-of-range port all end in a serviceable endpoint rather than a process that refuses to start. The four failures of the *document* — absent, unreadable, malformed, or present but declaring none of the settings it is supposed to carry — are also announced: `server.js` prints one line to standard error naming the reason and the substitution, of the form `health configuration degraded: serving: declared source missing; serving the compiled-in fallback values`, where the reason is drawn from a closed vocabulary of four — `declared source` followed by `missing`, `unreadable`, `malformed` or `incomplete`. A document that declares *some* of its settings is not announced, because filling the remaining ones from the fallback is the chain working as designed rather than a failure. A single rejected `HOST` or `PORT` value, such as a port that is not a decimal integer or is out of range, is quieter: it is dropped in favour of the next link in the chain without a line of its own, and the substitution shows up in the provenance of the resolved setting rather than in the log. So a start-up worth investigating is visible on the error stream, and the resolved configuration is the authority on where each individual value came from. The fallback values are identical to the shipped declarations — `0.0.0.0`, `3000`, `/health` and `UP` — so a missing file degrades to *identical* behavior rather than merely to *some* behavior. Keep the two in step whenever a value above changes.

Levels 2 and 3 use their own, differently named variables — `HEALTH_PORT` and `HEALTH_HOST` — for their own listeners. That asymmetry is intentional and must not be "harmonized"; do not use their names here.

The Node version this level is developed and shipped against is pinned once, in [`.nvmrc`](.nvmrc), and restated as the `engines.node` floor in `package.json`.

### Tests

```bash
node --test
```

`npm test` runs the same command. `node --test` discovers [`index.test.js`](index.test.js) at the repository root by itself, with no runner to install, no configuration file and no third-party package — matching one of the runner's built-in discovery patterns is what makes that work, and `*.test.js` is the one this file uses, so renaming it outside that family — to `index.spec.js`, say — would silently drop it from the run. Discovery walks the working directory recursively, so moving the file deeper would keep it in the run — but its relative `require` paths would then need to move with it.

The suite asserts the whole of the above: the export surface, the resolved identity and serving configuration together with the provenance of each value, the payload's shape and member order and compact serialization, the timestamp format and its freshness across two immediately successive calls, the `200`, `405` and `404` responses of a listener it starts on an ephemeral loopback port and always stops again, the refusal of a serving document that tries to redefine a frozen value, the fallback behavior when a configuration source cannot be read at all, and the preserved behavior of `index.js` measured in a real child process.

```text
ℹ tests 180
ℹ suites 16
ℹ pass 180
ℹ fail 0
```

`npm run check` is the syntax gate, running `node --check` over `index.js`, `health.js`, `server.js` and `index.test.js`.

### Container image

```bash
docker build -t parent-repo-10-loc .
docker run --rm -p 3000:3000 parent-repo-10-loc
```

The [`Dockerfile`](Dockerfile) builds on `node:24-alpine` pinned by digest, copies only `package.json`, the three JavaScript sources and `config/health.json`, runs as the unprivileged `node` user, `EXPOSE`s `3000`, and starts `node server.js`. A sibling `.dockerignore` trims the build context to those files plus [`.nvmrc`](.nvmrc), which it keeps deliberately — and documents keeping — so the context still mirrors the repository. Its `HEALTHCHECK` exercises the endpoint through a probe written in this same language:

```text
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD ["node", "-e", "... fetch('http://127.0.0.1:' + config.port + config.path) ..."]
```

The probe uses Node's built-in global `fetch`, requests the endpoint over loopback, and exits `0` when it answers `200` or `1` otherwise — the only two codes a container probe may return. It builds that address from the *resolved* configuration rather than carrying its own copy of `3000`, which is what lets the `PORT` override above keep working inside a container: a probe with the port baked in would report a perfectly healthy container as unhealthy the moment anyone used a setting this repository documents. It is written in this language because **`curl` cannot be assumed present in a minimal image**: an in-language probe installs nothing, adds no package whose only purpose is to observe the container, and makes all three applications in this composition fail for the same reasons and report the same way.

The timings are deliberate. `--timeout=3s` is generous for a handler that reads one clock, and it is strictly less than `--interval=30s` so a slow probe can never overlap the next one. `--retries=3` keeps one transient failure from flipping a healthy container to unhealthy. `--start-period=5s` is the grace window the runtime needs to boot: a probe that fails inside it does not count against the retry budget. A container begins in the `starting` state and becomes `healthy` on the first successful probe.

### Dependencies

None. The server, its container probe and its test suite are written against the Node.js standard library alone — `node:http` for the listener, `node:fs` and `node:path` to read the two configuration files, and `node:test`, `node:assert` and a handful of other built-ins for the suite — so this repository declares no third-party runtime dependency and carries no lockfile and no installed dependency tree. `package.json` exists to declare identity and scripts; there is nothing to fetch or install before any command on this page will run.

It also omits the ES-module `type` field, deliberately, so that the whole level resolves as CommonJS. That is what makes the `require.main === module` guard in `index.js` work, and adding the field would break it.

### Preserved behavior

The `/health` endpoint is purely additive. The pre-existing program's behavior is unchanged, it is still one-shot, and it still runs exactly as it always has:

```bash
node index.js
```

It prints `12` on each of five lines, writes nothing to standard error, and exits `0`:

```text
12
12
12
12
12
```

That is fifteen bytes of standard output, whose md5 is `b07373a80ad21069e41be538e6506d00`. The digest is asserted by [`index.test.js`](index.test.js) — in a real child process, because a module cache makes any in-process check of load-time output unreliable — and it is the permanent regression gate that a continuous-integration workflow for this level — `.github/workflows/health-check.yml`, required but not yet present in this repository — must assert on every run once it is added. The existing behavior is protected by measurement rather than by intention.

Two things about `index.js` are new, and both are additive. Its five writes now sit behind a `require.main === module` guard, so requiring the module produces **no output at all**, where a bare require previously printed `12` five times; and it exports `add`, so the function is reachable from the test suite:

```bash
node -e "console.log(require('./index.js').add(5, 7))"
```

prints `12`. The `add` function itself is untouched.

### The normative contract

The response contract summarized above is defined normatively once, for all three applications, in [`docs/health-endpoint.md`](docs/health-endpoint.md). That document is the source of truth for the contract itself: anything here that disagreed with it would be the defect, and any change to the contract is made there first.

It is documentation, and only documentation. Nothing reads, parses or validates against it at run time, and no application in this composition imports from another repository, reads a file of another repository or starts a subprocess in one — the three implementations share a documented contract and nothing else, which is exactly what keeps them independent.

## Repository layout

| Path | Purpose |
| --- | --- |
| [`index.js`](index.js) | The pre-existing one-shot program, now guarded and exporting `add` |
| [`health.js`](health.js) | The `/health` payload builder, request handler and server factory; importing it binds nothing |
| [`server.js`](server.js) | The long-lived entry point — resolves the bind target, binds the listener, handles the shutdown signals |
| [`index.test.js`](index.test.js) | This level's test suite, discovered by `node --test` |
| [`package.json`](package.json) | Identity manifest — `name`, `version`, `engines.node`, and the `start`, `test` and `check` scripts |
| [`config/health.json`](config/health.json) | Serving parameters — host, port, path and the `status` literal |
| [`.env.example`](.env.example) | Tracked template documenting `HOST` and `PORT` |
| [`.nvmrc`](.nvmrc) | The Node version pin |
| [`Dockerfile`](Dockerfile) | Container image with `EXPOSE 3000` and a `HEALTHCHECK` that probes `/health` |
| [`docs/health-endpoint.md`](docs/health-endpoint.md) | The normative response contract for all three levels |
| `child_repo_10_LOC/` | The Level 2 submodule, with the Level 3 submodule nested inside it |

The layout is flat. Apart from `config` and `docs`, which each hold exactly the one file named above, and the `child_repo_10_LOC` submodule, every path in that table sits directly at this repository's root.
