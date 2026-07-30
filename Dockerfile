# Level 1 (apex) container image — parent_repo_10_LOC, the JavaScript tier.
#
# The image exists for the HEALTHCHECK at the end of this file: a container is the
# only place "this application is up" becomes a state the runtime tracks. Nothing
# is compiled and nothing is installed, so this is a single stage.
#
# Two invariants are load-bearing:
#   * Nothing is installed. Zero third-party dependencies is a property of the
#     whole composition; never add npm/yarn/pnpm/apk here. That also rules out
#     curl for the probe — it is absent from this base, and Node is not.
#   * package.json and config/health.json MUST reach the image. health.js reads
#     both at module load and falls back to compiled-in literals rather than
#     failing, so their absence leaves the endpoint answering 200 with an identity
#     this repository never declared. Both are copied by name below so that losing
#     one fails the build instead.
#
# See .dockerignore for the build-context policy, docs/health-endpoint.md §11 for
# the normative probe design, and .env.example for the PORT and HOST overrides.

# Pinned by tag AND by digest. node:24-alpine is the Node 24.x Active LTS line and
# ships v24.18.0 — the version .nvmrc pins. The digest is the tag's multi-platform
# OCI image index: it does not make one byte-for-byte image universal (the index
# selects a platform-specific child manifest) but it does fix which image a given
# commit builds from, per platform.
#
# The trade, stated plainly: a frozen base does not receive the Alpine and Node
# patches its tag does. This file chooses reproducibility because the digest is a
# declared value in the project specification, and it was verified against the live
# registry as the current head of the tag. A fixable HIGH or CRITICAL finding
# against the BUILT image is a REFRESH instruction, never a reason to un-pin — that
# would trade a known dated exposure for an unknown one. To refresh: pull the tag,
# read `docker image inspect --format '{{index .RepoDigests 0}}' node:24-alpine`,
# replace the digest here AND in the base.digest label, move .nvmrc and the engines
# range with it if the Node patch changed, update the specification, then rebuild
# and re-assert the contract. Never guess, shorten or hand-edit a digest.
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

# Standard OCI annotations, so a host can be asked what this image is without
# reading this file. No name or version label: package.json is their single
# declared source and the payload already serves them, so a second copy would be
# free to drift. base.digest MUST equal the digest in the FROM line — they are
# refreshed together. Nothing secret appears in any label.
LABEL org.opencontainers.image.title="parent_repo_10_LOC" \
      org.opencontainers.image.description="JavaScript /health endpoint serving the frozen name/version/timestamp/status contract on port 3000, on the Node standard library alone" \
      org.opencontainers.image.base.name="node:24-alpine" \
      org.opencontainers.image.base.digest="sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd"

# A convention for tooling that consults it, stated honestly as one: nothing in
# this tier reads NODE_ENV. It is also the only ENV here — PORT and HOST are left
# unset so the documented precedence chain resolves from config/health.json rather
# than from a second source of truth baked into this layer.
ENV NODE_ENV=production

# Also Level 3's working directory, so the composition is consistent about where a
# tier's sources live in its image.
WORKDIR /app

# Copied by name rather than as one directory, even though .dockerignore would
# filter a broad copy: naming each file makes the build fail loudly the moment a
# runtime-critical file is deleted or newly swallowed by a broadened pattern, which
# is the only thing that catches the silent identity fallback described above.
#
# config/ keeps its subdirectory because health.js resolves that file as
# <module directory>/config/health.json. index.js is not needed at run time and is
# kept only so /app mirrors the repository.
#
# Nothing is copied with --chown, so the payload stays root-owned and
# world-readable: USER node below can read the code and configuration it runs but
# cannot rewrite them — including /app/health.js, which every HEALTHCHECK loads, so
# a compromised process cannot edit the source its own probe reads.
COPY package.json ./
COPY health.js server.js index.js ./
COPY config/health.json ./config/health.json

# ======================= REQUIRED IN-IMAGE VERIFICATION ======================
# Naming each file above makes a deleted file or a newly broadened .dockerignore
# pattern fail THIS build with "not found". That is the half this file can enforce.
# The other half cannot be expressed here: package.json and config/health.json fail
# SILENTLY at run time when absent, because health.js falls back to compiled-in
# literals carrying the same values on purpose — the endpoint still answers 200 with
# a valid four-member body and the HEALTHCHECK still turns green while the reported
# identity is no longer the declared one. No inspection of the response separates
# those two states. Two checks against the built image do, and both are required:
#
#     docker run --rm --user node <image> sh -c 'test -r /app/package.json && test -r /app/config/health.json'
#     docker run --rm --user node <image> node -e "const h=require('/app/health.js');
#       if (Object.values(h.configSources).some((s) => s !== 'file')) process.exit(1)"
#
# The second is the load-bearing one: it reports the PROVENANCE of every resolved
# value, so `file` proves the declared documents were read and `fallback` proves
# they were not — the distinction a green probe cannot make. Both run as the
# unprivileged account, because readability for THAT identity is what is at stake.
# =============================================================================

# Least privilege: the base image's unprivileged `node` user (uid 1000). Port 3000
# needs no privilege and no file is written. Declared after the copies, which stay
# root-owned, so /app is read-only to this process.
USER node

# The DEFAULT port this tier owns in the composition — Levels 2 and 3 own 8000 and
# 8080, so all three applications can run side by side on one host. EXPOSE publishes
# nothing by itself; it documents the default for an operator and for `docker run -P`,
# and is kept identical to config/health.json's `port`. An image run with `-e PORT=`
# binds that port instead, and the probe below follows the override on its own rather
# than repeating the literal.
EXPOSE 3000

# HEALTHCHECK — the reason this file exists. --timeout is strictly below --interval
# so a slow probe cannot overlap the next; 5s is ample for Node to bind (the JVM
# tier's 20s belongs to that tier); 3 retries keep one transient failure from
# flipping a healthy container.
#
# The probe is Node's built-in global fetch: no package, no binary, no shell. It
# addresses 127.0.0.1 because a health probe asserts the state of THIS process in
# THIS container, and 0.0.0.0 is a bind address rather than a destination.
#
# The three options on the call are the probe, not decoration — `fetch` is a general
# HTTP client with browsing defaults and a liveness probe needs the opposite:
#
#   * `redirect: "error"` — the default is `follow`, so a `302 Location:
#     http://elsewhere/health` would have the probe report on another host.
#   * `r.status === 200` rather than `r.ok` — `r.ok` accepts the whole 2xx range,
#     which the contract does not: /health answers 200 with a body, and a `204`
#     carries no contract body at all.
#   * `signal: AbortSignal.timeout(2000)` — `fetch` has no default timeout, so a
#     listener that accepts and never answers would run past --timeout=3s and have
#     the verdict decided by a daemon kill instead of by the probe.
#
# No proxy defence is needed here, unlike Level 2: Node's global `fetch` does not
# honour http_proxy on this runtime, while Python's urllib autodetects proxies.
#
# The target is resolved, not written: the port and the path come from health.js's
# `config` export — the same resolved configuration server.js binds from — so probe
# and listener cannot disagree about where the endpoint is. `docker run -e PORT=3100`
# relocates the listener, and a probe holding a literal 3000 would then report a
# healthy container as unhealthy; one chain resolving it for both (PORT, then
# config/health.json, then the literal) makes that disagreement impossible.
#
# health.js is required rather than server.js: server.js starts a listener at module
# scope, so requiring it from a probe would bind a second socket on every check.
# health.js binds nothing, is byte-silent, and anchors its paths to __dirname.
#
# Exit 0 is healthy and 1 unhealthy (2 is reserved by the runtime). The try/catch and
# the `.catch` keep every failure inside that two-value vocabulary and keep the streams
# silent — `docker inspect` retains probe output, so a probe must not narrate. A
# container starts in `starting` and becomes `healthy` on the first successful probe.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD ["node", "-e", "try { const { config } = require('/app/health.js'); fetch('http://127.0.0.1:' + config.port + config.path, { redirect: 'error', signal: AbortSignal.timeout(2000) }).then((r) => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1)); } catch { process.exit(1); }"]

# `server.js`, never `index.js`: the latter writes five lines and exits 0, which
# inside a container reads as an immediate death.
#
# Exec form, so node receives SIGTERM and SIGINT directly and closes its listener
# rather than being SIGKILLed after the grace period. The base image's inherited
# ENTRYPOINT ends in `exec "$@"`, so node still becomes PID 1. No tini, no dumb-init,
# no supervisor: a listener that handles its own signals is enough.
CMD ["node", "server.js"]
