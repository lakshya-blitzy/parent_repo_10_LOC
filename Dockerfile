# Level 1 (apex) container image — parent_repo_10_LOC, the JavaScript tier.
#
# The image exists for the HEALTHCHECK at the end of this file: a container is
# the only place "this application is up" becomes a state the runtime tracks.
# Nothing is compiled and nothing is installed, so this is a single stage.
#
# Two invariants are load-bearing:
#   * Nothing is installed. Zero third-party dependencies is a property of the
#     whole composition; never add npm/yarn/pnpm/apk here. That also rules out
#     curl for the probe — it is absent from this base, and Node is not.
#   * package.json and config/health.json MUST reach the image. health.js reads
#     both at module load and falls back to compiled-in literals rather than
#     failing, so their absence leaves the endpoint answering 200 with an
#     identity this repository never declared. Both are copied by name below so
#     that losing one fails the build instead.
#
# The LABEL block below is deliberately narrow. Neither the application name nor
# its version is stamped: package.json is their single declared source and the
# payload already serves them, so a second copy would be free to drift. The base
# image's name and digest ARE stamped, because their only other home is the FROM
# line and they are exactly what an operator triaging a base-image advisory needs
# to read off a running container.
#
# See .dockerignore for the build-context policy, docs/health-endpoint.md §11 for
# the normative probe design, and .env.example for the PORT and HOST overrides.

# Pinned by tag AND by digest. node:24-alpine is the Node 24.x Active LTS line,
# and this image ships v24.18.0 — the version .nvmrc pins.
#
# The digest is the multi-architecture OCI image index for the tag. It does not
# make one byte-for-byte image universal — the index selects a platform-specific
# child manifest — but it does fix exactly which image a given commit builds
# from, per platform. Bump tag and digest together; never use a floating tag.
#
# THE TRADE, STATED PLAINLY: a digest pin freezes the base image, and a frozen
# base does not receive the Alpine and Node patches its tag does. This file
# chooses reproducibility because the pinned digest is a declared value in the
# project specification. The digest below was resolved from the live registry and
# IS what Docker Hub currently serves for node:24-alpine — verified twice, as the
# tag's `docker-content-digest` and as the local image's RepoDigests — so the pin
# is the tag head rather than superseded content.
#
# A pin cannot fix itself, so the pipeline is what must notice it going stale:
# scan the BUILT image (a Dockerfile has no vulnerabilities, an image does), fail
# on a HIGH or CRITICAL finding that HAS a fix and report anything lower as
# advisory (a gate that fails on every unfixable LOW is a gate that gets
# bypassed), and treat such a finding as a REFRESH instruction rather than a
# reason to un-pin — un-pinning trades a known dated exposure for an unknown one.
# To refresh: `docker pull node:24-alpine`, read
# `docker image inspect --format '{{index .RepoDigests 0}}' node:24-alpine`,
# replace the digest here AND in the base.digest label, move .nvmrc and the
# engines range with it if the Node patch release changed, update the digest
# recorded in the specification, then rebuild, re-scan and re-run the contract
# assertions. Never guess, shorten or hand-edit a digest.
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

# Standard OCI annotations, so a registry or host can be asked what this image is
# without reading this file. base.name answers "which line is this built on";
# only base.digest answers "which content", which is the question an advisory
# actually asks — and it MUST equal the digest in the FROM line above, since the
# two are refreshed together. Nothing secret appears in any label, and nothing
# here is read at run time.
LABEL org.opencontainers.image.title="parent_repo_10_LOC" \
      org.opencontainers.image.description="JavaScript /health endpoint serving the frozen name/version/timestamp/status contract on port 3000, on the Node standard library alone" \
      org.opencontainers.image.base.name="node:24-alpine" \
      org.opencontainers.image.base.digest="sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd"

# A convention for tooling that consults it, stated honestly as one: nothing in
# this tier reads NODE_ENV. It is also the only ENV here — PORT and HOST are left
# unset so the documented precedence chain resolves from config/health.json
# instead of from a second source of truth baked into this layer.
#
# What that means for an operator, measured on this image rather than assumed:
#
#   * To publish the endpoint elsewhere, remap it — `docker run -p 9000:3000`. The
#     container-internal port stays 3000, so EXPOSE, the HEALTHCHECK below and
#     config/health.json all remain correct. Verified: a remapped run reaches
#     `healthy` and serves the contract unchanged. This is the normal case and it
#     needs nothing from this file.
#   * Setting PORT moves the listener INSIDE the container, and the probe below
#     follows it there rather than carrying its own copy of the port: it resolves
#     the port through health.js, the same module and therefore the same chain the
#     server resolves it through, so the two cannot disagree — even for a value the
#     chain refuses, since `PORT=99999` is out of range and both fall through to
#     config/health.json's 3000. `docker run -e PORT=4000 -p 4000:4000` therefore
#     needs no `--health-cmd` override and no edit to this file. Verified on the
#     built image: the default run and the PORT-overridden run each reach `healthy`
#     and serve the contract, and a container whose listener has been stopped goes
#     `unhealthy`.
ENV NODE_ENV=production

# Also Level 3's working directory, so the composition is consistent about where
# a tier's sources live in its image.
WORKDIR /app

# Copied by name rather than as one directory, even though .dockerignore would
# filter a broad copy: naming each file makes the build fail loudly the moment a
# runtime-critical file is deleted or newly swallowed by a broadened pattern,
# which is the only thing that catches the silent identity fallback above.
#
# config/ keeps its subdirectory because health.js resolves that file as
# <module directory>/config/health.json. index.js is not needed at run time and
# is kept only so /app mirrors the repository.
COPY --chown=node:node package.json ./
COPY --chown=node:node health.js server.js index.js ./
COPY --chown=node:node config/health.json ./config/health.json

# ======================= REQUIRED IN-IMAGE VERIFICATION ======================
# Because each of the three lines above names its file, a deleted file or a newly
# broadened .dockerignore pattern fails THIS build with "not found" rather than
# producing an image that starts and misreports itself. That is the first half of
# the guarantee. The second half cannot be expressed in this file, so it is
# recorded here for whoever runs the build: the identity and serving documents
# fail SILENTLY at run time if they are ever absent, because health.js falls back
# to compiled-in literals that carry the same values on purpose - the endpoint
# still answers 200 with a valid four-member body and the HEALTHCHECK below still
# turns green, while the identity being reported is no longer the declared one.
# No amount of inspecting the response can tell those two states apart. Two
# direct checks inside the built image can, and both are required rather than
# optional (the automated pipeline's container job owns them):
#
#     docker run --rm <image> sh -c 'test -r /app/package.json && test -r /app/config/health.json'
#     docker run --rm <image> node -e "const h=require('/app/health.js');
#       if (Object.values(h.configSources).some((s) => s !== 'file')) process.exit(1)"
#
# The second is the load-bearing one: it reports the PROVENANCE of every resolved
# value, so `file` proves the declared documents were read and `fallback` proves
# they were not - the distinction a green probe cannot make.
# =============================================================================

# Least privilege: the base image's unprivileged `node` user (uid 1000). Port
# 3000 needs no privilege and no file is written. Declared after the copies, so
# --chown is what grants read access and /app stays root-owned — and therefore
# read-only to this process.
USER node

# The port this tier owns in the composition — Levels 2 and 3 own 8000 and 8080, so
# all three applications can run side by side on one host during validation. EXPOSE
# publishes nothing by itself; it documents the DEFAULT for an operator and for
# `docker run -P`, and it is kept identical to config/health.json's `port` for that
# reason. It is a declaration rather than a constraint, and the one place in this
# file that names the number: an image run with `-e PORT=` binds that port instead
# and the operator is expected to publish it, while the probe below follows the
# override on its own rather than repeating the literal.
EXPOSE 3000

# HEALTHCHECK — the reason this file exists. --timeout is strictly below
# --interval so a slow probe cannot overlap the next; 5s is ample for Node to
# bind (the JVM tier's 20s belongs to that tier); 3 retries keep one transient
# failure from flipping a healthy container.
#
# The probe is Node's built-in global fetch: no package, no binary, no shell. It
# addresses 127.0.0.1 because a health probe asserts the state of THIS process in
# THIS container, and 0.0.0.0 is a bind address rather than a destination.
#
# THE THREE OPTIONS ON THE CALL ARE THE PROBE, not decoration. `fetch` is a
# general HTTP client with browsing defaults, and a liveness probe needs the
# opposite: fail closed, answer only about ITS OWN process, always terminate.
# Each option closes a hole measured on the pinned runtime (Node 24.18.0):
#
#   * `redirect: "error"` — the default is `follow`, so an endpoint answering
#     `302 Location: http://elsewhere/health` would have the probe report on that
#     other host. Measured against a 302 towards a 200-answering listener: the
#     following form exits 0, this form exits 1.
#   * `r.status === 200` rather than `r.ok` — `r.ok` accepts the whole 2xx range,
#     which the contract does not: /health answers 200 with a body and nothing
#     else is healthy. Measured against `204 No Content`: the `r.ok` form exits 0
#     with no contract body sent, and none could be.
#   * `signal: AbortSignal.timeout(2000)` — `fetch` has no default timeout at
#     all. Against a listener that accepts and never answers, the unbounded form
#     ran 25s and was still running when the harness killed it; this form exits 1
#     after ~2.1s, inside --timeout=3s, so the verdict is always the probe's own
#     rather than a kill by the daemon.
#
# It deliberately does NOT defend against proxy environment variables, and the
# asymmetry with the Level 2 probe is measured rather than an oversight: Node's
# global `fetch` does not honour http_proxy/HTTP_PROXY on this runtime, and still
# did not with NODE_USE_ENV_PROXY=1 or NODE_OPTIONS=--use-env-proxy. Python's
# urllib autodetects proxies, which is why that tier passes an empty
# `ProxyHandler({})` and this one needs no counterpart.
#
# THE TARGET IS RESOLVED, NOT WRITTEN. The port and the path come from health.js's
# `config` export — the same resolved configuration server.js binds from — so the
# probe cannot disagree with the listener about where the endpoint is. That matters
# because the listener's address is genuinely overridable: `docker run -e PORT=3100`
# relocates it, and a probe holding a literal 3000 would then report a container
# that is serving perfectly as unhealthy, a false alarm an operator could only
# silence by replacing the health command itself. Requiring the module means one
# chain resolves it for both — PORT, then config/health.json, then the compiled-in
# literal, including the digits-only port validation — so an unusable PORT falls
# through for the probe exactly as it does for the listener. Verified in both
# directions on the built image: healthy with the default configuration, and healthy
# again with `-e PORT=3100`, where the previous literal probe reported unhealthy.
#
# health.js is required rather than server.js: server.js exports nothing and starts
# a listener at module scope, so requiring it from a probe would bind a second
# socket on every check. Requiring health.js binds nothing — createHealthServer is a
# factory this probe never calls — is byte-silent on both streams (measured: 0
# bytes), and anchors its own paths to __dirname, so the absolute /app/health.js
# works whatever directory the runtime runs the command from.
#
# The try/catch is what keeps the exit code inside the two-value vocabulary below. A
# synchronous failure — an absent module, a manifest the loader cannot parse — would
# otherwise leave `node -e` printing a stack trace into the container's health log;
# caught, it is reported as unhealthy, which is the honest answer for an image whose
# own configuration will not load.
#
# THE TARGET IS RESOLVED, NOT WRITTEN. The port and the path are not restated
# here: they are read from health.js — the one module that resolves them, through
# the one documented chain (PORT, then config/health.json, then the compiled-in
# literal) — so the probe asks for exactly the address the process bound. That is
# the point: this image honours PORT at start-up, so a probe carrying its own copy
# of 3000 would report a perfectly healthy container as unhealthy the moment
# anyone used the override this repository documents, and the container would be
# killed for obeying its own configuration. Deriving it costs one require of a
# module already in the image and removes a duplicate that was free to disagree,
# which is the same reason server.js does not re-derive the value either.
#
# health.js is required rather than server.js: server.js exports nothing and
# starts a listener at module scope, so requiring it from a probe would bind a
# second socket on every check. Requiring health.js binds nothing —
# createHealthServer is a factory this probe never calls — and is byte-silent on
# both streams (measured: 0 bytes), with its own paths anchored to __dirname so
# the absolute /app/health.js works from any working directory.
#
# Exit 0 is healthy and 1 unhealthy (2 is reserved by the runtime). The catch
# branch is required — without it a refused connection would surface as an
# unhandled rejection, making an unhealthy container indistinguishable from a
# broken probe. Verified in every direction: exit 0 against a live endpoint, and
# exit 1 against a dead port, a 302, a 204 and a hung endpoint, with zero bytes on
# stdout and stderr in all of them — `docker inspect` retains probe output, so
# silence on the failure paths is part of the design.
#
# A container starts in `starting` and transitions to `healthy` on the first
# successful probe; that transition is what the pipeline observes.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD ["node", "-e", "try { const { config } = require('/app/health.js'); fetch('http://127.0.0.1:' + config.port + config.path, { redirect: 'error', signal: AbortSignal.timeout(2000) }).then((r) => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1)); } catch { process.exit(1); }"]

# `server.js`, never `index.js`: the latter writes five lines and exits 0, which
# inside a container reads as an immediate death.
#
# Exec form, so node receives SIGTERM and SIGINT directly and closes its listener
# rather than being SIGKILLed after the grace period. The base image's inherited
# ENTRYPOINT ends in `exec "$@"`, so node still becomes PID 1. No tini, no
# dumb-init, no supervisor: a listener that handles its own signals is enough.
CMD ["node", "server.js"]
