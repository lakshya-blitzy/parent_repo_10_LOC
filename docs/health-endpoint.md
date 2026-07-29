# The `/health` Endpoint Contract

**This document is the single normative definition of the `/health` endpoint** served by every application in the `parent_repo_10_LOC` submodule composition. Three independent applications — written in three different languages, living in three separate Git repositories — implement this one contract identically. It is defined once, here, at the apex of the composition precisely so that those three implementations cannot drift apart, and the Level 2 and Level 3 READMEs are required to reference it **by documented location only**, never by a relative link into another repository's tree (§1.2). Where this document and an implementation disagree, this document is correct and the implementation carries the defect.

It is a **specification, not an inventory**: it states what every tier MUST do, and parts of the feature it defines — the container definitions of §11, the workflows of §12.1 and the per-tier README sections of §14 — are still to be created. Each section says plainly which of its claims describe the tree as it stands and which are requirements on work still to come.

## 1. Scope, audience and the level-independence boundary

### 1.1 Who implements this contract

| Tier | Repository | Language and runtime | HTTP server | Serves |
| --- | --- | --- | --- | --- |
| L1 (apex) | `parent_repo_10_LOC` | JavaScript, CommonJS | `node:http` | port **3000** |
| L2 | `child_repo_10_LOC` | Python | `http.server.ThreadingHTTPServer` with `BaseHTTPRequestHandler` | port **8000** |
| L3 | `nested_child_repo_10_LOC` | Java | `com.sun.net.httpserver.HttpServer`, from the `jdk.httpserver` module | port **8080** |

`child_repo_10_LOC` is a Git submodule of `parent_repo_10_LOC`, and `nested_child_repo_10_LOC` is in turn a Git submodule of `child_repo_10_LOC`. All three are first-class project source, and none may be reduced to a pin bump: **every tier MUST carry its own implementation of this contract, its own configuration, its own container definition, its own workflow and its own tests.** No tier receives a subset of those artifact classes.

That requirement is the specification of the finished feature, and the tiers reach it incrementally. At the time of writing, all three tiers carry their implementation, their configuration and their tests; the container definitions and the workflows are required deliverables that the sections below define normatively and that are not yet present in the tree. Each section states which of the two it is describing, so this document can be read as a specification without being mistaken for an inventory.

### 1.2 This document is documentation, and only documentation

The composition holds a standing architectural constraint that its three levels are **runtime-independent**: no file at any level references a file at another level, and there is no bridge, no subprocess call and no shared data format between them. This document is what allows an identical contract to exist at all three levels without breaching that constraint, because it is read by people and by the engineers who write the implementations — never by a running process.

Concretely, and normatively:

- **No file at any tier imports, reads, parses, downloads, fetches or validates against this document at run time.**
- It is **not** a JSON Schema, **not** an OpenAPI description, **not** a generated type and **not** a configuration file. There is deliberately no machine-parseable schema block anywhere in it, and no front matter for a documentation generator.
- There is deliberately **no `docs/` directory at Level 2 or Level 3**. The normative text exists once, at the apex. The two submodule READMEs MUST refer to it by its documented location — `docs/health-endpoint.md` in the parent repository — rather than linking into another repository's tree, because a relative link that climbs out of a submodule resolves only in a composed checkout and breaks whenever that repository is cloned on its own.
- The three implementations consequently share a contract without sharing a runtime artifact. That is the whole point of writing it down here.

### 1.3 What existed before this endpoint

Nothing did. Before this feature the composition had no HTTP server, no configuration file of any kind, no declared version identity, no container definition, no workflow and no test — established by file-pattern and identifier probes across all three repositories, every one of which returned zero matches. `/health` is therefore the first inbound network channel, the first configuration surface and the first version identity in the composition's history, and every value named in this document is newly established by it.

### 1.4 How to read the requirement language

**MUST** marks a conformance requirement: an implementation that does not do it is non-conformant, and in most cases a workflow will fail it. **MUST NOT** marks a prohibition of the same weight. Anything described in the indicative mood ("the runtime emits…") is observed behavior of a standard library rather than a requirement placed on the implementer.

## 2. The frozen response contract

These values are frozen and identical at all three tiers. They are what every conformance check MUST assert against — the tier test suites today, and the workflows specified in §12.1 once they exist.

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
| `timestamp` freshness | generated **per request** from a clock read on every call, never cached and never captured at start-up; **two consecutive calls always differ** and the later one is always the strictly greater value, while `name`, `version` and `status` stay stable. "Always" is literal and admits no same-millisecond exception, which a raw clock read cannot deliver — see §9.2 for the monotonic allocation this requires |
| `status` value | the frozen invariant `UP`. It is never derived from a dependency check, never read from a configuration source and never overridable from the environment, because the endpoint asserts **process liveness** only. It is a compiled-in protocol constant at every tier; §7.5 states that rule normatively |
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
| `timestamp` | string, RFC 3339 UTC | The **current** time at the moment the request was handled, to millisecond precision. Not a build time, not a start-up time, not the time an observation was recorded. | The system clock, read inside the request handler on every call, then allocated monotonically (§9.2) |
| `status` | string | The frozen liveness value `UP`. The endpoint reports that **this process is running and able to answer**; it deliberately reports nothing about any downstream dependency, and no code path may ever emit a different value. | A compiled-in protocol constant — **never configuration** (§7.5) |

The value is invariably the literal `UP`, at every tier, and it has **no precedence chain at all**: no environment variable and no configuration file can redefine it. A serving document that declares a different `status` is not honoured — Levels 1 and 2 record the attempt as a frozen-value conflict and report it once at start-up (§12.5), then serve `UP` regardless. Every conformance check asserts equality against the literal `UP` itself, never against whatever the tier's configuration file happens to contain, so a file edited to say anything else fails the gate rather than changing the contract.

`name`, `version` and `status` are resolved **once at start-up** and reused for the lifetime of the process. Only `timestamp` is evaluated per request. §9 states why that split is required rather than merely convenient.

The distinction that matters for `status` is between its *provenance* and its *value*. The value is a frozen invariant: `UP`, at every tier, in every response, permanently. The provenance differs by tier only in whether the literal is read from a configuration file before being served or compiled straight into the handler, and §7.2 records which tier does which. Neither arrangement makes the value configurable — a tier that declares `status` in its configuration MUST still fall back to `UP`, so removing the declaration changes nothing observable, and no tier exposes an environment variable that could change it.

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

`Content-Type` and `Cache-Control` are contract headers and MUST be present with exactly the values shown. `Content-Length`, `Date`, `Server` and any connection-management header are generated by the runtime, vary between tiers and requests, and are not part of the contract — a conformance check MUST assert the two contract headers and MUST NOT assert the absence of the rest. The transcript above is Level 1's; the other two tiers differ in that set and only in that set. Level 2 is the one tier that emits a `Server` header, and it emits `Server: health`: its runtime would otherwise announce the module and the exact interpreter build, so the tier overrides the banner to a value that discloses nothing. Levels 1 and 3 send no `Server` header at all, which is the same posture reached by a different route.

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

An implementation MUST satisfy every row below, and every row MUST be asserted — by the tier's test suite today, and by that tier's workflow once it exists.

| Request | Response |
| --- | --- |
| `GET /health` | `200 OK`, both contract headers, the four-member body |
| `HEAD /health` | `200 OK`, both contract headers, `Content-Length` set to the byte length the body would have had, and **no body** |
| `GET /health?x=1` | `200 OK` — the query string is ignored entirely. Route, status, both headers, key count, key order, `name`, `version` and `status` all match `GET /health`; `timestamp` does **not**, because it is generated for this request like any other (§9.2) |
| `POST /health`, or any method other than `GET` or `HEAD` | `405 Method Not Allowed`, header `Allow: GET, HEAD`, body `{"error":"Method Not Allowed"}` |
| `GET /unknown` | `404 Not Found`, body `{"error":"Not Found"}` |
| `GET /health/` | `404 Not Found` — the path comparison is exact, so a trailing slash does not match |
| `GET /other/../health`, `GET /%2e%2e/health`, `GET /health#x`, and every other alias in §5.4.2 | `404 Not Found` — the raw request target is compared, so no normalization can produce a second spelling of `/health` |
| `POST /unknown` | `405 Method Not Allowed` — the method is evaluated before the path (§5.4) |
| `GET http://127.0.0.1:<port>/health` (absolute-form target, as a proxy sends) | `404 Not Found` — the request is accepted and answered, but an absolute-form target carries its own authority and is not origin-form, so it names no resource here (§5.4.1) |

### 5.1.1 No spelling other than the exact path is an alias

Every row below is a request target that a URL parser can be talked into treating as `/health`, and every one of them MUST answer `404 Not Found` with the body `{"error":"Not Found"}` wherever the request reaches application code. They are listed because they are the concrete cases three different standard libraries disagree about, and because an endpoint reachable through an undocumented spelling is an endpoint whose surface nobody can enumerate.

| Request target | Why a parser might accept it | Required response |
| --- | --- | --- |
| `/%68ealth` | percent-decoding `%68` to `h` makes it read as `/health` | `404` |
| `/health%2F` | percent-decoding `%2F` to `/` makes it read as `/health/` | `404` |
| `///health` | RFC 3986 URI-reference parsing reads the authority as empty and the path as `/health` | `404` |
| `//../health` | the same rule yields authority `..` and path `/health`, or dot-segment resolution yields `/health` | `404` |
| `/./health` | dot-segment resolution collapses `/./` to `/` | `404` |
| `/health/../health` | dot-segment resolution applied mid-path | `404` |
| `/health/` | trailing-slash normalization | `404` |
| `/HEALTH` | a case-insensitive comparison | `404` |
| `//127.0.0.1/health` | a protocol-relative reference, whose path is `/health` once the authority is stripped | `404` |
| `//health` † | `//…` read as an authority, leaving an empty path | `404` |
| `//` † | the same rule, with nothing left at all | `404` |
| `http:/health`, `HTTP:/health` ‡ | a scheme makes the target "absolute" to a parser, and both `java.net.URI.getRawPath()` and CPython's `urlsplit().path` then report `/health` — even though there is no authority and this is **not** absolute-form | `404` |
| `http:health`, `a:b/health` ‡ | an opaque URI: a scheme followed by something that is not a hierarchical path | `404` |
| `http://any.host/health`, `HTTP://any.host/health` (absolute-form) | a request line may legally carry an absolute-form target, and every parser involved reports its path as `/health` — but it carries its own authority, so honouring it would make this server answer for any host name a caller wrote | `404` |
| `/health#fragment` | a fragment is not permitted in a request target at all (RFC 9112, §3.2), so the target is compared literally rather than trimmed | `404` |
| `health` †‡, `*` †, or any other target that is not origin-form | not a path at all | `404` |

### 5.1.2 The documented runtime boundaries, and one shared invariant

Each of the three runtimes refuses some malformed targets in its own protocol layer, before any application code is entered. Those refusals are boundaries of the runtime, not choices of the application, and no runtime here exposes a pre-routing or default-handler hook that could reach them. They are enumerated rather than glossed over, because a probe that assumed one tier's behaviour at another would report a false failure. Every cell below was measured, not inferred.

| Target or method class | Level 1 (`node:http`, llhttp) | Level 2 (`http.server`) | Level 3 (`com.sun.net.httpserver`) |
| --- | --- | --- | --- |
| Every unmarked row of §5.1.1 | application `404`, JSON | application `404`, JSON | application `404`, JSON |
| `//health`, `*`, and an absolute-form target with no path (`http://any.host`) † | application `404`, JSON | application `404`, JSON | **runtime `404`, `text/html`** |
| `//` † | application `404`, JSON | application `404`, JSON | **runtime `400`, `text/html`** |
| A bare relative reference: `health`, `frobnicate` †‡ | **runtime `400`** | application `404`, JSON | **runtime `404`, `text/html`** |
| `http:/health`, `HTTP:/health` ‡ | **runtime `400`** | application `404`, JSON | application `404`, JSON |
| `http:health`, `a:b/health` (opaque) ‡ | **runtime `400`** | application `404`, JSON | **no response; connection closed** |
| A method token the parser does not recognise (`FROBNICATE`, or lowercase `get`) | **runtime `400`** | application `405` + `Allow` | application `405` + `Allow` |

**† Level 3 — the *dispatcher* routes on a parsed path; the *application* does not.** `com.sun.net.httpserver` selects a handler using the decoded path of the parsed request URI, in the connection dispatcher, before any handler runs. A target that parses to an empty path, an absent path, or a path with no leading `/` matches no registered context, so the runtime answers from its own reject path with a short `text/html` body. An *opaque* target parses to a `null` path, leaving the dispatcher nothing to match at all, and the connection is closed with no status line. Every target the dispatcher *does* admit reaches the application, which then applies §5.4.1 to the raw target and never to that parsed path — which is why the rows above are the complete set of Level 3 divergences rather than a sample. Confirmed against JDK 25 and in the runtime's own source. Level 3 keeps `com.sun.net.httpserver` because the plan of record mandates exactly that server for this tier and asserts the presence of its `jdk.httpserver` module inside the runtime image; hand-writing an HTTP/1.1 stack to reshape a handful of error bodies would trade a documented cosmetic gap for an undocumented parsing surface in the one component whose job is to be trustworthy.

**‡ Level 1 — the parser validates the request line.** Node's HTTP parser admits origin-form and a complete absolute-form URL with an authority, and answers `400 Bad Request` of its own making — before a request listener runs — to everything else: a target carrying a scheme but no authority (`http:/health`), an opaque `scheme:rest` target, and a bare relative reference with no leading `/` (`health`). It rejects any method token outside its own table the same way. This is the mirror image of the Level 3 boundary: where Level 3 hands the application more spellings than the contract defines, Level 1 hands it fewer.

**The invariant that holds at every tier, on both sides of every boundary**, and which each tier's suite asserts directly rather than assuming:

- `GET` and `HEAD` on the exact path — and only there — are answered `200` with the four-member body.
- **No** other spelling of the target is ever served: no response to any row of §5.1.1 carries a `status` member, whoever produced it.
- No refused method and no refused target is ever answered `2xx`, and none is ever answered `5xx`.
- The listener keeps serving the real resource immediately afterwards, so a malformed target is a dead end for the caller that sent it and never a way to take the endpoint down.

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

### 5.4 Method is checked before path, and the path is compared raw

Two ordering and parsing rules that three independent implementations get inconsistent unless they are written down:

1. **The method check runs first.** `POST /health` returns `405`, not `404`; `POST /unknown` also returns `405`, because the request never reaches the path comparison. A caller therefore always learns the most actionable fact first: that the method it used is not permitted anywhere on this server.
2. **Compare the raw origin-form path, with only the query removed.** `GET /health?x=1` MUST return `200`, so the query component — everything from the first `?` — is cut off and never reflected in the response. **Nothing else may be done to the request target before the comparison**, which is then exact equality against `/health`. Concretely, an implementation MUST NOT resolve dot segments, MUST NOT percent-decode, MUST NOT collapse repeated slashes, MUST NOT trim a fragment and MUST NOT accept a non-origin-form target. Every row in §5.4.2 is a consequence of that one rule.

#### 5.4.1 The path-extraction algorithm, stated once for all three tiers

Given the request target exactly as received, every implementation MUST derive the path with these steps and no others:

```text
1. An empty or absent target matches nothing.
2. A target that does not begin with "/" matches nothing.  (absolute-form,
   protocol-relative-with-scheme, asterisk-form, authority-form, an opaque
   scheme:opaque target, or anything else that is not origin-form)
3. Discard everything from the first "?" onward.           (the query component)
4. What remains IS the path, taken verbatim: nothing decoded, no run of slashes
   collapsed, no dot segment resolved, no fragment trimmed.
```

Then compare the result to the frozen resource path with exact string equality.

Four properties of that algorithm are the reason it is specified here rather than left to each language's URL parser:

- **It never decodes.** `%68` stays `%68`, so `/%68ealth` is a different resource from `/health` and answers `404`. A parser that decodes first would serve the endpoint through an unbounded family of spellings.
- **It never normalizes.** `///health`, `//../health` and `/./health` keep their exact bytes and therefore fail the comparison. This matters because the three runtimes normalize *differently* — one reads a leading `//` as an authority, another resolves dot segments, a third decodes escapes — so any implementation that inherits its routing decision from its parser produces a contract that varies by tier.
- **It accepts origin-form only, and it decides that by the leading `/` alone — never by asking a parser whether the target is "absolute".** Absolute-form (`GET http://any.host/health HTTP/1.1`) is legal in a request line and a server MUST answer it, but it carries its own authority: honouring it would make this endpoint answer for any host name a caller chose to write, which is a second spelling of the one resource. It is therefore *answered*, with the contract's own `404`, rather than served. The single-character test is also what makes the rule immune to the parsers' own disagreements: `java.net.URI.isAbsolute()` is true of `http:/health` and CPython's `urlsplit()` assigns that same target the path `/health`, so an implementation that branched on a parser's verdict and then took the parser's path would publish the endpoint under a spelling no client of this contract sends.
- **It is one comparison, on bytes the client actually sent.** That is what makes the rule assertable: each tier's suite writes these targets onto a socket verbatim and reads the status code back, with no client library in a position to rewrite them first.

Implementations MUST read the target from the source that preserves the client's bytes: `req.url` at Level 1, the request line's second field at Level 2 (the standard library rewrites the parsed attribute), and the request URI's own string form at Level 3 — `getRequestURI().getPath()` there is percent-decoded and its authority normalized, so it is unusable for this comparison, while `getRequestURI().toString()` returns the received target verbatim for every form the dispatcher admits.

Three target classes never reach application code at one tier or another, because a runtime refuses them in its own protocol layer first. Those boundaries are documented, measured and unchanged by this rule; §5.1.2 enumerates them.

#### 5.4.2 Targets that MUST answer `404`

The contract admits exactly one route. Any other spelling of it is an undocumented alias — monitoring, access logs and any intermediary in the path all see it as a different resource from the real one — so every target below MUST answer `404 Not Found` with the standard error body wherever the request reaches application code, and each is asserted by the tier suites. §5.1.1 lists the same rule case by case, with the parser behaviour that motivates each row.

| Request target | Why it is not `/health` |
| --- | --- |
| `/health/` | Trailing slashes are not normalized |
| `/HEALTH` | The comparison is case-sensitive, as an HTTP path is |
| `/other/../health`, `/health/../health`, `/./health`, `/a/b/../../health` | Dot segments are not resolved. A general-purpose URL parser — the WHATWG `URL` class, for instance — collapses all four to `/health`, which is exactly why the target must not be handed to one |
| `/%2e%2e/health`, `/%2E%2E/health`, `/%68ealth` | Percent-encoded bytes are not decoded. `URI.getPath()` in Java decodes, so an implementation there MUST read the raw target instead |
| `/health#anything` | A fragment is not permitted in a request target at all (RFC 9112, §3.2), so the target is taken literally rather than trimmed |
| `http://any.host/health` (absolute-form) | The target carries its own authority. Honouring it would make the endpoint answer for any host name a caller chose to write. The request is still *accepted* — it receives a well-formed, contract-defined response — but its target does not name a resource this server serves |
| `//any.host/health` (protocol-relative) | Parsed as an authority by URL and URI parsers alike, and not the frozen path in any case |
| `*` (asterisk-form) | Never names a resource. Note that because the method is checked first, a request such as `OPTIONS *` answers `405` at the tiers whose runtime routes it to application code at all |

## 6. Per-tier identity, ports and environment overrides

| Tier | `name` | Version | Default port | Bind address | Environment overrides |
| --- | --- | --- | --- | --- | --- |
| L1 `parent_repo_10_LOC` | `parent_repo_10_LOC` | `1.0.0` | 3000 | `0.0.0.0` | `PORT`, `HOST` |
| L2 `child_repo_10_LOC` | `child_repo_10_LOC` | `1.0.0` | 8000 | `0.0.0.0` | `HEALTH_PORT`, `HEALTH_HOST` |
| L3 `nested_child_repo_10_LOC` | `nested_child_repo_10_LOC` | `1.0.0` | 8080 | `0.0.0.0` | `HEALTH_PORT`, `HEALTH_HOST` |

Four properties of that table are deliberate and MUST be preserved:

- **Each tier owns a distinct default port**, because all three applications may run simultaneously on one host during validation — and the apex workflow specified in §12.1 is required to run them that way. Port 3000 belongs to Level 1, port 8000 to Level 2 and port 8080 to Level 3. All three were verified free on the reference host before being assigned, and all three servers have been observed serving this contract concurrently on one host.
- **The override variable names differ by tier on purpose.** Level 1 uses the plain `PORT` and `HOST`; Levels 2 and 3 use `HEALTH_PORT` and `HEALTH_HOST`. This asymmetry is intentional and MUST NOT be "harmonized": the Level 2 and Level 3 applications each already own a general-purpose process environment, and prefixing their variables keeps the health listener's settings unambiguous.
- **Every probe targets `127.0.0.1`** — never `0.0.0.0`, never a public hostname, and never an assumption about how `localhost` resolves. A health probe asserts the state of *this* process inside *this* container, so it MUST address the loopback interface directly. `0.0.0.0` is a bind address only; it is never a destination.
- **All three tiers declare version `1.0.0`.** This is the first version identity in the composition's history, and it is the subject of the cross-tier version-consistency gate the apex workflow MUST carry (§12.1): the `version` member returned by all three endpoints has to match each tier's declared version, and the three declarations have to agree. Only the apex can discharge that gate, because it is the only place all three tiers are checked out together.

## 7. Where the values come from

### 7.1 Resolution precedence, applied per setting

Every value the endpoint *serves* is resolved **once, at start-up, in exactly one place per tier**, from a declared source rather than written inline at its point of use. The chain is **not** uniform across those values, though, and conflating the two kinds is how an implementer ends up looking for an override that does not exist. Highest precedence first:

```text
environment variable → configuration source → compiled-in literal fallback
```

The environment variables are exactly the two per tier named in §6: `HOST` and `PORT` at Level 1, `HEALTH_HOST` and `HEALTH_PORT` at Levels 2 and 3. An unset, empty or unusable value falls through to the next link rather than failing the process, so `PORT=` and `PORT=not-a-number` both yield the configured default instead of a start-up crash.

The **shape** of that chain is uniform at all three tiers, but **which links a given setting has is part of this contract, not an implementation detail**. A setting with no environment override has two links rather than three, and two of the values have no chain at all. The table below is normative; "identity source" and "serving source" are the per-tier files listed in §7.2.

| Setting | Resolution chain, highest precedence first | Environment override |
| --- | --- | --- |
| `host` | environment variable → serving source → compiled-in literal | **yes** — `HOST` at L1, `HEALTH_HOST` at L2 and L3 |
| `port` | environment variable → serving source → compiled-in literal | **yes** — `PORT` at L1, `HEALTH_PORT` at L2 and L3 |
| `name` | identity source → compiled-in literal | **no** |
| `version` | identity source → compiled-in literal | **no** |
| `path` | **no chain at all** — a compiled-in contract constant (§7.1.1). The serving source may *declare* it; a declaration that differs is refused and reported | **no** |
| `status` | **no chain at all** — a compiled-in protocol constant, resolved from nothing (§7.5) | **no** |

Four consequences of that table MUST be honored rather than inferred:

- **`host` and `port` are the only environment-overridable settings, and each tier declares exactly two variables for them** (§6). An implementation MUST NOT introduce `APP_NAME`, `APP_VERSION`, `HEALTH_PATH` or `HEALTH_STATUS` variables — they are not part of the design and nothing reads them.
- **`name` and `version` come from the tier's identity source, never from the environment.** They describe the build rather than the deployment, so a deployment cannot rename or re-version a running application. This is what makes the `version` member trustworthy evidence of which build is live.
- **`path` is not read from anywhere; it is *audited* against the serving source.** Moving the resource path per process would break the contract every consumer probes, so the compiled-in constant is what routes, and a serving document declaring a different path MUST be refused, reported once at start-up (§12.5), and the frozen path served regardless. A declaration equal to the constant changes nothing and is not reported.
- **`status` is not configurable at any tier, by any mechanism.** It is not read from a file, not read from the environment, and not a member of any tier's resolved settings; §7.5 states that rule normatively. A serving file MAY still *declare* `UP` as documentation of the contract that tier serves — Levels 1 and 2 do, and Level 3's `application.properties` declares no status key at all — and a declaration that disagrees with the compiled-in constant MUST be reported and ignored rather than adopted. A settable status would let a deployment lie about its own health.

> The compiled-in literal fallback is **required, not optional**, and it is the last link of every chain that has one. It guarantees that the endpoint still serves a valid contract when a configuration source is absent from a container image — which is precisely the failure mode a health endpoint has to survive. An endpoint that cannot answer because its own configuration is missing is worse than no endpoint at all, because it turns a running application into one that reports itself unhealthy. Each tier's literals MUST be identical to the values its configuration source declares, so that a missing file degrades to identical behavior rather than merely to some behavior.

A fallback is nonetheless **never silent**. Because a served-from-fallback response is indistinguishable from a correctly configured one — same `200`, same four members, same green container health check — each tier records *why* a declared source failed to supply its values and its entry point reports that once at start-up. §12.5 specifies that diagnostic.

No handler hard-codes a value inline at its point of use. Each setting is resolved once, through its own chain above — or, for the two frozen values, bound once from the named constant — and then referenced. Resolution happens **once at start-up**, never per request (§9.1).

**Where resolution happens, per tier.** Level 2 and Level 3 each resolve everything in one place: the payload module at Level 2, and the server class at Level 3. Both read their declared source exactly once, hold the result, and use it for two purposes — resolving the settings that have a chain, and auditing the two frozen values against what the file declares. Level 1 deliberately splits it in two, and the split is worth knowing before reading the code:

- `health.js` resolves every served value at module load and exposes the result as a frozen `config` object — applying the environment layer to `host` and `port` only, resolving `name` and `version` from the identity manifest to its fallback with no environment layer at all, and taking `path` and `status` from the frozen constants of §7.1.1 rather than from any chain. That object is what the payload builder serves from, so what the endpoint *says* is settled there and nowhere else.
- `server.js` re-applies `HOST` and `PORT` over that resolved configuration at the moment it binds, so the bind target is decided at bind time rather than inherited from module-load time.

The split exists because the two concerns have different lifetimes: what the endpoint *says* is fixed for the life of the process, whereas what it *binds to* is a property of this particular launch. Both sites read the same two variable names with the same precedence, so the effective behavior is the single chain documented above; there is no second, competing source.

This document is the single normative statement of what those values are; each tier's identity and serving sources are the single runtime source it resolves them from.

### 7.1.1 Two values are frozen and take no part in that chain

The **resource path `/health`** and the **`status` literal `UP`** are contract constants, not settings. Each implementation MUST compile both in, and MUST route and report from those constants alone.

A tier's serving configuration file — `config/health.json` at Levels 1 and 2, `application.properties` at Level 3 — still *declares* the keys it has, because an operator reading that file should be able to see the whole shape of what is served in one place. Levels 1 and 2 declare both keys; Level 3 declares `health.path` and deliberately declares no status key (§7.3), and a `health.status` added there by hand is audited exactly like `health.path`. Such a declaration is a **restatement**, never an input:

- A declared value equal to the frozen value changes nothing.
- A declared value that differs is **rejected**: the endpoint keeps serving the frozen value, and the entry point MUST print one warning line naming the key, the value that was configured and the value served instead (§12.5). Rejecting silently is not sufficient — an operator who edited the file is entitled to learn the edit had no effect, rather than discovering it later as a gap in monitoring.
- No environment variable exists for either value at any tier, and none may be added.

The reason both are frozen rather than merely defaulted is that they are load-bearing far outside the process that reads them: every workflow assertion, every container `HEALTHCHECK` instruction and every orchestrator liveness probe in this composition is written against the literals `/health` and `UP`. A configurable path would silently move the endpoint away from where all of those look for it, and a configurable status would let a deployment report a value its own behavior does not support — in both cases producing a response that is still syntactically valid, which is the hardest class of failure to notice. §5.4 states the path rule normatively and §7.5 does the same for `status`.

### 7.2 Per-tier configuration sources

| Tier | Identity source (`name`, `version`) | Serving source (host and port; also restates the frozen path and status per §7.1.1) | Dotenv template | Runtime-version pin |
| --- | --- | --- | --- | --- |
| L1 | `package.json` | `config/health.json` — host, port and path; it also declares `status`, as documentation only | `.env.example` | `.nvmrc` (`24.18.0`) |
| L2 | `pyproject.toml`, read through the standard-library `tomllib` module | `config/health.json` — host, port and path; it also declares `status`, as documentation only | `.env.example` | `.python-version` (`3.14.6`) |
| L3 | `application.properties`, read from the classpath, with literal fallbacks | `application.properties` — host, port and path only; it declares **no** status key at all | **none** | **none** |

Every source in that table sits behind the compiled-in fallback required by §7.1, so a missing file degrades nothing observable.

The `status` column differs between tiers for one concrete reason rather than by accident. Levels 1 and 2 read serving parameters from a JSON document their runtimes parse natively, so carrying the literal there costs nothing and keeps every served value in one file. Level 3's `application.properties` is restricted to exactly five keys — `app.name`, `app.version`, `health.port`, `health.host`, `health.path` — and a `health.status` key is **prohibited** there: making the frozen invariant look configurable in the one tier whose configuration format invites hand-editing would be a worse defect than the asymmetry. In all three cases the served value is `UP` and nothing can change it, which is what §2 and §3 mean by calling it frozen.

All paths in that table are relative to the tier's own repository root. Each tier's **core source is flat**: every implementation, test, identity-manifest and container file belongs directly at its repository root, exactly where `index.js`, `app.py` and `User.java` already lived. The feature introduces only three directories anywhere in the composition — `config/` at Levels 1 and 2, `docs/` at the apex alone (this file), and `.github/workflows/` at each tier once those workflows are added. There is no `src/` directory, no `tests/` directory and no package hierarchy at any tier; `User.java` in particular stays in the default package at its original path, so the Level 3 gitlink keeps resolving to the same artifact. An implementer who introduces a nested layout breaks the default test discovery this feature relies on — `node --test` finding `index.test.js`, `python -m unittest` finding `test_app.py`, and `javac *.java` compiling the Level 3 sources in one command.

Read the two source columns together with the per-setting chains in §7.1: the identity source supplies `name` and `version` only, and the serving source supplies `host` and `port` only. It supplies neither `path` nor `status` at any tier — every file that declares one of those declares it as documentation of the contract that tier serves, no handler reads it, and a declaration that disagrees with the compiled-in constant is reported and ignored (§7.1.1, §7.5). Where a tier's source omits a key it does supply, the compiled-in literal for that setting is the whole of its resolution.

### 7.3 The Level 3 asymmetry is deliberate and MUST NOT be "corrected"

> Level 3 has no `.env.example` and no runtime-version dotfile. Java has no dotenv convention without a third-party library, and adding one would breach the composition's zero-dependency constraint, so `HealthServer` reads `HEALTH_PORT` and `HEALTH_HOST` through `System.getenv` with `application.properties` supplying the defaults. Both overrides are documented in comments inside that properties file, and the Level 3 README MUST document them as well. The Level 3 runtime pin has no dotfile to live in either; it is to be carried by the workflow's `java-version` input and the Dockerfile tag instead.

An engineer who notices that Level 3 is "missing" two files that Levels 1 and 2 have is seeing an intentional consequence of the zero-dependency rule, not an oversight. Adding a dotenv template or a version dotfile at Level 3 would either add a dependency or add a file nothing reads. Leave it as it is.

Level 3 carries one further deliberate asymmetry, in its serving source rather than in its file set: **`application.properties` declares no status key.** It declares `app.name`, `app.version`, `health.port`, `health.host` and `health.path`, and nothing else; `HealthServer` holds `UP` as a compiled-in constant that no key can override. Levels 1 and 2 *do* carry a `status` member in `config/health.json`, but it is a declaration and not an input — no handler at either tier reads it, and a value other than `UP` is reported and ignored rather than adopted (§7.1.1, §7.5). Adding a `health.status` key at Level 3 to "match" the other two would therefore widen the surface for no gain: it would make a frozen invariant *look* configurable in the one tier whose configuration format invites hand-editing. A key added there by hand is audited exactly as `health.path` is, so a value other than `UP` is refused and reported at start-up. Leave the file as it is.

### 7.4 The Level 1 CommonJS constraint

The apex `package.json` **MUST NOT declare the ES-module `type` field.** Node resolves `index.js` as CommonJS today, and the `require.main === module` guard that keeps the pre-existing program's behavior intact (§12.3) depends on that resolution. Declaring the module type would silently change it, and the failure would surface as a behavioral regression rather than as an error at the point of the change. The omission is a review checkpoint, not an accident — see [`../package.json`](../package.json).

### 7.5 `status` is a protocol constant and MUST NOT be configurable

The resolution chain of §7.1 governs the serving parameters and the identity members. It does **not** govern `status`, and the distinction is normative:

- **The `status` member MUST be a compiled-in constant in each handler's own code** — `STATUS_UP` at Level 1, `STATUS_UP` at Level 2, `STATUS_UP` at Level 3 — carrying the literal `UP`. Every implementation emits that constant directly.
- **No environment variable, no configuration file and no command-line argument may change it.** An endpoint whose liveness answer can be set from outside the process is not a liveness answer: it lets a deployment claim to be healthy, or misreport itself as something else, without the process's actual state having any bearing on the payload. The value is a term of the wire protocol, in the same category as the `200` status code and the `Content-Type` header, and none of those are configurable either.
- `status` is a constant precisely because this endpoint performs **no dependency checks** (§9). There is no observation for a configured value to override.

Each tier's `config/health.json` does declare a `status` member, and it is retained deliberately: it documents, in the same place as the other serving values, which liveness literal that tier's contract carries, and it is what a human or a schemaless tool reads first. It is a **declaration, not an input.** No handler reads it. To keep the declaration from drifting away from the constant that is actually emitted, each tier's test suite asserts that the declared member equals the compiled-in constant — the pin points from the file to the code, never the other way round. Level 3 declares no such member at all, because `application.properties` was never given one.

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

A raw clock read is **not sufficient** to deliver that guarantee, and this is the clause implementers most often get wrong. The contract's precision is milliseconds, so two probes — or a poller retrying immediately, or a container probe racing a CI assertion — can easily land inside the same millisecond, and a handler that simply formatted `now` would hand both of them the identical string. At that moment a live process becomes indistinguishable from a frozen one, which is the precise failure the per-request timestamp exists to expose. Weakening the assertion to "differ or match" would delete the property rather than test it, and inserting a delay before the second call would only prove that the clock moved while the caller waited.

Each tier therefore **MUST allocate the timestamp monotonically**, not merely read it:

```text
now = wall clock in epoch milliseconds        (read on EVERY call, never cached)
issued = now > last_issued ? now : last_issued + 1
last_issued = issued
```

Four properties follow, and all four are requirements:

- **The clock is read on every call**, so the value tracks real time and can never be a start-up capture.
- **Consecutive values always differ**, including inside one millisecond, so §2's "always" is literal.
- **Values are strictly increasing**, so a backwards clock adjustment — an NTP step, a leap-second smear, a suspended VM resuming — can neither repeat a value nor make a later response appear older than an earlier one.
- **The correction is bounded and self-cancelling.** The `+ 1` applies only while calls arrive faster than the clock ticks; the moment real time catches up, the wall clock wins again. An endpoint answering a poller every few seconds never enters that regime at all, so the served value never drifts persistently ahead of real time.

**The allocation MUST be safe against concurrent requests** at any tier whose server handles them concurrently — which is every tier here. The read-modify-write above is a critical section: Level 2 serves on `ThreadingHTTPServer` and Level 3 on a multi-threaded executor, so both MUST guard it (a mutex at Level 2, a compare-and-set loop at Level 3). Level 1 is single-threaded and needs no lock, but its allocator MUST contain no `await`, because suspending inside the critical section would reintroduce exactly the interleaving the lock exists to prevent at the other two tiers.

Freshness is measured, not assumed, and it is measured **without any delay between the calls** — a delay would reduce the check to "time passed". Immediately consecutive builder calls, and immediately consecutive responses over a real socket, return different `timestamp` values while `name`, `version` and `status` stay identical. Bursts drawn inside a single millisecond tick return values that are all distinct and strictly increasing, and a companion assertion bounds how far allocation may sit ahead of the wall clock, so the correction is proven finite rather than merely asserted to be. Reverting an implementation to a bare clock read fails those checks, which is how the guarantee is known to be tested rather than assumed.

### 9.3 Why the handler does nothing else

Established operational practice for health endpoints is that the probe stays lightweight and performs no heavy work, because a probe that does real work becomes a source of the very load it is meant to report on, and its timeouts start reporting the monitor's problems rather than the application's. This contract therefore forbids per-request file I/O, per-request network calls and dependency interrogation of any kind inside the handler. Reading an already-loaded value and reading the clock is the entire permitted workload.

That restriction has a second consequence worth stating outright: because the handler performs no I/O, it has no *expected* failure path, so **no routed request can produce a `5xx`**. The three status codes of §5.1 are the whole of the contract's normal vocabulary, and an implementation that adds a server-error branch to the *routing* path is either doing work it should not be doing or reporting a fault it cannot have.

"No expected failure path" is not the same as "no possible failure", though, and the difference is what the rest of this section is about. A defect in the handler — the kind a future edit introduces, not one the current code can reach — must not be resolved by inventing a status. Two responses to it are specifically **forbidden**:

- **A `404` MUST NOT be returned for an internal fault.** A `404` is a statement about the *client's* request target, so returning one after an internal failure blames the caller for the server's defect. A poller records a clean, contract-shaped response, a human hunts for a typo in a URL that was correct, and the real fault leaves no trace anywhere. Misreporting is worse than not reporting, because it actively misdirects the investigation.
- **The failure MUST NOT be swallowed silently.** Closing the connection is an honest transport-level outcome when there is no defined response to send, but on its own it is indistinguishable from a network blip.

#### 9.3.1 The internal-fault policy, canonical for all three tiers

This is the one clause where the tiers are permitted to differ in what reaches the wire, so the policy is stated here once and each implementation carries the same wording:

1. **Report the fault server-side**, by stable category, exactly as §12.5 specifies — once per distinct category and bounded.
2. **Never answer `404`, and never answer `2xx`.** A fault must not be reported as the client's mistake, and it must never be reported as health.
3. **Fail closed in the way the tier's own runtime allows**, then complete the exchange:
   - When **nothing has been sent yet**, a tier MAY answer `503 Service Unavailable` with the body `{"error":"Service Unavailable"}` — the honest statement that this process is not able to serve the request — or it MAY close the connection without a status. Levels 1 and 3 answer `503`; Level 2 closes the connection. Both discharge this clause, and neither is more conformant than the other.
   - When a **response is already in flight** and its status line can no longer be retracted, the response is ended and the connection closed. No second status may be written.
4. **Nothing about the fault is reflected to the client** — no exception type, no message, no stack trace, in any of those outcomes.

A `503` from this path is **not** part of the contract's normal vocabulary: no routed request can elicit one, no probe or workflow may treat it as an expected response, and a tier that starts returning it under load has a defect to fix rather than a documented behavior to rely on. It is specified here only so that the honest answer is a defined one rather than an improvisation. §12.5 specifies the accompanying diagnostic, including the bound on how much of it may be emitted.

### 9.4 Formatting the timestamp in each language

The mandated form is RFC 3339 UTC with a `Z` suffix and exactly three fractional digits. `Date#toISOString` emits precisely that form natively — verified, producing values such as `2026-07-28T15:03:08.665Z` and matching the contract regex — so the JavaScript tier needs no formatting helper beyond that one call. The Python and Java tiers format explicitly to match it. Implementations MUST NOT emit a numeric offset such as `+00:00` in place of `Z`, MUST NOT emit microsecond precision, and MUST NOT drop the fractional part when it happens to be zero.

The whole-second case is the trap in that last clause: a formatter that trims insignificant zeros renders a whole second as `…:20Z` rather than `…:20.000Z` and silently fails the regex, and it does so only for one millisecond in every thousand — so it will pass a naive test run and fail in production. Java's `Instant#toString` behaves exactly that way and MUST NOT be used; an explicit `yyyy-MM-dd'T'HH:mm:ss.SSS'Z'` pattern at UTC is required instead. Because the allocator of §9.2 separates *choosing* the instant from *rendering* it, each tier can expose the renderer and assert `.000` deterministically by formatting a chosen whole-second instant, rather than waiting for the clock to land on one and hoping the run is not flaky.

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

This section specifies the container definitions the feature requires. **No `Dockerfile` exists at any tier yet** — the composition had no container artifact of any kind before this feature, so each tier's `Dockerfile` and `.dockerignore` is a create rather than an edit, and what follows is the normative design each one MUST implement rather than a description of files in the tree.

Each tier's image MUST declare a `HEALTHCHECK` that exercises this endpoint. **Every probe MUST be language-native and install nothing**, because `curl` cannot be assumed present in a minimal image — and the Debian-slim Python base carries neither `curl` nor BusyBox `wget`. Using only the runtime that is already in the image keeps the probe reliable and keeps the image free of packages added solely to observe it.

| Tier | Base image (pinned by tag) | Probe mechanism | Start period |
| --- | --- | --- | --- |
| L1 | `node:24-alpine` | inline `node -e` using Node's built-in global `fetch` | `--start-period=5s` |
| L2 | `python:3.14-slim` | inline `python -c` using `urllib.request` | `--start-period=5s` |
| L3 | multi-stage `eclipse-temurin:25-jdk-alpine` to compile, `eclipse-temurin:25-jre-alpine` to run | `java -cp /app HealthServer --check`, using `java.net.http.HttpClient` | `--start-period=20s`, for JVM start-up |

Level 3's probe is a `--check` mode on `HealthServer` itself, and that mode is already implemented: with no arguments the class serves the endpoint, and with `--check` it acts as a `java.net.http.HttpClient` client that asserts a `200` response whose body carries the `UP` status member, then exits `0` or `1`. That keeps the probe in the same language and the same artifact as the server, so all three tiers fail for the same reasons and report the same way. `jlink` is not used anywhere; a published JRE image serves, and a custom runtime image would add build complexity for no gain.

### 11.1 Timing and exit-code semantics

| Option | Value | Why |
| --- | --- | --- |
| `--interval` | `30s` | The endpoint does no work, so a slower cadence costs nothing and avoids adding probe traffic to a busy host |
| `--timeout` | `3s` | Generous for a handler that reads one clock, and it MUST be strictly less than the interval so a slow probe cannot overlap the next one |
| `--retries` | `3` | A single transient failure does not flip a healthy container to unhealthy |
| `--start-period` | `5s` at Levels 1 and 2, `20s` at Level 3 | A failing probe inside the start period does not count against the retry budget; the JVM needs the wider grace window |

A container begins in the `starting` state and is expected to transition to `healthy` on the first successful probe; that transition is what the container job specified in §12.1 has to observe. The probe communicates through its exit code, and only two codes may ever be returned: **`0` means healthy, `1` means unhealthy, and `2` is reserved and MUST NOT be returned** by any probe in this composition. Every probe command in this design was verified to exit `1` against a dead port, the Level 3 probe additionally printing `probe UNREACHABLE: ConnectException`, so an unreachable server is reported as unhealthy rather than as a broken probe. The Level 3 probe was likewise verified to exit `0` against a live server.

### 11.2 Pinned versions

Every version below is a real, currently supported release. No floating or unresolved tag appears anywhere in this feature.

| Component | Pin | Note |
| --- | --- | --- |
| Node.js | `24.18.0` | Active LTS, end of life 2028-04-30; `engines.node` is `">=24.0.0"` and `.nvmrc` carries the exact version |
| CPython | `3.14.6` | End of life 2030-10-31; `requires-python` is `">=3.11"`, the floor set by `tomllib`, which entered the standard library in CPython 3.11 |
| Eclipse Temurin JDK | `25` | Current LTS; supplies the `jdk.httpserver` and `java.net.http` modules the Level 3 tier needs |
| `actions/checkout` | `v7.0.1` | To be referenced by all three workflows |
| `actions/setup-node` | `v7.0.0` | Level 1 workflow |
| `actions/setup-python` | `v7.0.0` | Level 2 workflow |
| `actions/setup-java` | `v5.6.0` | Level 3 workflow, with the Temurin distribution |
| Third-party runtime packages | **none** | Zero added, zero removed, zero updated |

The runtime pins in the first three rows are already in effect — `.nvmrc`, `.python-version` and the verified JDK provide them — while the four action pins are the values the workflows MUST use when they are added.

The presence of `jdk.httpserver` inside the Level 3 runtime image MUST be asserted in that tier's workflow rather than assumed. If the module is ever absent from the JRE image, the documented fallback is to use the JDK Alpine image as the runtime stage as well — a larger image, but a correct one. The module's presence has been confirmed in the JDK used for development; the runtime *image* is the case that still has to be checked, and the transition of each container to `healthy` likewise has to be observed in CI, because the environment this contract was authored in had no container runtime available.

## 12. How conformance is asserted, and what is preserved

### 12.1 Where the gates live

Conformance is asserted at two levels, and only one of them is in place today.

**In place now:** each tier carries its own test suite — `index.test.js` at Level 1, `test_app.py` at Level 2, `HealthCheckTest.java` at Level 3 — and each suite asserts the §12.2 response contract against a server it starts on an ephemeral loopback port, plus that tier's regression fingerprint from §12.3. Each is runnable with one command and no third-party package: `node --test`, `python -m unittest`, and `javac *.java` followed by `java -cp . HealthCheckTest`.

**Required, and not yet present:** a workflow named `.github/workflows/health-check.yml` MUST exist in **each of the three repositories**, not only at the apex. That is a structural necessity rather than duplication: a check gates only the repository that defines it, so a workflow added to the parent repository cannot gate a commit pushed directly to Level 3. Each tier's workflow owns its own syntax gate, unit tests, regression fingerprint and endpoint probe, and no tier may rely on the apex to run them on its behalf.

The apex workflow additionally MUST own three responsibilities that only it can discharge:

- **A credentialed recursive submodule checkout.** The token that GitHub Actions mints automatically for a job is scoped to that job's own repository and cannot read sibling repositories, so a recursive checkout that relies on it fails outright. The apex workflow MUST therefore supply an explicit credential: either a read-only fine-grained personal access token with Contents and Metadata read access on exactly the three repositories, passed through the checkout action's `token` input, or a read-only deploy key passed through its `ssh-key` input. Least privilege is the requirement — never a broadly scoped credential, and no credential value may ever appear in a tracked file or a workflow log.
- **Materialization asserted by file existence.** A recursive submodule update issued from a level that registers no submodule configuration returns success with no output, so its exit code proves nothing. The workflow MUST therefore verify that the expected source files exist on disk after checkout, and that every line of the recursive submodule status is space-prefixed, before it trusts the tree at all.
- **The cross-tier version-consistency check**, comparing the `version` member returned by all three endpoints against the three declared versions.

### 12.2 The per-response assertions

Every item below MUST be asserted for each tier, against `127.0.0.1` on that tier's port. The tier test suites assert them today against an ephemeral port; the workflows of §12.1 MUST assert them against the tier's declared port once they exist.

- HTTP status `200`.
- `Content-Type` exactly `application/json; charset=utf-8` and `Cache-Control` exactly `no-store`, compared with case-insensitive header names (§2).
- Exactly four body members, in the order `name`, `version`, `timestamp`, `status` — both the count and the order are asserted.
- `status` equal to `UP`.
- `name` equal to that tier's declared name, and `version` equal to that tier's declared version.
- `timestamp` matching `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`.
- Two **immediately** successive responses differing in `timestamp` and identical in the other three members, with no delay inserted between them — a wait would reduce the check to "the clock moved" and would pass an implementation that still duplicates values inside one millisecond (§9.2).
- A burst of back-to-back requests in which **no** `timestamp` repeats and each is strictly later than the one before, so the monotonic allocation is exercised in the same-millisecond regime that a raw clock read cannot survive.
- `POST /health` returning `405` with `Allow: GET, HEAD`.
- `GET` on an unknown path returning `404`.
- `GET` on each of the alias spellings in §5.1.1 returning `404`, so that no undocumented spelling of the resource is served. Because HTTP client libraries normalize URLs before transmitting them, an assertion on those targets MUST send the request line itself — through a raw socket or a client API that transmits a supplied path verbatim — rather than through a URL-parsing convenience wrapper.

Every one of those has a single expected value, so a failure names the defect rather than merely reporting that something is wrong.

### 12.3 What is preserved, measured rather than assumed

This endpoint is **purely additive**. Each tier keeps its original one-shot program and its original invocation, and the health server runs from a **separate entry point**: `node server.js` at Level 1, `python server.py` at Level 2 and `java -cp . HealthServer` at Level 3. Running the original program still terminates immediately; nothing about it becomes long-lived.

The preservation of Level 1 is enforced by a fingerprint rather than by inspection. `node index.js` still exits `0`, still writes five lines and fifteen bytes to standard output, still writes nothing to standard error, and the md5 of that standard output is still:

```text
b07373a80ad21069e41be538e6506d00
```

That digest means exactly one thing — the md5 of the standard output of `node index.js` — and it is asserted by the Level 1 test suite today and MUST be asserted by the apex workflow on every run, as a permanent regression gate. At Level 2 the original program still prints `Hello Lakshya`, and at Level 3 it still prints `Test`; both are asserted the same way by their own tiers' suites and MUST be asserted by their own tiers' workflows.

Two further preservation properties are asserted alongside the digest, because both were newly established by this feature and both are easy to break silently: importing `index.js` writes **nothing** to either stream, where before this feature a bare `require` printed `12` five times; and `require('./index.js')` exposes exactly `add`, where before it exposed nothing at all.

### 12.4 Process lifecycle

Each server is the first long-lived process its tier has ever had, so each one installs handlers for `SIGTERM` and `SIGINT` that close the listener in an orderly fashion. A container stop is therefore not a hard kill, and a teardown leaves no orphaned port binding behind to break the next run — each tier's suite asserts exactly that, by stopping a real server with `SIGTERM` and then requiring the port it held to be free again. Every workflow MUST tear down its background servers and containers for the same reason, so that re-running it is idempotent.

Whether a tier prints anything as it stops is deliberately left to the tier, and the three differ: Level 1 writes one orderly-shutdown line, while Levels 2 and 3 write nothing, keeping the single start-up line as the process's entire output for its whole lifetime. Neither choice is more conformant than the other, because **no consumer of this contract may parse a log line** — liveness is read from the endpoint and from the probe's exit code, never from standard output. The one requirement in this area is the one §13 states: nothing is logged per request, at any tier.

A **requested** shutdown exits `0` at every tier. A container stop and a CI teardown are both normal, successful terminations, and reporting a non-zero status for either would make every pipeline teardown look like a failure.

One distinction is worth stating explicitly, because §11.1 reserves exit code `2` and a reader comparing the two sections would otherwise see a conflict. **That reservation governs probe commands, not server processes.** A `HEALTHCHECK` command's exit code is interpreted by the container runtime, where `2` is reserved, so every probe in this composition returns only `0` or `1` — and all three do. A server process's exit status is interpreted by an operator, an orchestrator or a shell, and it is free to distinguish more failure modes:

| Tier | Server process exit statuses | Probe exit statuses |
| --- | --- | --- |
| L1 | `0` requested shutdown · `1` start-up failure | `0` / `1` |
| L2 | `0` requested shutdown · `1` bind failure · `2` the shutdown itself failed | `0` / `1` |
| L3 | `0` requested shutdown · `1` start-up failure | `0` / `1` |

Level 2's third status exists because a shutdown that cannot complete is materially different from one that completes normally: the port may not have been released, which is precisely the condition that breaks the next CI run, and a caller that saw `0` would have no way to know.

The wider set can never reach a `HEALTHCHECK`, and it is worth being exact about why, because Level 3 is the case that looks like an exception. Levels 1 and 2 probe with a separate inline command (§11), so their entry points are never invoked as probes at all. Level 3 *does* share one artifact between both roles — `HealthServer` serves with no arguments and probes with `--check` — but the two modes have separate exit paths, and the `--check` path returns only `0` or `1`. Sharing the artifact does not share the exit vocabulary.

### 12.5 The two diagnostics, and the silence around them

The endpoint's normal operation is silent past its single start-up line, and that silence is a requirement (§13): a resource polled every few seconds would otherwise become the loudest thing in the log, and a log nobody reads is a log that hides the one line that mattered. But silence has a failure mode of its own — a degradation that produces no output is indistinguishable from correctness — so exactly two diagnostics are defined. Both are **bounded**, both are **sanitized**, and neither is per-request.

**1. The degraded-configuration line, at start-up.** When a declared configuration source cannot supply its values, the tier serves the compiled-in fallbacks (§7.1) and its entry point writes **one line to `stderr`**, before the start-up line, naming each affected source and why. The three tiers' actual output, with no configuration present at all:

```text
L1  health configuration degraded: identity: declared source missing, serving: declared source missing; serving the compiled-in fallback values
L2  server.py: health configuration degraded: identity: declared source missing, serving: declared source missing; serving the compiled-in fallback values
L3  health configuration degraded: declared source missing; serving the compiled-in fallback values
```

Two differences in that output are structural rather than accidental, and an implementation MUST NOT "align" them:

- **Levels 1 and 2 name a source category; Level 3 does not.** Those tiers read identity and serving values from *two separate files*, so a reader needs to know which one failed — `identity` points at `package.json` or `pyproject.toml`, `serving` at `config/health.json`. Level 3 reads both from the *single* `application.properties` (§7.2), so there is only one thing that can have failed and a category would add a word without adding information.
- **Level 2 prefixes its diagnostics with `server.py:`** because that is the convention its entry point already applies to every line it writes. Prefixing is a per-tier stylistic choice; the contract constrains the content, not the prefix.

The content requirements below are binding at every tier:

- The reason comes from a **closed vocabulary** — `declared source missing`, `declared source unreadable`, `declared source malformed`, `declared source incomplete` — optionally paired with a source category (`identity` or `serving`) where the tier has more than one source. Every element is a fixed string.
- A **filesystem path, a file name and any byte of file content MUST NOT appear.** A path discloses layout to everyone who can read the log and is the least useful half of the message anyway, since the reader already knows which files the tier declares. `readFileSync`, `JSON.parse` and their siblings all produce messages that interpolate the offending filename or input, so none of them may be forwarded verbatim.
- The line **MUST name the consequence** — that the endpoint is still answering with valid values — so that a configuration problem is not escalated as an outage.
- A *partially* populated source is **not** a degradation. Omitting `host` while setting `port` is a supported use of the chain, and reporting it would make the diagnostic fire on correct configurations.
- **Importing the payload module MUST remain byte-silent on both streams.** The module *records*; the entry point *reports*. A module that logged at import time would also log when a test imported it, when a tool introspected it, and twice under two specifiers — so each tier exposes the recorded reasons through an accessor and its entry point renders them once. All three unit suites assert the silence directly.
- One measured Level 1 caveat: Node's own CommonJS loader parses the nearest `package.json` to decide module type, so a *malformed* apex manifest fails `require()` with `ERR_INVALID_PACKAGE_CONFIG` before the endpoint's code evaluates. At that tier `identity: declared source malformed` is therefore unreachable — an engineer meeting that state is looking at a loader failure, not at this diagnostic. An *absent* manifest loads normally and is reported.

**2. The handler-failure line, on an internal defect.** When the handler fails in a way the contract has no response for (§9.3), the failure is reported and the connection completed without a fabricated status:

```text
L1  health request handler failed: TypeError; answered 503, nothing else had been sent
L1  health request handler failed: TypeError; connection closed without a response
L2  health request handler failed: ZeroDivisionError; connection closed without a response
L3  health handler failed unexpectedly: IllegalStateException; answered 503, nothing else had been sent
```

The wording differs slightly at Level 3 and the category is naturally each language's own type name. Neither is a defect to be harmonized: what this contract fixes is the **content** of the line — one stable category, the consequence, and nothing else — not its exact prose.

The **consequence** clause is the one part that carries meaning beyond prose, and it reports what actually happened to the response rather than a fixed phrase. Levels 1 and 3 can still put a status line on the wire when nothing has been sent, so both name `; answered 503, nothing else had been sent` there; Level 1 also uses `; connection closed without a response` when the write itself failed, and `; response already in flight, connection closed` when a status line had already gone out and could no longer be retracted. Level 2's handler has no second response available to it — `send_response` cannot be issued twice on one exchange, and by the time its writer can fail the status line has gone — so it closes the connection and says so. §9.3.1 states that policy normatively; all three behaviours conform to it.

- Reporting is **latched per distinct failure category and bounded** — a recurring defect is announced once, and a bounded number of distinct categories ever is. Without both limits a single defect under poll load would emit a line per request.
- The category is a **stable identifier only**: an error code, else an exception class name. The exception's **message MUST NOT be rendered**, because it is the part of an error that routinely interpolates untrusted or sensitive material, and a health endpoint's log is the artifact most likely to be shipped to a central collector. A stack trace MUST NOT be emitted either.
- A category is **sanitized to identifier characters** before rendering. Exception names are writable and class names are caller-chosen in the general case, so a value containing a newline could otherwise forge a second log line — including one impersonating the start-up announcement above.
- **An expected peer disconnect is not a defect and MUST stay silent.** A probe whose timeout expired, a balancer that already got what it needed, an interrupted `curl` — each surfaces as a write failure and none is this process's fault. Implementations classify the transport-level conditions of their runtime (`EPIPE`, `ECONNRESET`, `ECONNABORTED`, `ETIMEDOUT` and the equivalent stream errors in JavaScript; `OSError` and its subclasses in Python) as quiet, and report only what remains.
- **Nothing is reflected to the client.** The caller learns that the connection closed; it never receives exception detail, and it never receives a status the process cannot honestly claim.

The same discipline governs the **bind-failure** diagnostics an entry point emits when it cannot start: a configuration-derived host is validated against an allowlist and replaced wholesale with `<unprintable>` if it fails, rather than being escaped piecemeal, and an unrecognised failure is reported by stable category rather than by the platform's locale-dependent prose. All three tiers use the same `<unprintable>` token, so one search spans the composition's logs.

## 13. Deliberately not provided

A normative contract is as much about what an implementation must not add as about what it must do. The following are out of scope for this feature, and an implementation that adds any of them is non-conformant:

- **No other endpoint.** There is no `/ready`, no `/live`, no `/metrics`, no `/info` and no root resource. `/health` is the only path that returns anything other than `404`.
- **No fifth member, now or later.** The body is exactly the four members in §3. In particular none of the health-check draft's other optional members is emitted: no `checks` object, no `uptime`, no `pid`, no `hostname`, no `releaseId`, no `description`. There is no extension point, because an extension point in a frozen contract is a drift point.
- **No dependency interrogation.** `status` reports process liveness only. The endpoint never reports on anything downstream of itself, because there is nothing downstream of it.
- **No authentication, no transport-layer encryption termination, no rate limiting, no CORS handling and no response compression.** The endpoint is plain HTTP on the loopback interface for probes and on the bound address for orchestrators.
- **No logging framework**, and **no per-request logging** — no access log, no timing line, nothing emitted on the success path. Each entry point logs its bound address once at start-up. The only output beyond that is the two bounded, sanitized diagnostics specified in §12.5, which fire on a degraded configuration at start-up and on an internal handler defect; neither is per-request, and both are latched or one-shot precisely so that they cannot become one.
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

Each tier's own README MUST carry the invocation for that tier and MUST refer to this document by its documented location, `docs/health-endpoint.md` in the parent repository (§1.2). Those README sections are a required deliverable of this feature and are not yet written; the apex README is [`../README.md`](../README.md). This document remains the normative source for the response contract itself, and any change to the contract is made here first — a README that disagrees with it carries the defect.
