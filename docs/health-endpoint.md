# The `/health` Endpoint Contract

**This document is the single normative definition of the `/health` endpoint** served by every application in the `parent_repo_10_LOC` submodule composition. Three independent applications — written in three different languages, living in three separate Git repositories — implement this one contract identically. It is defined once, here, at the apex of the composition precisely so that those three implementations cannot drift apart, and it is referenced from the Level 2 and Level 3 READMEs **by documented location only**. Where this document and an implementation disagree, this document is correct and the implementation carries the defect.

## 1. Scope, audience and the level-independence boundary

### 1.1 Who implements this contract

| Tier | Repository | Language and runtime | HTTP server | Serves |
| --- | --- | --- | --- | --- |
| L1 (apex) | `parent_repo_10_LOC` | JavaScript, CommonJS | `node:http` | port **3000** |
| L2 | `child_repo_10_LOC` | Python | `http.server.ThreadingHTTPServer` with `BaseHTTPRequestHandler` | port **8000** |
| L3 | `nested_child_repo_10_LOC` | Java | `com.sun.net.httpserver.HttpServer`, from the `jdk.httpserver` module | port **8080** |

`child_repo_10_LOC` is a Git submodule of `parent_repo_10_LOC`, and `nested_child_repo_10_LOC` is in turn a Git submodule of `child_repo_10_LOC`. All three are first-class project source: each one carries its own implementation of this contract, its own configuration, its own container definition, its own workflow and its own tests. No tier receives a subset of those artifact classes.

### 1.2 This document is documentation, and only documentation

The composition holds a standing architectural constraint that its three levels are **runtime-independent**: no file at any level references a file at another level, and there is no bridge, no subprocess call and no shared data format between them. This document is what allows an identical contract to exist at all three levels without breaching that constraint, because it is read by people and by the engineers who write the implementations — never by a running process.

Concretely, and normatively:

- **No file at any tier imports, reads, parses, downloads, fetches or validates against this document at run time.**
- It is **not** a JSON Schema, **not** an OpenAPI description, **not** a generated type and **not** a configuration file. There is deliberately no machine-parseable schema block anywhere in it, and no front matter for a documentation generator.
- There is deliberately **no `docs/` directory at Level 2 or Level 3**. The normative text exists once, at the apex. The two submodule READMEs refer to it by its documented location — `docs/health-endpoint.md` in the parent repository — rather than linking into another repository's tree.
- The three implementations consequently share a contract without sharing a runtime artifact. That is the whole point of writing it down here.

### 1.3 What existed before this endpoint

Nothing did. Before this feature the composition had no HTTP server, no configuration file of any kind, no declared version identity, no container definition, no workflow and no test — established by file-pattern and identifier probes across all three repositories, every one of which returned zero matches. `/health` is therefore the first inbound network channel, the first configuration surface and the first version identity in the composition's history, and every value named in this document is newly established by it.

### 1.4 How to read the requirement language

**MUST** marks a conformance requirement: an implementation that does not do it is non-conformant, and in most cases a workflow will fail it. **MUST NOT** marks a prohibition of the same weight. Anything described in the indicative mood ("the runtime emits…") is observed behavior of a standard library rather than a requirement placed on the implementer.

## 2. The frozen response contract

These values are frozen. They are what the workflows assert against, and they are identical at all three tiers.

| Contract element | Normative value |
| --- | --- |
| Resource path | `/health` |
| Methods accepted | `GET`, `HEAD` |
| Success status | `200 OK` — **mandatory**, because the IETF health-check draft requires a 2xx–3xx code for a healthy status |
| Content type | `application/json; charset=utf-8` — deliberately **not** `application/health+json`, so that `curl`, `jq` and the GitHub Actions runner parse the payload with no special handling |
| Cache directive | `Cache-Control: no-store` |
| Body members | **exactly four**, in this **fixed key order**: `name` (string), `version` (SemVer string), `timestamp` (string), `status` (string, literal `UP`) |
| Serialization | compact separators, **no insignificant whitespace** |
| `timestamp` format | RFC 3339 / ISO-8601 UTC, `Z` suffix, **millisecond** precision, matching `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$` |
| `timestamp` freshness | generated **per request**, never cached and never captured at start-up; two consecutive calls always differ, while `name`, `version` and `status` stay stable |
| `status` value | literal `UP` — hard-coded, because the endpoint asserts **process liveness** and performs no dependency checks |
| Wrong method | `405` with an `Allow: GET, HEAD` header and a small JSON error body |
| Unknown path | `404` with a small JSON error body |
| Extra fields | **forbidden** — no `checks` object, no `uptime`, no `pid`, no `hostname`, no `releaseId`, no `description`, and no member of any kind beyond the four above |

Two notes on how those rows are to be compared:

- **HTTP field names are case-insensitive** (RFC 9110, §5.1), and implementations legitimately differ: the Java tier's built-in server emits `Content-type` and `Cache-control` rather than `Content-Type` and `Cache-Control`. Conformance assertions MUST therefore compare header **names** case-insensitively. Header **values** are exact, including the space after the semicolon in `application/json; charset=utf-8`.
- The **body** is compared by shape and by value, never by digest. See §8.3 for why a digest of a live response body is never a stable check.

## 3. The four response body members

| Member | Type | Meaning | Source of the value |
| --- | --- | --- | --- |
| `name` | string | The identity of **the tier serving the request** — not a shared constant. A caller that receives `child_repo_10_LOC` knows it reached the Level 2 application and nothing else. | The tier's identity manifest (§7.2) |
| `version` | string, SemVer | The tier's declared version. It is present so that an operator can confirm **which build is live** during a deployment, which is the specific reason established operational practice recommends carrying it. | The tier's identity manifest (§7.2) |
| `timestamp` | string, RFC 3339 UTC | The **current** time at the moment the request was handled, to millisecond precision. Not a build time, not a start-up time, not the time an observation was recorded. | The system clock, read inside the request handler |
| `status` | string | The literal liveness value `UP`. The endpoint reports that **this process is running and able to answer**; it deliberately reports nothing about any downstream dependency. | A compiled-in literal |

`name` and `version` are read **once at start-up** and reused for the lifetime of the process. Only `timestamp` is evaluated per request. §9 states why that split is required rather than merely convenient.

## 4. Canonical responses

### 4.1 A complete success response

The full transcript, as a reader can reproduce it against a running Level 1 server:

```text
$ curl -i http://127.0.0.1:3000/health
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
Content-Length: 100
Date: Tue, 28 Jul 2026 13:35:56 GMT
Connection: keep-alive

{"name":"parent_repo_10_LOC","version":"1.0.0","timestamp":"2026-07-28T13:35:56.452Z","status":"UP"}
```

`Content-Type` and `Cache-Control` are contract headers and MUST be present with exactly the values shown. `Content-Length`, `Date` and any connection-management header are generated by the runtime, vary between tiers and requests, and are not part of the contract.

### 4.2 The three canonical bodies

The body differs between tiers in exactly one member — `name` — and in the per-request `timestamp`. Nothing else varies.

Level 1, `parent_repo_10_LOC`:

```json
{"name":"parent_repo_10_LOC","version":"1.0.0","timestamp":"2026-07-28T13:35:56.452Z","status":"UP"}
```

Level 2, `child_repo_10_LOC`:

```json
{"name":"child_repo_10_LOC","version":"1.0.0","timestamp":"2026-07-28T13:35:56.518Z","status":"UP"}
```

Level 3, `nested_child_repo_10_LOC`:

```json
{"name":"nested_child_repo_10_LOC","version":"1.0.0","timestamp":"2026-07-28T13:35:56.361Z","status":"UP"}
```

Read those three lines as the specification of the byte shape, not only of the parsed fields: no space follows a `:` or a `,`, the keys appear in the order `name`, `version`, `timestamp`, `status`, and there is no trailing newline inside the body. §8 states how each language is made to produce exactly this.

## 5. Method handling, path matching and the negative paths

### 5.1 The complete request-to-response matrix

Every row below is asserted by the workflows. An implementation MUST satisfy all of them.

| Request | Response |
| --- | --- |
| `GET /health` | `200 OK`, both contract headers, the four-member body |
| `HEAD /health` | `200 OK`, both contract headers, `Content-Length` set to the byte length the body would have had, and **no body** |
| `GET /health?x=1` | `200 OK`, identical in every respect to `GET /health` — the query string is ignored |
| `POST /health`, or any method other than `GET` or `HEAD` | `405 Method Not Allowed`, header `Allow: GET, HEAD`, body `{"error":"Method Not Allowed"}` |
| `GET /unknown` | `404 Not Found`, body `{"error":"Not Found"}` |
| `GET /health/` | `404 Not Found` — the path comparison is exact, so a trailing slash does not match |
| `POST /unknown` | `405 Method Not Allowed` — the method is evaluated before the path (§5.4) |

### 5.2 `HEAD` returns headers and nothing else

`HEAD /health` MUST return the same status line and the same headers as the equivalent `GET`, including a `Content-Length` equal to the byte length of the body a `GET` would have produced, and MUST NOT write a body. Implementations build the payload exactly as they would for a `GET`, measure its UTF-8 encoded length, set `Content-Length` from that measurement, and then end the response without writing the bytes. A `HEAD` is therefore a valid, cheap liveness check that still proves the payload could be built.

### 5.3 Both error bodies share one shape

Error responses use a single-member object, `{"error":"<reason phrase>"}`, serialized with the same compact separators as the success body, so that all three tiers agree byte-for-byte:

```json
{"error":"Method Not Allowed"}
```

```json
{"error":"Not Found"}
```

Error responses carry the same `Content-Type: application/json; charset=utf-8` and `Cache-Control: no-store` headers as the success response. Only the `405` response carries `Allow`.

```text
$ curl -i -X POST http://127.0.0.1:3000/health
HTTP/1.1 405 Method Not Allowed
Allow: GET, HEAD
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
Content-Length: 30

{"error":"Method Not Allowed"}
```

```text
$ curl -i http://127.0.0.1:3000/unknown
HTTP/1.1 404 Not Found
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
Content-Length: 21

{"error":"Not Found"}
```

The `Allow` header value is exactly `GET, HEAD` — uppercase method names, one comma, one space, in that order.

### 5.4 Method is checked before path, and the path is the parsed path

Two ordering and parsing rules that three independent implementations get inconsistent unless they are written down:

1. **The method check runs first.** `POST /health` returns `405`, not `404`; `POST /unknown` also returns `405`, because the request never reaches the path comparison. A caller therefore always learns the most actionable fact first: that the method it used is not permitted anywhere on this server.
2. **Compare the parsed path, not the raw request target.** `GET /health?x=1` MUST return `200`. Implementations parse the request target and compare its path component against `/health` for exact equality; a query string is ignored entirely and is never reflected in the response. Trailing slashes are not normalized, so `/health/` does not match.

## 6. Per-tier identity, ports and environment overrides

| Tier | `name` | Version | Default port | Bind address | Environment overrides |
| --- | --- | --- | --- | --- | --- |
| L1 `parent_repo_10_LOC` | `parent_repo_10_LOC` | `1.0.0` | 3000 | `0.0.0.0` | `PORT`, `HOST` |
| L2 `child_repo_10_LOC` | `child_repo_10_LOC` | `1.0.0` | 8000 | `0.0.0.0` | `HEALTH_PORT`, `HEALTH_HOST` |
| L3 `nested_child_repo_10_LOC` | `nested_child_repo_10_LOC` | `1.0.0` | 8080 | `0.0.0.0` | `HEALTH_PORT`, `HEALTH_HOST` |

Four properties of that table are deliberate and MUST be preserved:

- **Each tier owns a distinct default port**, because all three applications may run simultaneously on one host during validation — and in the apex workflow they do. Port 3000 belongs to Level 1, port 8000 to Level 2 and port 8080 to Level 3. All three were verified free on the reference host before being assigned.
- **The override variable names differ by tier on purpose.** Level 1 uses the plain `PORT` and `HOST`; Levels 2 and 3 use `HEALTH_PORT` and `HEALTH_HOST`. This asymmetry is intentional and MUST NOT be "harmonized": the Level 2 and Level 3 applications each already own a general-purpose process environment, and prefixing their variables keeps the health listener's settings unambiguous.
- **Every probe targets `127.0.0.1`** — never `0.0.0.0`, never a public hostname, and never an assumption about how `localhost` resolves. A health probe asserts the state of *this* process inside *this* container, so it MUST address the loopback interface directly. `0.0.0.0` is a bind address only; it is never a destination.
- **All three tiers declare version `1.0.0`.** This is the first version identity in the composition's history, and the apex workflow asserts it as a cross-tier version-consistency gate: the `version` member returned by all three endpoints MUST match each tier's declared version, and the three declarations MUST agree.

## 7. Where the values come from

### 7.1 Resolution precedence, uniform at all three tiers

Every configurable value — host, port, path, application name, version — resolves through the same three-step chain, highest precedence first:

```text
environment variable → configuration file → compiled-in literal fallback
```

> The literal fallback is **required, not optional**. It guarantees that the endpoint still serves a valid contract when a configuration file is absent from a container image — which is precisely the failure mode a health endpoint has to survive. An endpoint that cannot answer because its own configuration is missing is worse than no endpoint at all, because it turns a running application into one that reports itself unhealthy.

No handler hard-codes an application name, a version, a host or a port inline at its point of use. Each value is resolved once, through the chain above, and then referenced. This document is the single normative statement of what those values are; each tier's configuration files are the single runtime source it resolves them from; and each tier has exactly one place in its code where the resolution happens.

### 7.2 Per-tier configuration sources

| Tier | Identity source (`name`, `version`) | Serving source (host, port, path, status) | Dotenv template | Runtime-version pin |
| --- | --- | --- | --- | --- |
| L1 | `package.json` | `config/health.json` | `.env.example` | `.nvmrc` (`24.18.0`) |
| L2 | `pyproject.toml`, read through the standard-library `tomllib` module | `config/health.json` | `.env.example` | `.python-version` (`3.14.6`) |
| L3 | `application.properties`, read from the classpath, with literal fallbacks | `application.properties` | **none** | **none** |

All paths in that table are relative to the tier's own repository root. Each repository is flat: every file sits at its root, and this `docs/` directory at the apex is the only directory the feature introduces apart from `config/` and `.github/workflows/`.

### 7.3 The Level 3 asymmetry is deliberate and MUST NOT be "corrected"

> Level 3 has no `.env.example` and no runtime-version dotfile. Java has no dotenv convention without a third-party library, and adding one would breach the composition's zero-dependency constraint, so `HealthServer` reads `HEALTH_PORT` and `HEALTH_HOST` through `System.getenv` with `application.properties` supplying the defaults; the overrides are documented inside that properties file and in the Level 3 README. The Level 3 runtime pin lives in the workflow's `java-version` input and in the Dockerfile tag instead of a dotfile.

An engineer who notices that Level 3 is "missing" two files that Levels 1 and 2 have is seeing an intentional consequence of the zero-dependency rule, not an oversight. Adding a dotenv template or a version dotfile at Level 3 would either add a dependency or add a file nothing reads. Leave it as it is.

### 7.4 The Level 1 CommonJS constraint

The apex `package.json` **MUST NOT declare the ES-module `type` field.** Node resolves `index.js` as CommonJS today, and the `require.main === module` guard that keeps the pre-existing program's behavior intact (§12.3) depends on that resolution. Declaring the module type would silently change it, and the failure would surface as a behavioral regression rather than as an error at the point of the change. The omission is a review checkpoint, not an accident — see [`../package.json`](../package.json).

## 8. Serialization: a proven byte-level constraint

### 8.1 What each language must do

The requirement is that all three tiers produce the *same bytes* for the same field values, not merely equivalent JSON.

- **JavaScript** — `JSON.stringify` is compact by default and needs no arguments beyond the object.
- **Python** — `json.dumps` defaults to `", "` and `": "` separators, so the implementation **MUST** pass `separators=(",", ":")`. This is the single most easily broken clause in this contract.
- **Java** — the payload is assembled as a string with no spaces, in the same key order, since the standard library ships no JSON writer in this configuration.
- **Encoding, in every tier** — the body is encoded as UTF-8, as RFC 8259 requires, and `Content-Length` is the length of that byte sequence rather than a count of characters. Every member value in this contract is ASCII in practice, so the two coincide today; the requirement is nevertheless the byte length, because that is what a client reads.

### 8.2 The requirement is measured, not stylistic

Serializing identical field values in both runtimes and comparing the two outputs byte-for-byte produced **no difference** — `cmp` reported none and both digests were equal — once `separators=(",", ":")` was supplied. With Python's **default** separators the output diverged visibly, to `{"name": "parent_repo_10_LOC", "version": ...}`, and its digest differed. The compact-separator argument is therefore a conformance requirement with a measured consequence, not a formatting preference.

The reproducible form of that check, and the one an implementer should use, is: serialize one fixed set of the four field values in two runtimes, write each to a file, and compare the files byte-for-byte. It must report no difference.

### 8.3 Why no digest of a response body is ever quoted here

The `timestamp` member changes on every request, so **no digest of a live response body is stable** and none is quoted in this document as a target. Conformance is asserted on shape and values — key order, key count, the absence of insignificant whitespace, and each member's value — never on a body digest.

For completeness, and so that nobody mistakes its meaning: the design-verification record contains the md5 `cb662b9754f989bf7f6d87a89291de34`, measured during that exercise over **its own** field values when the JavaScript and Python serializations were shown to be byte-identical. It is **not** the digest of any example printed in this document, and hashing any body above will not reproduce it. It is cited only as provenance for the parity finding.

The one digest in this document that *is* reproducible, and that means exactly one thing, is the Level 1 regression fingerprint in §12.3.

## 9. Freshness, and the rule that the probe stays cheap

### 9.1 What is read when

- The **clock is read inside the request handler**, never at module load and never once at start-up.
- **Configuration is read once at start-up** and reused for the lifetime of the process.

That split is the whole of the endpoint's runtime behavior, and both halves are requirements.

### 9.2 Why the clock is read per request

A per-request timestamp is **proof of liveness rather than merely proof of reachability**. If the value were captured at start-up, a process that had frozen after binding its socket could keep serving a stale but well-formed payload and a poller would call it healthy. Because the value is generated as the request is handled, a frozen process cannot masquerade as a healthy one. `Cache-Control: no-store` completes the guarantee at the other end of the wire: a poller always reads live state rather than an intermediary's cached copy of an earlier answer.

Freshness is measured, not assumed. Two successive calls fourteen milliseconds apart returned different `timestamp` values while `name`, `version` and `status` stayed identical, and the workflows assert exactly that: two consecutive responses differ in `timestamp` and in nothing else.

### 9.3 Why the handler does nothing else

Established operational practice for health endpoints is that the probe stays lightweight and performs no heavy work, because a probe that does real work becomes a source of the very load it is meant to report on, and its timeouts start reporting the monitor's problems rather than the application's. This contract therefore forbids per-request file I/O, per-request network calls and dependency interrogation of any kind inside the handler. Reading an already-loaded value and reading the clock is the entire permitted workload.

That restriction has a second consequence worth stating outright: because the handler performs no I/O, it has no failure path, and **the contract defines no `5xx` response**. An implementation that adds a server-error branch to this handler is either doing work it should not be doing or reporting a fault it cannot have.

### 9.4 Formatting the timestamp in each language

The mandated form is RFC 3339 UTC with a `Z` suffix and exactly three fractional digits. `new Date().toISOString()` emits precisely that form natively — verified, producing values such as `2026-07-28T15:03:08.665Z` and matching the contract regex — so the JavaScript tier needs no formatting helper. The Python and Java tiers format explicitly to match it. Implementations MUST NOT emit a numeric offset such as `+00:00` in place of `Z`, MUST NOT emit microsecond precision, and MUST NOT drop the fractional part when it happens to be zero.

## 10. Standards basis

The payload's vocabulary is not invented. It follows the IETF Internet-Draft *Health Check Response Format for HTTP APIs*, **draft-inadarei-api-health-check-06**, which:

- is JSON per RFC 8259 and defines the media type `application/health+json`, which this contract deliberately declines in favor of `application/json` — see the divergences below;
- has exactly **one mandatory root field, `status`**;
- lists **`"up"`** as an acceptable value for a healthy service alongside `"pass"`, with `"fail"` and `"down"` for an unhealthy one, and treats the value case-insensitively;
- ties the status to the HTTP code: **a healthy status must be returned with a 2xx–3xx code**, which is why `200` is mandatory here rather than merely conventional;
- names **`version`** and a date-time field among its **optional** members.

The requested `status` value `UP` is therefore standards-conformant, and `version` plus a timestamp are named members of the same vocabulary rather than local inventions.

Two divergences from the draft are deliberate:

1. **The field is named `timestamp`, not the draft's `time`.** The draft scopes `time` to when an observed value was recorded, whereas this contract carries the *current* time at which the request was handled. Using the draft's name for a different meaning would be worse than using a different name.
2. **The content type is `application/json`, not `application/health+json`.** Ordinary tooling — `curl`, `jq`, the GitHub Actions runner — parses `application/json` with no special handling, and the payload gains nothing from a specialized media type that some clients would refuse to parse.

Three further elements come from established operational practice for health endpoints rather than from the draft: disabling caching so every response reflects current state; keeping the probe lightweight; and carrying the application version so that an operator can confirm which build is live during a deployment.

## 11. Container health probes

Each tier's image declares a `HEALTHCHECK` that exercises this endpoint. **Every probe is language-native and installs nothing**, because `curl` cannot be assumed present in a minimal image — and the Debian-slim Python base carries neither `curl` nor BusyBox `wget`. Using only the runtime that is already in the image keeps the probe reliable and keeps the image free of packages added solely to observe it.

| Tier | Base image (pinned by tag) | Probe mechanism | Start period |
| --- | --- | --- | --- |
| L1 | `node:24-alpine` | inline `node -e` using Node's built-in global `fetch` | `--start-period=5s` |
| L2 | `python:3.14-slim` | inline `python -c` using `urllib.request` | `--start-period=5s` |
| L3 | multi-stage `eclipse-temurin:25-jdk-alpine` to compile, `eclipse-temurin:25-jre-alpine` to run | `java -cp /app HealthServer --check`, using `java.net.http.HttpClient` | `--start-period=20s`, for JVM start-up |

Level 3's probe is a `--check` mode on `HealthServer` itself: with no arguments the class serves the endpoint, and with `--check` it acts as a client that asserts a `200` response whose body carries the `UP` status member, then exits. That keeps the probe in the same language and the same artifact as the server, so all three tiers fail for the same reasons and report the same way. `jlink` is not used anywhere; a published JRE image serves, and a custom runtime image would add build complexity for no gain.

### 11.1 Timing and exit-code semantics

| Option | Value | Why |
| --- | --- | --- |
| `--interval` | `30s` | The endpoint does no work, so a slower cadence costs nothing and avoids adding probe traffic to a busy host |
| `--timeout` | `3s` | Generous for a handler that reads one clock, and it MUST be strictly less than the interval so a slow probe cannot overlap the next one |
| `--retries` | `3` | A single transient failure does not flip a healthy container to unhealthy |
| `--start-period` | `5s` at Levels 1 and 2, `20s` at Level 3 | A failing probe inside the start period does not count against the retry budget; the JVM needs the wider grace window |

A container begins in the `starting` state and transitions to `healthy` on the first successful probe. The probe communicates through its exit code, and only two codes may ever be returned: **`0` means healthy, `1` means unhealthy, and `2` is reserved and MUST NOT be returned** by any probe in this composition. Every probe here was verified to exit `1` against a dead port, the Level 3 probe additionally printing `probe UNREACHABLE: ConnectException`, so an unreachable server is reported as unhealthy rather than as a broken probe.

### 11.2 Pinned versions

Every version below is a real, currently supported release. No floating or unresolved tag appears anywhere in this feature.

| Component | Pin | Note |
| --- | --- | --- |
| Node.js | `24.18.0` | Active LTS, end of life 2028-04-30; `engines.node` is `">=24.0.0"` and `.nvmrc` carries the exact version |
| CPython | `3.14.6` | End of life 2030-10-31; `requires-python` is `">=3.11"`, the floor set by `tomllib`, which entered the standard library in CPython 3.11 |
| Eclipse Temurin JDK | `25` | Current LTS; supplies the `jdk.httpserver` and `java.net.http` modules the Level 3 tier needs |
| `actions/checkout` | `v7.0.1` | Used by all three workflows |
| `actions/setup-node` | `v7.0.0` | Level 1 |
| `actions/setup-python` | `v7.0.0` | Level 2 |
| `actions/setup-java` | `v5.6.0` | Level 3, with the Temurin distribution |
| Third-party runtime packages | **none** | Zero added, zero removed, zero updated |

The presence of `jdk.httpserver` inside the Level 3 runtime image is asserted in that tier's workflow rather than assumed. If the module is ever absent from the JRE image, the documented fallback is to use the JDK Alpine image as the runtime stage as well — a larger image, but a correct one. Likewise, the transition of each container to `healthy` is asserted in CI, because the authoring environment for this contract had no container runtime available.

## 12. How conformance is asserted, and what is preserved

### 12.1 Where the gates live

A workflow named `.github/workflows/health-check.yml` exists in **each of the three repositories**, not only at the apex. That is a structural necessity rather than duplication: a check gates only the repository that defines it, so a workflow added to the parent repository cannot gate a commit pushed directly to Level 3. Each tier's workflow owns its own syntax gate, unit tests, regression fingerprint and endpoint probe.

The apex workflow additionally owns three responsibilities that only it can discharge:

- **A credentialed recursive submodule checkout.** The token that GitHub Actions mints automatically for a job is scoped to that job's own repository and cannot read sibling repositories, so a recursive checkout that relies on it fails outright. The apex workflow supplies an explicit credential instead: either a read-only fine-grained personal access token with Contents and Metadata read access on exactly the three repositories, passed through the checkout action's `token` input, or a read-only deploy key passed through its `ssh-key` input. Least privilege is the requirement — never a broadly scoped credential, and no credential value ever appears in a tracked file or a workflow log.
- **Materialization asserted by file existence.** A recursive submodule update issued from a level that registers no submodule configuration returns success with no output, so its exit code proves nothing. The workflow therefore verifies that the expected source files exist on disk after checkout, and that every line of the recursive submodule status is space-prefixed, before it trusts the tree at all.
- **The cross-tier version-consistency check**, comparing the `version` member returned by all three endpoints against the three declared versions.

### 12.2 The per-response assertions

For each tier, against `127.0.0.1` on that tier's port:

- HTTP status `200`.
- `Content-Type` exactly `application/json; charset=utf-8` and `Cache-Control` exactly `no-store`, compared with case-insensitive header names (§2).
- Exactly four body members, in the order `name`, `version`, `timestamp`, `status` — both the count and the order are asserted.
- `status` equal to `UP`.
- `name` equal to that tier's declared name, and `version` equal to that tier's declared version.
- `timestamp` matching `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`.
- Two successive responses differing in `timestamp` and identical in the other three members.
- `POST /health` returning `405` with `Allow: GET, HEAD`.
- `GET` on an unknown path returning `404`.

Every one of those has a single expected value, so a failure names the defect rather than merely reporting that something is wrong.

### 12.3 What is preserved, measured rather than assumed

This endpoint is **purely additive**. Each tier keeps its original one-shot program and its original invocation, and the health server runs from a **separate entry point**: `node server.js` at Level 1, `python server.py` at Level 2 and `java -cp . HealthServer` at Level 3. Running the original program still terminates immediately; nothing about it becomes long-lived.

The preservation of Level 1 is enforced by a fingerprint rather than by inspection. `node index.js` still exits `0`, still writes five lines and fifteen bytes to standard output, still writes nothing to standard error, and the md5 of that standard output is still:

```text
b07373a80ad21069e41be538e6506d00
```

That digest means exactly one thing — the md5 of the standard output of `node index.js` — and the apex workflow asserts it on every run as a permanent regression gate. At Level 2 the original program still prints `Hello Lakshya`, and at Level 3 it still prints `Test`; both are asserted the same way.

### 12.4 Process lifecycle

Each server is the first long-lived process its tier has ever had, so each one installs handlers for `SIGTERM` and `SIGINT` that close the listener in an orderly fashion. A container stop is therefore not a hard kill, and a workflow teardown leaves no orphaned port binding behind to break the next run. Re-running any of the three workflows is idempotent.

## 13. Deliberately not provided

A normative contract is as much about what an implementation must not add as about what it must do. The following are out of scope for this feature, and an implementation that adds any of them is non-conformant:

- **No other endpoint.** There is no `/ready`, no `/live`, no `/metrics`, no `/info` and no root resource. `/health` is the only path that returns anything other than `404`.
- **No fifth member, now or later.** The body is exactly the four members in §3. In particular none of the health-check draft's other optional members is emitted: no `checks` object, no `uptime`, no `pid`, no `hostname`, no `releaseId`, no `description`. There is no extension point, because an extension point in a frozen contract is a drift point.
- **No dependency interrogation.** `status` reports process liveness only. The endpoint never reports on anything downstream of itself, because there is nothing downstream of it.
- **No authentication, no transport-layer encryption termination, no rate limiting, no CORS handling and no response compression.** The endpoint is plain HTTP on the loopback interface for probes and on the bound address for orchestrators.
- **No logging framework**, and no logging inside the handler at all. Each entry point logs its bound address once at start-up and nothing per request.
- **No persistence of any kind.** The composition has no database, no object-relational mapper, no migration, no schema and no model, and this feature creates none. The endpoint holds no state between requests beyond the configuration it loaded at start-up.
- **No third-party package.** Every server, every probe and every test in all three tiers is written against its language's standard library: `node:http` at Level 1, `http.server` at Level 2, `com.sun.net.httpserver` at Level 3. Express, Fastify, Flask, FastAPI, uvicorn, Spring, a Servlet container, Maven, Gradle and JUnit are all deliberately not used, and the composition's third-party runtime dependency count stays at zero. Nothing in this document should be read as a recommendation to add one.

## 14. Quick reference

| Tier | Start | Probe | Value sources | Overrides |
| --- | --- | --- | --- | --- |
| L1 `parent_repo_10_LOC` | `node server.js` | `curl -i http://127.0.0.1:3000/health` | `package.json`, `config/health.json` | `PORT`, `HOST` |
| L2 `child_repo_10_LOC` | `python server.py` | `curl -i http://127.0.0.1:8000/health` | `pyproject.toml`, `config/health.json` | `HEALTH_PORT`, `HEALTH_HOST` |
| L3 `nested_child_repo_10_LOC` | `javac *.java` then `java -cp . HealthServer` | `curl -i http://127.0.0.1:8080/health` | `application.properties` | `HEALTH_PORT`, `HEALTH_HOST` |

Level 1, from the parent repository root. The `start` script in [`../package.json`](../package.json) runs exactly the first command below; the `test` and `check` scripts run the tier's test suite and its syntax gate. The serving parameters live in `config/health.json`:

```bash
node server.js
curl -i http://127.0.0.1:3000/health
PORT=3100 HOST=127.0.0.1 node server.js
```

Level 2, from the `child_repo_10_LOC` repository root:

```bash
python server.py
curl -i http://127.0.0.1:8000/health
HEALTH_PORT=8100 HEALTH_HOST=127.0.0.1 python server.py
```

Level 3, from the `nested_child_repo_10_LOC` repository root — compile first, then run from the same directory so `application.properties` is found on the classpath:

```bash
javac *.java
java -cp . HealthServer
curl -i http://127.0.0.1:8080/health
HEALTH_PORT=8180 HEALTH_HOST=127.0.0.1 java -cp . HealthServer
```

Each tier's own README carries the same invocation for that tier; see [`../README.md`](../README.md) for Level 1. This document remains the normative source for the response contract itself, and any change to the contract is made here first.
