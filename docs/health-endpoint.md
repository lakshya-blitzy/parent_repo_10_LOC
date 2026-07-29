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
| `status` value | the frozen invariant `UP`. It is never derived from a dependency check and never overridable from the environment, because the endpoint asserts **process liveness** only. Every tier compiles the literal in; a tier whose serving source declares the member reads that declaration and adopts it **only when it equals the literal exactly**, so the set of values a deployment can cause to be served has exactly one element. §7.1.1 and §7.5 state that rule normatively |
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
| `status` | string | The frozen liveness value `UP`. The endpoint reports that **this process is running and able to answer**; it deliberately reports nothing about any downstream dependency, and no code path may ever emit a different value. | A compiled-in protocol constant, which a serving source may restate but never change (§7.1.1, §7.5) |

The value is invariably the literal `UP`, at every tier, and **no environment variable and no configuration file can redefine it**. A serving document that declares a different `status` is not honoured: all three tiers record the attempt as a frozen-value conflict and report it once at start-up (§12.5), then serve `UP` regardless. Every conformance check asserts equality against the literal `UP` itself, never against whatever the tier's configuration file happens to contain, so a file edited to say anything else fails the gate rather than changing the contract.

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

**One further boundary class concerns the request *line*, not the request target, and it is recorded here because it is the case most likely to be mistaken for a routing defect.** RFC 9112 §3 fixes the request line as method, one space, target, one space, version. A line with anomalous whitespace is malformed, and each runtime's own line parser deals with it before any target reaches the application — differently, and measured:

| Malformed request line | Level 1 (llhttp) | Level 2 (`http.server`) | Level 3 (`com.sun.net.httpserver`) |
| --- | --- | --- | --- |
| `GET··/health HTTP/1.1` (two spaces before the target) | parser collapses it; application sees `/health` and answers `200` | parser collapses it; application sees `/health` and answers `200` | **runtime `404`, `text/html`** |
| `GET /health··HTTP/1.1` (two spaces before the version) | application `200` | application `200` | application `200` |
| `GET⇥/health HTTP/1.1` (a tab in place of the space) | **runtime `400`** | parser accepts it; application sees `/health` and answers `200` | **runtime `400`, `text/html`, "Bad request line"** |

The reason those `200`s are conformant rather than a leak is worth stating precisely, because it looks like the opposite: **no application here trims or normalizes anything.** Each tier's target-extraction function was called directly with the anomalous strings and refused them — `requestTargetPath(" /health")` returns `null` at Level 1 and `request_target_path(" /health")` returns `None` at Level 2, so neither can match the resolved path. Where a `200` is returned, the runtime's line parser had already resolved the target to exactly `/health` before the application was entered, and the application then matched the exact path it always matches. The divergence is in three standard-library line parsers, not in three routings, and an implementation MUST NOT "fix" it by trimming a target — that would create the very alias §5.1.1 forbids.

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
2. **Compare the raw origin-form path, with only the query removed.** `GET /health?x=1` MUST return `200`, so the query component — everything from the first `?` — is cut off and never reflected in the response. **Nothing else may be done to the request target before the comparison**, which is then exact equality against the resolved resource path — a value the validated chain of §7.1.1 guarantees is `/health`. Concretely, an implementation MUST NOT resolve dot segments, MUST NOT percent-decode, MUST NOT collapse repeated slashes, MUST NOT trim a fragment and MUST NOT accept a non-origin-form target. Every row in §5.4.2 is a consequence of that one rule.

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

Then compare the result to the tier's **resolved** resource path with exact string equality.

That the comparison is against the resolved value rather than against the constant directly is deliberate, and the two are not interchangeable even though they are provably equal. The resolved value comes from the validated chain of §7.1.1, which is what makes the serving source a live input rather than a decoration; routing against the constant instead would leave the resolution unused on the one path that matters and would make the declaration unobservable from outside the process. Because a declaration is adopted only on an exact match, routing on the resolved value is exactly as safe as routing on the constant — the value cannot differ from `/health` — while keeping the configuration surface real.

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

Five properties of that table are deliberate and MUST be preserved:

- **Each tier owns a distinct default port**, because all three applications may run simultaneously on one host during validation — and the apex workflow specified in §12.1 is required to run them that way. Port 3000 belongs to Level 1, port 8000 to Level 2 and port 8080 to Level 3. All three were verified free on the reference host before being assigned, and all three servers have been observed serving this contract concurrently on one host.
- **The override variable names differ by tier on purpose.** Level 1 uses the plain `PORT` and `HOST`; Levels 2 and 3 use `HEALTH_PORT` and `HEALTH_HOST`. This asymmetry is intentional and MUST NOT be "harmonized": the Level 2 and Level 3 applications each already own a general-purpose process environment, and prefixing their variables keeps the health listener's settings unambiguous.
- **Every probe targets `127.0.0.1`** — never `0.0.0.0`, never a public hostname, and never an assumption about how `localhost` resolves. A health probe asserts the state of *this* process inside *this* container, so it MUST address the loopback interface directly. `0.0.0.0` is a bind address only; it is never a destination.
- **A port is configurable but `0` is not a configurable value.** Each tier accepts any usable port from its environment variable or its serving source, and refuses `0`, a negative number, a number above `65535` and anything non-numeric, falling through to the next link of §7.1 in every one of those cases. `0` is singled out because it is the one that looks valid: it is a meaningful *bind-time argument* meaning "any free port", and every test listener in this composition takes one that way — but a configured `0` would put the endpoint on a port no probe, `HEALTHCHECK` or orchestrator could predict, which is indistinguishable from not serving it. All three tiers refuse it identically.
- **All three tiers declare version `1.0.0`.** This is the first version identity in the composition's history, and it is the subject of the cross-tier version-consistency gate the apex workflow MUST carry (§12.1): the `version` member returned by all three endpoints has to match each tier's declared version, and the three declarations have to agree. Only the apex can discharge that gate, because it is the only place all three tiers are checked out together.

## 7. Where the values come from

### 7.1 Resolution precedence, applied per setting

Every value the endpoint *serves* is resolved **once, at start-up, in exactly one place per tier**, from a declared source rather than written inline at its point of use. The chain is **not** uniform across those values, though, and conflating the two kinds is how an implementer ends up looking for an override that does not exist. Highest precedence first:

```text
environment variable → configuration source → compiled-in literal fallback
```

The environment variables are exactly the two per tier named in §6: `HOST` and `PORT` at Level 1, `HEALTH_HOST` and `HEALTH_PORT` at Levels 2 and 3. An unset, empty or unusable value falls through to the next link rather than failing the process, so `PORT=` and `PORT=not-a-number` both yield the configured default instead of a start-up crash.

The **shape** of that chain is uniform at all three tiers, but **which links a given setting has, and whether the link is trusted or validated, is part of this contract rather than an implementation detail**. A setting with no environment override has two links rather than three. The table below is normative; "identity source" and "serving source" are the per-tier files listed in §7.2.

| Setting | Resolution chain, highest precedence first | Link discipline | Environment override |
| --- | --- | --- | --- |
| `host` | environment variable → serving source → compiled-in literal | **trusted** | **yes** — `HOST` at L1, `HEALTH_HOST` at L2 and L3 |
| `port` | environment variable → serving source → compiled-in literal | **trusted**, subject to the usability rule below | **yes** — `PORT` at L1, `HEALTH_PORT` at L2 and L3 |
| `name` | identity source → compiled-in literal | **trusted** | **no** |
| `version` | identity source → compiled-in literal | **trusted** | **no** |
| `path` | serving source → compiled-in literal | **validated** (§7.1.1) | **no** |
| `status` | serving source → compiled-in literal at Levels 1 and 2; the compiled-in literal alone at Level 3, whose serving source declares no status key by design (§7.3) | **validated** (§7.1.1, §7.5) | **no** |

**Trusted versus validated is the distinction the whole design turns on**, and it MUST NOT be collapsed in either direction:

- A **trusted** link adopts whatever the source supplies, provided the value is usable at all. Whatever `config/health.json` says the port is, that is the port.
- A **validated** link *reads* the declaration and then *compares* it against the frozen contract literal, adopting it **only when the two are equal after trimming surrounding whitespace**. Any other value — a different path, a different case, a trailing slash, a blank string, a value carrying a newline — is refused: the literal is served, the disagreement is recorded, and the entry point reports it once at start-up (§12.5). A declaration that agrees changes nothing observable, and is not reported.

Five consequences MUST be honored rather than inferred:

- **`host` and `port` are the only environment-overridable settings, and each tier declares exactly two variables for them** (§6). An implementation MUST NOT introduce `APP_NAME`, `APP_VERSION`, `HEALTH_PATH` or `HEALTH_STATUS` variables — they are not part of the design and nothing reads them.
- **`name` and `version` come from the tier's identity source, never from the environment.** They describe the build rather than the deployment, so a deployment cannot rename or re-version a running application. This is what makes the `version` member trustworthy evidence of which build is live.
- **A validated declaration can never move the resource or change the answer, but it is genuinely read.** Both halves are requirements, and the second is the one an implementation is most likely to drop. Refusing to read the declaration at all would satisfy every negative expectation — the path would still be `/health`, the status would still be `UP` — while quietly making the configuration file decorative, which is the defect this clause exists to prevent. §0.5.2(e) of the plan governing this feature requires every field value to resolve from a declared source rather than from a literal written inline at its point of use, and a value that is never read does not resolve from anywhere.
- **Each tier MUST therefore publish the provenance of every value it resolved**, as one of exactly three labels: `environment`, `file` or `fallback`. This is what makes the requirement above testable rather than aspirational: a suite can assert that a valid declaration resolved with provenance `file` and a refused one with provenance `fallback`, and neither assertion can be satisfied by an implementation that stopped reading. Level 1 exposes `configSources`, Level 2 `get_config_sources()`, Level 3 `configurationSources()`. Level 3 reports five values; Levels 1 and 2 report six, the sixth being `status`.
- **A configured port of `0` is refused at every tier.** This is the one usability rule worth stating explicitly, because `0` is not obviously invalid: as a *bind-time argument* it means "any free port" and is both meaningful and used — every test listener in this composition takes one that way — but as a *configured value* it is refused, because a health endpoint on a port nobody can predict cannot be probed. A `0` arriving from either the environment or the serving source therefore falls through to the next link, exactly as a non-numeric, negative or out-of-range value does. The three tiers refuse it identically; an implementation that accepted it at one tier would break the cross-tier symmetry this contract exists to guarantee.

> The compiled-in literal fallback is **required, not optional**, and it is the last link of every chain that has one. It guarantees that the endpoint still serves a valid contract when a configuration source is absent from a container image — which is precisely the failure mode a health endpoint has to survive. An endpoint that cannot answer because its own configuration is missing is worse than no endpoint at all, because it turns a running application into one that reports itself unhealthy. Each tier's literals MUST be identical to the values its configuration source declares, so that a missing file degrades to identical behavior rather than merely to some behavior.

A fallback is nonetheless **never silent**. Because a served-from-fallback response is indistinguishable from a correctly configured one — same `200`, same four members, same green container health check — each tier records *why* a declared source failed to supply its values and its entry point reports that once at start-up. §12.5 specifies that diagnostic.

No handler hard-codes a value inline at its point of use. Each setting is resolved once, through its own chain above, and then referenced. Resolution happens **once at start-up**, never per request (§9.1).

**Where resolution happens, per tier.** Level 2 and Level 3 each resolve everything in one place: the payload module at Level 2, and the server class at Level 3. Both read their declared source exactly once, hold the result, and use it for two purposes — resolving every setting through its own chain, and recording any frozen-value declaration they had to refuse. Level 1 deliberately splits it in two, and the split is worth knowing before reading the code:

- `health.js` resolves every served value at module load and exposes the result as a frozen `config` object — applying the environment layer to `host` and `port` only, resolving `name` and `version` from the identity manifest with no environment layer at all, and resolving `path` and `status` from the serving document under the validated discipline above. That object is what the payload builder serves from and what the router routes on, so what the endpoint *says* and *where it says it* are settled there and nowhere else.
- `server.js` re-applies `HOST` and `PORT` over that resolved configuration at the moment it binds, so the bind target is decided at bind time rather than inherited from module-load time.

The split exists because the two concerns have different lifetimes: what the endpoint *says* is fixed for the life of the process, whereas what it *binds to* is a property of this particular launch. Both sites read the same two variable names with the same precedence, so the effective behavior is the single chain documented above; there is no second, competing source.

This document is the single normative statement of what those values are; each tier's identity and serving sources are the single runtime source it resolves them from.

### 7.1.1 Two values are frozen, and are validated rather than trusted

The **resource path `/health`** and the **`status` literal `UP`** are contract constants, not settings. Each implementation MUST compile both in as named constants, and MUST serve a value equal to those constants under every possible configuration.

That requirement is discharged by **validated resolution**, not by ignoring the declaration. A tier's serving configuration file — `config/health.json` at Levels 1 and 2, `application.properties` at Level 3 — declares the keys it has, because an operator reading that file should be able to see the whole shape of what is served in one place, and because a value the running process never reads is not configuration. So the declaration is read, and then it is checked:

- A declared value **equal to the frozen constant after trimming surrounding whitespace is adopted**, and the resolution reports its provenance as `file`. Nothing observable changes, and nothing is reported to the operator — but the value the endpoint serves did come from the declared source, which is the property §7.1 requires and a suite can assert.
- A declared value that **differs in any way is refused**: the compiled-in constant is served, the resolution reports provenance `fallback`, the disagreement is recorded in the tier's frozen-value audit, and the entry point MUST print one warning line naming the key, the value that was configured and the value served instead (§12.5). Refusing silently is not sufficient — an operator who edited the file is entitled to learn the edit had no effect, rather than discovering it later as a gap in monitoring.
- An **absent key** is not an error and is not reported: the compiled-in constant is served with provenance `fallback`, exactly as an absent file would produce.
- **No environment variable exists for either value at any tier, and none may be added.** The validated link is the file link only; the environment cannot reach these two values at all.

Level 3's `status` is the single deliberate exception, and it is an exception to the *source*, never to the outcome: `application.properties` declares no status key by design (§7.3), so there is nothing for Level 3 to resolve `status` from and the compiled-in constant is the whole of its resolution. A `health.status` key added there by hand is nevertheless **audited exactly as `health.path` is** — a value other than `UP` is refused and reported at start-up — so a hand-edit cannot silently take effect there either.

The two disciplines produce identical observable behaviour and differ only in what a provenance accessor reports, which is why the served contract is uniform across the composition while the resolution tables are not.

The reason both are frozen rather than merely defaulted is that they are load-bearing far outside the process that reads them: every conformance assertion in the three test suites is written against the literals `/health` and `UP` today, and every container `HEALTHCHECK` instruction of §11 and every workflow assertion of §12.1 MUST be written against them once those exist, as will any orchestrator liveness probe pointed at this composition. A configurable path would silently move the endpoint away from where all of those look for it, and a configurable status would let a deployment report a value its own behavior does not support — in both cases producing a response that is still syntactically valid, which is the hardest class of failure to notice. §5.4 states the path rule normatively and §7.5 does the same for `status`.

### 7.2 Per-tier configuration sources

| Tier | Identity source (`name`, `version`) | Serving source (host and port, trusted; path and status, validated per §7.1.1) | Dotenv template | Runtime-version pin |
| --- | --- | --- | --- | --- |
| L1 | `package.json` | `config/health.json` — declares `host`, `port`, `path` and `status`; all four are read | `.env.example` | `.nvmrc` (`24.18.0`) |
| L2 | `pyproject.toml`, read through the standard-library `tomllib` module | `config/health.json` — declares `host`, `port`, `path` and `status`; all four are read | `.env.example` | `.python-version` (`3.14.6`) |
| L3 | `application.properties`, read from the classpath, with literal fallbacks | `application.properties` — declares `health.host`, `health.port` and `health.path`; all three are read. It declares **no** status key at all | **none** | **none** |

Every source in that table sits behind the compiled-in fallback required by §7.1, so a missing file degrades nothing observable — the served payload is byte-identical, and only the reported provenance changes from `file` to `fallback`.

The status row differs between tiers for one concrete reason rather than by accident. Levels 1 and 2 read serving parameters from a JSON document their runtimes parse natively, so carrying the literal there costs nothing, keeps every served value in one file, and lets the validated read cover it like the rest. Level 3's `application.properties` is restricted to exactly five keys — `app.name`, `app.version`, `health.port`, `health.host`, `health.path` — and a `health.status` key is **prohibited** there: making the frozen invariant look like an ordinary setting in the one tier whose configuration format invites hand-editing would be a worse defect than the asymmetry. In all three cases the served value is `UP` and no declaration can change it, which is what §2 and §3 mean by calling it frozen.

All paths in that table are relative to the tier's own repository root. Each tier's **core source is flat**: every implementation, test, identity-manifest and container file belongs directly at its repository root, exactly where `index.js`, `app.py` and `User.java` already lived. The feature introduces only three directories anywhere in the composition — `config/` at Levels 1 and 2, `docs/` at the apex alone (this file), and `.github/workflows/` at each tier once those workflows are added. There is no `src/` directory, no `tests/` directory and no package hierarchy at any tier; `User.java` in particular stays in the default package at its original path, so the Level 3 gitlink keeps resolving to the same artifact. An implementer who introduces a nested layout breaks the default test discovery this feature relies on — `node --test` finding `index.test.js`, `python -m unittest` finding `test_app.py`, and `javac *.java` compiling the Level 3 sources in one command.

Read the two source columns together with the per-setting chains in §7.1: the identity source supplies `name` and `version`, and the serving source supplies `host` and `port` under the trusted discipline and `path` and `status` under the validated one. Every declaration is read; what differs is whether a value is adopted as given or adopted only on an exact match with the frozen constant (§7.1.1, §7.5). Where a tier's source omits a key, the compiled-in literal for that setting is the whole of its resolution.

### 7.3 The Level 3 asymmetry is deliberate and MUST NOT be "corrected"

> Level 3 has no `.env.example` and no runtime-version dotfile. Java has no dotenv convention without a third-party library, and adding one would breach the composition's zero-dependency constraint, so `HealthServer` reads `HEALTH_PORT` and `HEALTH_HOST` through `System.getenv` with `application.properties` supplying the defaults. Both overrides are documented in comments inside that properties file, and the Level 3 README MUST document them as well. The Level 3 runtime pin has no dotfile to live in either; it is to be carried by the workflow's `java-version` input and the Dockerfile tag instead.

An engineer who notices that Level 3 is "missing" two files that Levels 1 and 2 have is seeing an intentional consequence of the zero-dependency rule, not an oversight. Adding a dotenv template or a version dotfile at Level 3 would either add a dependency or add a file nothing reads. Leave it as it is.

Level 3 carries one further deliberate asymmetry, in its serving source rather than in its file set: **`application.properties` declares no status key.** It declares `app.name`, `app.version`, `health.port`, `health.host` and `health.path`, and nothing else; `HealthServer` holds `UP` as a compiled-in constant, and its resolution table has no status row at all. Levels 1 and 2 *do* carry a `status` member in `config/health.json`, and they read it — under the validated discipline of §7.1.1, so a value equal to `UP` is adopted with provenance `file` and any other value is refused, reported and replaced by the constant. Adding a `health.status` key at Level 3 to "match" the other two would widen the surface for no gain: it would make a frozen invariant look like an ordinary setting in the one tier whose configuration format invites hand-editing. A key added there by hand is nevertheless audited exactly as `health.path` is, so a value other than `UP` is refused and reported at start-up rather than taking effect. Leave the file as it is.

### 7.4 The Level 1 CommonJS constraint

The apex `package.json` **MUST NOT declare the ES-module `type` field.** Node resolves `index.js` as CommonJS today, and the `require.main === module` guard that keeps the pre-existing program's behavior intact (§12.3) depends on that resolution. Declaring the module type would silently change it, and the failure would surface as a behavioral regression rather than as an error at the point of the change. The omission is a review checkpoint, not an accident — see [`../package.json`](../package.json).

### 7.5 `status` is a protocol constant and MUST NOT be configurable

The trusted resolution of §7.1 governs the serving parameters and the identity members. It does **not** govern `status`, which is validated instead, and the distinction is normative:

- **The literal `UP` MUST be a compiled-in constant in each tier's own code** — `STATUS_UP` at all three tiers. Whatever any configuration source declares, the value the endpoint emits is equal to that constant on every code path.
- **No environment variable, no configuration file and no command-line argument may CHANGE it.** An endpoint whose liveness answer can be set from outside the process is not a liveness answer: it lets a deployment claim to be healthy, or misreport itself as something else, without the process's actual state having any bearing on the payload. The value is a term of the wire protocol, in the same category as the `200` status code and the `Content-Type` header, and none of those are configurable either.
- **"Not configurable" is a statement about the outcome, not about whether the declaration is read.** Levels 1 and 2 read the `status` member of `config/health.json` and adopt it only when it equals the constant exactly, reporting provenance `file` when it does and `fallback` when it does not (§7.1.1). The set of values a deployment can cause to be served therefore has exactly one element, which is what "not configurable" means here. An implementation that refused to read the member at all would produce the same served value and would fail the provenance requirement of §7.1.
- `status` is frozen precisely because this endpoint performs **no dependency checks** (§9). There is no observation for a configured value to override, so a configurable status could only ever be a lie.

Each tier's `config/health.json` declares a `status` member deliberately: it documents, in the same place as the other serving values, which liveness literal that tier's contract carries, and it is what a human or a schemaless tool reads first. To keep the declaration from drifting away from the constant that is emitted, each tier's test suite asserts **both directions** — that a declaration equal to the constant is adopted and reports provenance `file`, and that a declaration which differs is refused, reported, and cannot change the payload. Asserting only the second direction would pass for an implementation that had stopped reading the file, which is why both are required. Level 3 declares no such member at all, because `application.properties` was never given one (§7.3).

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

**The Level 3 executor MUST be bounded, in both dimensions.** A fixed thread pool built on an unbounded queue is the default in that runtime and is the wrong default here: under a burst it accepts work indefinitely, so the failure mode is memory growth and unboundedly rising latency rather than refusal — and a health endpoint that answers slowly enough for a probe to time out has failed while reporting nothing. Level 3 therefore uses a fixed pool over a **bounded** queue together with an explicit **rejection policy**, so that saturation has a defined behaviour: an exchange that cannot be queued is handled on the accepting thread instead, which applies back-pressure to the listener rather than accumulating work no one is waiting for any more. While that exchange is being answered no further connection is accepted, so the queue drains before more work is admitted — no request is dropped and none is queued without bound, and overload degrades into slower service rather than into silent loss.

Leaving the policy at its default is the specific mistake to avoid, not merely a missed refinement: the runtime's default aborts by throwing inside its own dispatcher, so the caller sees a connection torn down with no status line and no log entry — indistinguishable from a crash. One case is deliberately exempt from running inline: a pool that is **already shutting down**, where the rejected work belongs to a listener that is going away and running it would answer on behalf of a process that is stopping. That exchange is not run, so no status line is written and the connection ends as the listener closes. That is consistent with the prohibition of §9.3.1 clause 2 — nothing invents a code — but it is not the fault path of §9.3.1 and MUST NOT be reported as one: no fault has occurred, so no diagnostic is recorded for it.

Freshness is measured, not assumed, and it is measured **without any delay between the calls** — a delay would reduce the check to "time passed". Immediately consecutive builder calls, and immediately consecutive responses over a real socket, return different `timestamp` values while `name`, `version` and `status` stay identical. Bursts drawn inside a single millisecond tick return values that are all distinct and strictly increasing, and a companion assertion bounds how far allocation may sit ahead of the wall clock, so the correction is proven finite rather than merely asserted to be. Reverting an implementation to a bare clock read fails those checks, which is how the guarantee is known to be tested rather than assumed.

### 9.3 Why the handler does nothing else

Established operational practice for health endpoints is that the probe stays lightweight and performs no heavy work, because a probe that does real work becomes a source of the very load it is meant to report on, and its timeouts start reporting the monitor's problems rather than the application's. This contract therefore forbids per-request file I/O, per-request network calls and dependency interrogation of any kind inside the handler. Reading an already-loaded value and reading the clock is the entire permitted workload.

That restriction has a second consequence worth stating outright: because the handler performs no I/O, it has no *expected* failure path, so **no request can produce a `5xx` — routed or not**. The three status codes of §5.1 are the whole of the contract's vocabulary, and an implementation that adds a server-error branch anywhere is either doing work it should not be doing or reporting a fault it cannot have.

"No expected failure path" is not the same as "no possible failure", though, and the difference is what the rest of this section is about. A defect in the handler — the kind a future edit introduces, not one the current code can reach — must not be resolved by inventing a status. Three responses to it are specifically **forbidden**:

- **A `404` MUST NOT be returned for an internal fault.** A `404` is a statement about the *client's* request target, so returning one after an internal failure blames the caller for the server's defect. A poller records a clean, contract-shaped response, a human hunts for a typo in a URL that was correct, and the real fault leaves no trace anywhere. Misreporting is worse than not reporting, because it actively misdirects the investigation.
- **A `5xx` MUST NOT be returned either.** It reads like the honest answer, and it is the one an implementer reaches for, but it puts a status on the wire that this contract does not define and no consumer of it is specified to interpret — so a probe cannot distinguish "the endpoint has a defect" from "the endpoint is speaking a vocabulary I do not know". A closed connection is unambiguous; an undocumented status code is not.
- **The failure MUST NOT be swallowed silently.** Closing the connection is the honest transport-level outcome when there is no defined response to send, but on its own it is indistinguishable from a network blip, so it MUST be paired with the server-side diagnostic of §12.5.

#### 9.3.1 The internal-fault policy, canonical for all three tiers

The policy is uniform across the tiers and is stated here once; each implementation carries the same wording:

1. **Report the fault server-side**, by stable category, exactly as §12.5 specifies — once per distinct category and bounded.
2. **Write no status line at all.** This is the operative clause. The contract's status vocabulary is exactly `200`, `404` and `405` (§5.1), and a fault must not add a fourth code to it. In particular a fault must never be answered `404`, which would blame the caller for the server's defect, and never `2xx`, which would claim a health the process cannot support — and it must equally not be answered `5xx`, because inventing a status that no routed request can elicit puts a code on the wire that no consumer of this contract is specified to interpret.
3. **Close the exchange instead**, and complete it exactly once:
   - When **nothing has been sent yet**, the connection is closed with no response. All three tiers behave identically here.
   - When a **response is already in flight** and its status line can no longer be retracted, the response is ended and the connection closed. No second status may be written.
4. **Nothing about the fault is reflected to the client** — no exception type, no message, no stack trace, in any of those outcomes.

A caller therefore observes a closed connection, which is an honest transport-level outcome for a request that has no defined response, and the server-side diagnostic of §12.5 is what makes the fault visible to an operator. Closing without that diagnostic would be indistinguishable from a network blip, which is why clause 1 is not optional.

**Nothing in this contract, anywhere, produces a `5xx`.** That is a stronger and simpler statement than permitting one on the fault path, and it is deliberately the one made here: a probe, a container health check or a workflow assertion written against this contract may treat any `5xx` from any of the three endpoints as a defect without qualification. §12.5 specifies the accompanying diagnostic, including the bound on how much of it may be emitted.

**One catching rule follows from clause 2 and is easy to get wrong.** The fault handler catches ordinary exceptions only. A tier MUST NOT catch the errors its runtime reserves for conditions the process cannot continue past — a Java `Error` such as `OutOfMemoryError` or `StackOverflowError`, and the equivalent in the other runtimes — because swallowing one of those converts an unrecoverable process state into a silently closed connection and lets a dying process keep answering. Those propagate.

### 9.4 Formatting the timestamp in each language

The mandated form is RFC 3339 UTC with a `Z` suffix and exactly three fractional digits. `Date#toISOString` emits precisely that form natively — verified, producing values such as `2026-07-28T15:03:08.665Z` and matching the contract regex — so the JavaScript tier needs no formatting helper beyond that one call. The Python and Java tiers format explicitly to match it. Implementations MUST NOT emit a numeric offset such as `+00:00` in place of `Z`, MUST NOT emit microsecond precision, and MUST NOT drop the fractional part when it happens to be zero.

The whole-second case is the trap in that last clause: a formatter that trims insignificant zeros renders a whole second as `…:20Z` rather than `…:20.000Z` and silently fails the regex, and it does so only for one millisecond in every thousand — so it will pass a naive test run and fail in production. Java's `Instant#toString` behaves exactly that way and **MUST NOT** be used: formatting epoch millisecond `1769000000000` through it yields `2026-01-21T12:53:20Z`, which fails the contract regex, while the same instant one millisecond later yields a conformant `…:20.001Z`.

What the contract requires of a formatter is therefore stated as a property rather than as one library call: it **MUST** emit exactly three fractional digits for every instant including a whole second, **MUST** emit the `Z` suffix rather than a numeric offset, **MUST** render at UTC, and **MUST NOT** vary with the ambient locale. Any mechanism with those four properties conforms. The two non-JavaScript tiers reach them differently and both are correct — Level 2 composes a seconds-precision `strftime` pattern with an explicitly zero-padded millisecond field, and Level 3 uses `DateTimeFormatterBuilder().appendInstant(3)`, which emits three digits unconditionally and is locale-independent by construction; formatting the same whole-second instant through it returns `2026-01-21T12:53:20.000Z` under a `tr-TR` locale as well as the default. A hand-written `yyyy-MM-dd'T'HH:mm:ss.SSS'Z'` pattern also satisfies the four properties, but it is one way rather than the required way, and it carries the extra obligation of pinning the zone and the locale on the formatter itself.

The prohibited forms in each language are worth naming, because each is the shortest thing to write: Java's `Instant#toString` drops the fraction on a whole second, and Python's `datetime.isoformat()` emits `2026-01-21T12:53:20+00:00` — a numeric offset, and six fractional digits when the microsecond component is non-zero. Both fail the regex.

Because the allocator of §9.2 separates *choosing* the instant from *rendering* it, each tier exposes the renderer as a callable taking an epoch millisecond value — `formatTimestamp` at Levels 1 and 3, `format_timestamp` at Level 2 — so a suite asserts `.000` deterministically by formatting a chosen whole-second instant, rather than waiting for the clock to land on one and hoping the run is not flaky.

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

Four further assertions are **not** per-response but are required all the same, because §7.1 places requirements on resolution that no response can reveal. Each tier's suite MUST carry them:

- **A valid declaration is adopted, and says so.** Given a serving source declaring values that differ from the compiled-in literals, every resolved value equals the declared one and its reported provenance is `file`. This is the load-bearing assertion of the group: without it, every assertion below would pass equally for an implementation that had stopped reading its configuration altogether, and the configuration surface would be decorative. The declared values used MUST differ from the literals, or the assertion proves nothing.
- **A refused frozen declaration is refused, recorded, and does not spread.** Given a source declaring a path or status the contract forbids, the frozen literal is served with provenance `fallback`, the disagreement appears in the frozen-value audit, and the source's *other* values are still adopted with provenance `file` — so refusal is proven targeted rather than a wholesale discard.
- **An absent source degrades to the literals.** Every value resolves from the compiled-in literal with provenance `fallback`, the degradation reason is recorded from the closed vocabulary of §12.5, and the endpoint still serves the frozen path. Levels 1 and 2 assert this in a temporary directory created outside the repository and removed afterwards, holding a copy of the tier's modules and no configuration; Level 3 asserts it by loading a second, independent copy of its server class through a class loader whose classpath deliberately carries no properties file. The first two bullets are asserted the same way, with a configuration file present in that directory or on that classpath.
- **Precedence is asserted at every link, deterministically and in isolation.** An environment override outranks a declared value; an unset, blank or unusable override falls through to it; the identity members are unaffected by any override; and a configured port of `0` is refused from either link (§6). The *mechanism* is necessarily per-runtime and each tier MUST use the one its runtime allows: Levels 1 and 2 resolve at import time from a mutable process environment, so they assert each case in a **child process launched with a controlled environment and a purpose-built configuration directory**, which isolates the case completely. Level 3 cannot do that — the JVM permits no mutation of its own environment, and launching a second JVM would assert the launcher rather than the resolver — so it exposes a **resolver seam taking the declared document and the two override values as explicit arguments**, and asserts each case as a pure function call.

### 12.3 What is preserved, measured rather than assumed

This endpoint is **purely additive**. Each tier keeps its original one-shot program and its original invocation, and the health server runs from a **separate entry point**: `node server.js` at Level 1, `python server.py` at Level 2 and `java -cp . HealthServer` at Level 3. Running the original program still terminates immediately; nothing about it becomes long-lived.

The preservation of Level 1 is enforced by a fingerprint rather than by inspection. `node index.js` still exits `0`, still writes five lines and fifteen bytes to standard output, still writes nothing to standard error, and the md5 of that standard output is still:

```text
b07373a80ad21069e41be538e6506d00
```

That digest means exactly one thing — the md5 of the standard output of `node index.js` — and it is asserted by the Level 1 test suite today and MUST be asserted by the apex workflow on every run, as a permanent regression gate. At Level 2 the original program still prints `Hello Lakshya`, and at Level 3 it still prints `Test`; both are asserted the same way by their own tiers' suites and MUST be asserted by their own tiers' workflows.

Two further preservation properties are asserted alongside the digest, because both were newly established by this feature and both are easy to break silently: importing `index.js` writes **nothing** to either stream, where before this feature a bare `require` printed `12` five times; and `require('./index.js')` exposes exactly `add`, where before it exposed nothing at all.

### 12.4 Process lifecycle

Each server is the first long-lived process its tier has ever had, so each one arranges an orderly close of the listener on `SIGTERM` and `SIGINT`: Levels 1 and 2 install explicit signal handlers, and Level 3 registers a JVM shutdown hook, which is that runtime's equivalent and covers the same two signals. A container stop is therefore not a hard kill, and a teardown leaves no orphaned port binding behind to break the next run.

How far each tier's suite goes in asserting that differs, and the difference is worth stating rather than glossing: the Level 1 and Level 2 suites deliver a real `SIGTERM` to a real server and then require the port it held to be free again, while the Level 3 suite asserts the orderly stop through the listener's own stop path and leaves signal delivery to the runtime. Every workflow MUST tear down its background servers and containers regardless, so that re-running it is idempotent.

Whether a tier prints anything as it stops is deliberately left to the tier, and the three differ: Level 1 writes one orderly-shutdown line, while Levels 2 and 3 write nothing, keeping the single start-up line as the process's entire output for its whole lifetime. Neither choice is more conformant than the other, because **no consumer of this contract may parse a log line** — liveness is read from the endpoint and from the probe's exit code, never from standard output. The one requirement in this area is the one §13 states: nothing is logged per request, at any tier.

A **requested** shutdown is a normal, successful termination at every tier — a container stop and a CI teardown are both routine, and treating either as a failure would make every pipeline teardown look broken. How that success is *reported* differs by runtime, and the difference is measured rather than assumed:

- **Levels 1 and 2 exit `0`.** Both install explicit handlers, close the listener and then return from their entry point normally, so the process's own exit status is what a caller reads. Measured at both tiers, for `SIGTERM` and for `SIGINT`: status `0`.
- **Level 3 terminates by the signal, and that is the correct report.** A JVM shutdown hook runs *while* the virtual machine is being torn down by the signal; it does not convert the termination into an ordinary return, so a shell or an orchestrator reads `128 + signal` — measured as `143` for `SIGTERM` and `130` for `SIGINT`, with the listener closed and the port released in both cases. This is the conventional encoding of "terminated by SIGTERM", which container runtimes and process supervisors already treat as a normal stop; forcing a `0` from inside the hook would require halting the VM outright and would discard the information that the process stopped because it was asked to. **A consumer of this contract MUST therefore treat `0` and `128 + signal` alike as a successful stop**, and MUST NOT assert `0` specifically for a signalled shutdown at any tier.

One distinction is worth stating explicitly, because §11.1 reserves exit code `2` and a reader comparing the two sections would otherwise see a conflict. **That reservation governs probe commands, not server processes.** A `HEALTHCHECK` command's exit code is interpreted by the container runtime, where `2` is reserved, so every probe specified by this contract returns only `0` or `1`. Level 3's probe exists today — `HealthServer --check` returns exactly `0` or `1`, verified in both directions against a live and a dead listener — and the Level 1 and Level 2 probes are the inline commands §11 specifies, which MUST observe the same restriction when those container definitions are written. A server process's exit status is interpreted by an operator, an orchestrator or a shell, and it is free to distinguish more failure modes:

| Tier | Server process exit statuses | Probe exit statuses |
| --- | --- | --- |
| L1 | `0` requested shutdown · `1` start-up failure | `0` / `1` |
| L2 | `0` requested shutdown · `1` bind failure · `2` the shutdown itself failed | `0` / `1` |
| L3 | `128 + signal` requested shutdown, i.e. `143` for `SIGTERM` and `130` for `SIGINT` · `1` start-up failure | `0` / `1` |

Level 2's third status exists because a shutdown that cannot complete is materially different from one that completes normally: the port may not have been released, which is precisely the condition that breaks the next CI run, and a caller that saw `0` would have no way to know.

The wider set can never reach a `HEALTHCHECK`, and it is worth being exact about why, because Level 3 is the case that looks like an exception. Levels 1 and 2 are specified to probe with a separate inline command (§11), so their entry points would never be invoked as probes at all. Level 3 *does* share one artifact between both roles — `HealthServer` serves with no arguments and probes with `--check` — but the two modes have separate exit paths, and the `--check` path returns only `0` or `1`. Sharing the artifact does not share the exit vocabulary.

### 12.5 The three diagnostics, and the silence around them

The endpoint's normal operation is silent past its single start-up line, and that silence is a requirement (§13): a resource polled every few seconds would otherwise become the loudest thing in the log, and a log nobody reads is a log that hides the one line that mattered. But silence has a failure mode of its own — a misconfiguration that produces no output is indistinguishable from correctness — so exactly three diagnostics are defined, and no other output is permitted. All three are **bounded**, all three are **sanitized**, and none is per-request.

Two of them fire at start-up and one only on a defect, so a correctly configured process writes **nothing** to `stderr` for its whole lifetime. Where two of them fire together their order is fixed: the degraded-source line comes first, because a source that never arrived explains everything after it; the rejected-declaration lines follow; and the start-up announcement — the only line on `stdout` — comes last, so a reader meets the caveats before the announcement they qualify.

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

**2. The rejected-declaration line, at start-up.** A configuration source that declares a *frozen* value the contract does not permit has that declaration refused (§7.1.1), and refusing it silently would be only half of the right behaviour: a deployment that edited the document expecting an effect would get no answer, and would discover the truth much later as a gap in monitoring rather than as a line in the start-up log. The entry point therefore writes **one line to `stderr` per rejected declaration**, naming the key, the value that was refused, the value served instead, and the file to edit. The three tiers' actual output, for a document declaring `path` as `/nope` and `status` as `DOWN`:

```text
L1  health server ignoring configured path "/nope": path is frozen at "/health" by the /health contract and is not a deployment setting. Remove the value or restore it to "/health" in config/health.json.
L2  server.py: ignoring configured path "/nope": path is frozen at "/health" by the /health contract and is not a deployment setting. Remove the value or restore it to "/health" in config/health.json.
L3  health server ignoring configured health.path "/nope": health.path is frozen at "/health" by the /health contract and is not a deployment setting. Remove the value or restore it to "/health" in application.properties.
```

The content requirements are binding at every tier:

- **The line count is bounded by construction.** There are two frozen keys, so there can never be more than two of these lines however large or hostile the document is. A conflict-free deployment — including every tier's shipped configuration, which restates both frozen values deliberately (§7.5) — emits **none**, so this cannot add noise to an ordinary start-up or to a CI log.
- **The refused value is rendered, and rendered safely.** Unlike the degraded-source line, this one *does* quote document content, because the value is the actionable half of the message: an operator has to recognise it in the file. It is therefore rendered under two limits. Control characters are removed rather than escaped, so one rejected declaration is always exactly one physical line and a value containing a line break cannot fabricate an entry — including one impersonating the start-up announcement. And the rendering is **length-bounded**, because a document may declare a value of any size and an unbounded rendering would put that size on the error stream at every start-up; a value that is cut is marked as cut so a reader can tell a truncated rendering from a complete one.
- **A stricter form is permitted.** Level 3 validates the value against an allowlist and, when it fails, replaces it wholesale with the same `<unprintable>` token it uses for an unrenderable host, rather than rendering the printable remains. That is a stronger version of the same rule and conformant; what is *not* conformant is rendering the value unbounded or unflattened.
- **The remedy MUST name the declaring file** — `config/health.json` at Levels 1 and 2, `application.properties` at Level 3. That is a fixed name the tier already declares, not a filesystem path interpolated from an error message, so it discloses nothing a reader of the repository does not already know, and without it the warning is a riddle: something is wrong, but not where.
- **It is emitted by the entry point, never by the payload module**, for the same reason the degraded-source line is: the module records the audit as data and stays byte-silent on import.

**3. The handler-failure line, on an internal defect.** When the handler fails in a way the contract has no response for (§9.3), the failure is reported and the connection completed without a fabricated status:

```text
L1  health request handler failed: TypeError; connection closed without a response
L1  health request handler failed: TypeError; response already in flight, connection closed
L2  server.py: health request handler failed: ZeroDivisionError; connection closed without a response
L3  health handler failed unexpectedly: NullPointerException; connection closed without a response
```

The wording differs slightly at Level 3 and the category is naturally each language's own type name. Neither is a defect to be harmonized: what this contract fixes is the **content** of the line — one stable category, the consequence, and nothing else — not its exact prose.

The **consequence** clause is the one part that carries meaning beyond prose, and it reports what actually happened to the response. There are exactly two outcomes, because §9.3.1 permits exactly two: `; connection closed without a response` when nothing had reached the wire, which is the normal case at all three tiers, and `; response already in flight, connection closed` when a status line had already gone out and could no longer be retracted. **No outcome names a status code**, because the fault path writes none. A tier whose runtime cannot distinguish the two cases reports the one it can establish; Level 2's handler, for instance, has no second response available to it — `send_response` cannot be issued twice on one exchange — so it always closes the connection and says so.

- Reporting is **latched per distinct failure category and bounded** — a recurring defect is announced once, and a bounded number of distinct categories ever is. Without both limits a single defect under poll load would emit a line per request.
- The category is a **stable identifier only**: an error code, else an exception class name. The exception's **message MUST NOT be rendered**, because it is the part of an error that routinely interpolates untrusted or sensitive material, and a health endpoint's log is the artifact most likely to be shipped to a central collector. A stack trace MUST NOT be emitted either.
- A category is **sanitized to identifier characters** before rendering. Exception names are writable and class names are caller-chosen in the general case, so a value containing a newline could otherwise forge a second log line — including one impersonating the start-up announcement above.
- **An expected peer disconnect is not a defect and MUST stay silent.** A probe whose timeout expired, a balancer that already got what it needed, an interrupted `curl` — each surfaces as a write failure and none is this process's fault. Implementations classify the transport-level conditions of their runtime (`EPIPE`, `ECONNRESET`, `ECONNABORTED`, `ETIMEDOUT` and the equivalent stream errors in JavaScript; `OSError` and its subclasses in Python) as quiet, and report only what remains.
- **Nothing is reflected to the client.** The caller learns that the connection closed; it never receives exception detail, and it never receives a status the process cannot honestly claim.

The same discipline governs the **bind-failure** diagnostics an entry point emits when it cannot start: a configuration-derived host is validated against an allowlist and replaced wholesale with `<unprintable>` if it fails, rather than being escaped piecemeal, and an unrecognised failure is reported by stable category rather than by the platform's locale-dependent prose. All three tiers use the same `<unprintable>` token, so one search spans the composition's logs.

## 13. Deliberately not provided

A normative contract is as much about what an implementation must not add as about what it must do. The following are out of scope for this feature, and an implementation that adds any of them is non-conformant:

- **No other endpoint.** There is no `/ready`, no `/live`, no `/metrics`, no `/info` and no root resource. `/health` is the only path that ever returns a body other than an error, and the only one a `GET` or `HEAD` answers with anything but `404`. The one nuance is the method-before-path ordering of §5.4: an unsupported method is refused with `405` wherever it is aimed, so an unknown path answers `405` rather than `404` when the verb is also wrong. That is the ordering, not a second endpoint.
- **No fifth member, now or later.** The body is exactly the four members in §3. In particular none of the health-check draft's other optional members is emitted: no `checks` object, no `uptime`, no `pid`, no `hostname`, no `releaseId`, no `description`. There is no extension point, because an extension point in a frozen contract is a drift point.
- **No dependency interrogation.** `status` reports process liveness only. The endpoint never reports on anything downstream of itself, because there is nothing downstream of it.
- **No authentication, no transport-layer encryption termination, no rate limiting, no CORS handling and no response compression.** The endpoint is plain HTTP on the loopback interface for probes and on the bound address for orchestrators.
- **No logging framework**, and **no per-request logging** — no access log, no timing line, nothing emitted on the success path. Each entry point logs its bound address once at start-up. The only output beyond that is the three bounded, sanitized diagnostics specified in §12.5, which fire on a degraded configuration source, on a refused frozen declaration, and on an internal handler defect; none is per-request, and each is latched, one-shot or bounded by construction precisely so that it cannot become one. Verified by measurement: with a degraded source *and* two refused declarations, a tier writes its three `stderr` lines and one `stdout` line at start-up and then emits **not one further byte on either stream** across the requests that follow.
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
