# =============================================================================
# Level 1 (apex) container image - parent_repo_10_LOC, the JavaScript tier.
#
# WHY THIS FILE EXISTS
#
# The container is the only place a HEALTHCHECK can express "this application is
# up", which is precisely the semantic the /health endpoint introduces. Every
# instruction below exists to serve that one resource and to let the container
# runtime observe it. There is nothing to compile, nothing to install and nothing
# to generate, so this is a single-stage image with zero RUN instructions.
#
# WHAT THE IMAGE RUNS
#
#   node server.js  ->  binds 0.0.0.0:3000 and serves GET|HEAD /health
#
# and deliberately NOT `node index.js`. That is this tier's pre-existing one-shot
# program: it writes five lines and exits 0, which inside a container reads as an
# immediate - and misleadingly clean - death. Its behaviour is preserved by the
# repository, untouched, and is exercised by the test suite and CI rather than by
# this image.
#
# THE RESPONSE THIS IMAGE MUST BE ABLE TO PRODUCE (verified live before writing)
#
#   200 OK
#   Content-Type: application/json; charset=utf-8
#   Cache-Control: no-store
#   {"name":"parent_repo_10_LOC","version":"1.0.0","timestamp":"...","status":"UP"}
#
# Levels 2 (python:3.14-slim, port 8000) and 3 (multi-stage Eclipse Temurin, port
# 8080) build their own images from their own sources and are never bundled into
# this one - `.dockerignore` keeps the child submodule out of the build context
# for exactly that reason. The three tiers share a documented contract,
# docs/health-endpoint.md, and no runtime artifact whatsoever, which is what keeps
# the levels independent of one another.
#
# INVARIANTS. Each of these is load-bearing; changing one breaks something, and
# the last one breaks it silently:
#
#   * NO package installation, of any kind. Zero third-party dependencies is a
#     deliberate property of this whole composition rather than an accident of a
#     small change set, and the security posture rests on it. There is no
#     node_modules tree and no lockfile to restore. Never add RUN npm install,
#     npm ci, npm audit, yarn, pnpm or apk add.
#   * NO curl, wget or nc in the probe. `curl` cannot be assumed present in a
#     minimal image - it is genuinely absent from this base, verified with
#     `command -v curl` inside it - and installing one purely to observe the
#     endpoint would breach the invariant above. BusyBox wget does happen to
#     exist here, but using it would make this tier's probe differ from Levels 2
#     and 3, which have no HTTP client binary to fall back on. Node is already
#     in the image; the probe uses Node.
#   * Single stage. Nothing is built, so there is no artifact to hand between
#     stages. Multi-stage is Level 3's pattern, where javac output is separated
#     from the JRE that runs it.
#   * Exec-form CMD. Shell form would interpose /bin/sh as PID 1, and /bin/sh
#     does not forward SIGTERM to its child, so `docker stop` would wait out the
#     full grace period and then SIGKILL a process that was perfectly willing to
#     close its listener and exit 0.
#   * package.json and config/health.json MUST reach the image. health.js reads
#     both from disk at module load, anchored to __dirname. Their absence does
#     NOT raise: the CommonJS loader tolerates a missing package.json entirely,
#     so health.js loads, falls through to its compiled-in literals, still
#     answers 200 with a valid four-member body, and the HEALTHCHECK still goes
#     green - while the identity on the wire is no longer the one this repository
#     declares. Nothing fails, which is what makes it the dangerous case. Both
#     are therefore copied BY NAME below, so their loss fails the build instead.
#
# There is deliberately no LABEL block: the only metadata worth stamping here is
# the name and version, and both already have a single declared source in
# package.json which the payload itself serves. Duplicating them into image
# metadata would create a second copy free to drift from the first.
#
# See also: .dockerignore (the build-context denylist, which documents the same
# four must-ship files from the opposite direction), docs/health-endpoint.md
# section 11 (the normative probe design for all three tiers), and .env.example
# (the PORT and HOST overrides an operator may set at `docker run` time).
# =============================================================================

# -----------------------------------------------------------------------------
# Base image - pinned by tag AND by digest.
#
# node:24-alpine is the Node.js 24.x Active LTS line (24.18.0, end of life
# 2028-04-30). It agrees with both other places this tier states its runtime:
# .nvmrc pins 24.18.0 and package.json declares "engines": {"node": ">=24.0.0"}.
# The image below was confirmed to ship exactly v24.18.0, so all three agree on a
# single Node version rather than merely on a compatible range.
#
# The digest is the immutable, multi-architecture OCI image index for that tag,
# resolved from the registry rather than transcribed by hand: `docker manifest
# inspect` reports application/vnd.oci.image.index.v1+json with amd64 and arm64
# children, so this one pin resolves correctly on any runner architecture. The
# human-readable tag is kept alongside it because a bare digest tells a reader
# nothing about what it points at.
#
# Pinning both is what makes the build reproducible rather than merely
# repeatable: the same commit yields the same image on any machine at any time,
# and a base-image update becomes a deliberate, reviewable edit here - bump the
# tag and the digest together. Never substitute a floating reference such as
# node:latest, node:alpine or a bare major.
# -----------------------------------------------------------------------------
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

# Declares production posture for any tooling that consults it. Nothing in this
# tier reads NODE_ENV - the source was checked, and with zero dependencies there
# is no framework to branch on it - so this is a convention rather than a switch,
# and it is stated honestly as one.
#
# It is also the ONLY ENV in this file. PORT and HOST are deliberately left
# unset so the documented precedence chain - environment variable, then
# config/health.json, then the compiled-in literal - resolves from the file that
# is version-controlled beside the code. Baking either one in here would create a
# second source of truth for the bind target, free to disagree with
# config/health.json while both look authoritative.
#
# What that means for an operator, measured on this image rather than assumed:
#
#   * To publish the endpoint on a different port, remap it - `docker run -p
#     9000:3000`. The container-internal port stays 3000, so EXPOSE, the
#     HEALTHCHECK below and config/health.json all remain correct. Verified: a
#     remapped run reaches `healthy` and serves the contract unchanged. This is
#     the normal case and it needs nothing from this file.
#   * Setting PORT moves the listener INSIDE the container, and the probe below
#     addresses a literal 3000, so such a run must carry a matching probe:
#     `docker run -e PORT=4000 --health-cmd "<the probe below, with 4000>"`.
#     Verified in both directions - without the matching probe the container
#     serves correctly on 4000 and still goes `unhealthy`, and with it the
#     container reaches `healthy`. The literal is kept rather than resolving PORT
#     inside the probe because a probe that mirrored one link of the chain but not
#     the others - an out-of-range PORT that the server correctly rejects and
#     falls back from, for instance - would report a false unhealthy, which is a
#     worse failure than an explicit, documented pairing.
ENV NODE_ENV=production

# /app is also Level 3's working directory (its probe runs `java -cp /app`), so
# the composition is consistent about where a tier's sources live in its image.
WORKDIR /app

# -----------------------------------------------------------------------------
# Runtime sources, copied BY NAME rather than as one broad directory.
#
# `COPY . .` is deliberately avoided even though .dockerignore would filter it.
# Naming each file makes the build fail loudly - "not found" - the moment a
# runtime-critical file is deleted or is newly swallowed by a broadened
# .dockerignore pattern, which is the only mechanism that catches the silent
# identity-fallback failure described in the header. Naming config/health.json
# rather than the directory that holds it matters for the same reason: an
# excluded FILE inside an included directory would otherwise copy an empty
# directory and raise nothing. As a bonus the list doubles as documentation of
# exactly what a running container needs.
#
#   package.json        the declared name and version - payload members 1 and 2
#   health.js           payload builder, request handler and server factory
#   server.js           the entry point this image runs
#   index.js            the pre-existing program. Not needed at run time; kept so
#                       /app mirrors the repository, at a cost of a few bytes.
#   config/health.json  the declared host, port, path and status
#
# The config/ subdirectory structure is preserved because health.js resolves that
# file as <module directory>/config/health.json; flattening it to /app/health.json
# would leave the read to fail over to the literals.
#
# --chown=node:node hands ownership to the unprivileged user selected below, so
# the process reads its own sources without ever running as root.
#
# Not copied, on purpose: .nvmrc (this image's Node version comes from the pinned
# base above; a second, never-read version pin inside /app could drift from the
# base image's actual build and mislead whoever read it), index.test.js, README.md,
# docs/ and .github/ (development and CI inputs, consumed from the repository, and
# all excluded from the context anyway), and the child_repo_10_LOC submodule
# (Python and Java sources a Node image can neither run nor serve).
# -----------------------------------------------------------------------------
COPY --chown=node:node package.json ./
COPY --chown=node:node health.js server.js index.js ./
COPY --chown=node:node config/health.json ./config/health.json

# Least privilege. node:24-alpine ships an unprivileged `node` user (uid 1000,
# gid 1000, confirmed present in this exact image) and nothing this image does
# needs root: the endpoint opens port 3000, which is above the privileged range,
# and writes no file anywhere. Declared after the copies so the --chown above is
# what grants read access; /app itself stays root-owned and therefore read-only
# to this process, which is a property worth keeping rather than a limitation.
USER node

# The port this tier owns in the composition - Levels 2 and 3 own 8000 and 8080,
# so all three applications can run side by side on one host during validation.
# EXPOSE publishes nothing by itself; it documents the contract for an operator
# and for `docker run -P`. Kept identical to config/health.json's `port` and to
# the probe below, because a disagreement between the three would produce a
# container that runs and is unreachable.
EXPOSE 3000

# -----------------------------------------------------------------------------
# HEALTHCHECK - the reason this file exists.
#
# The timing set, and why each value is the value it is:
#
#   --interval=30s      the handler reads one already-loaded value set and one
#                       clock, so a slower cadence costs nothing and keeps probe
#                       traffic off a busy host
#   --timeout=3s        generous for that handler, and strictly less than the
#                       interval so a slow probe can never overlap the next one
#   --start-period=5s   Node binds in well under a second; a failure inside this
#                       window does not spend the retry budget. Level 3's JVM
#                       needs 20s - that value belongs to that tier, not here.
#   --retries=3         one transient failure must not flip a healthy container
#                       to unhealthy
#
# The probe is language-native and installs nothing: Node's built-in global
# fetch, which needs no package, no binary and no shell. Exec form is used so the
# Dockerfile parser hands the script to `node -e` verbatim - no /bin/sh is
# interposed, so there is no quoting ambiguity to get wrong and no extra process
# in the tree.
#
# It addresses 127.0.0.1, never 0.0.0.0, a container name or a public hostname: a
# health probe asserts the state of THIS process inside THIS container, and
# 0.0.0.0 is a bind address rather than a destination. The port matches EXPOSE and
# config/health.json.
#
# Exit codes are the whole interface to the container runtime, and only two are
# ever produced: 0 means healthy, 1 means unhealthy. Code 2 is reserved by the
# runtime and is never returned from here. `r.ok` is true only for a 2xx, which is
# exactly the range the health contract requires of a healthy response, so a 404
# or 405 from a misrouted request reports unhealthy instead of passing. The catch
# branch is not optional: without it a refused connection would surface as an
# unhandled rejection, and a legitimately unhealthy container would be
# indistinguishable from a broken probe. Verified in both directions - exit 0
# against a live listener, exit 1 against a dead port.
#
# A container starts in `starting` and transitions to `healthy` on the first
# successful probe; that transition is what CI observes.
# -----------------------------------------------------------------------------
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

# -----------------------------------------------------------------------------
# Entry point. Exec form, so node ends up as PID 1 and receives SIGTERM and
# SIGINT directly: server.js handles both, stops accepting connections, closes
# the listener and exits 0. That is what makes `docker stop` a graceful shutdown
# instead of a wait-then-SIGKILL, and what guarantees the port is released
# promptly so an automated run can rebind it immediately. Measured on the built
# image: PID 1 is `node server.js`, `docker stop` returns in about 0.2s with exit
# code 0 after logging "closing listener" - a swallowed signal would instead have
# taken the full 10s grace period and ended in SIGKILL.
#
# One inherited detail, stated because `docker inspect` on this image shows it and
# a reader would otherwise think the paragraph above is wrong: node:24-alpine
# declares ENTRYPOINT ["docker-entrypoint.sh"], so the array below is passed to
# that script as its arguments rather than executed directly. The script's last
# line is `exec "$@"`, which REPLACES the shell with the command, so node still
# becomes PID 1 and signal delivery is unaffected - verified above rather than
# assumed. It is left inherited on purpose: it is the official image's documented
# convention, and clearing it would be a change to base-image behaviour made for
# no observable gain.
#
# What this file adds is nothing: no ENTRYPOINT wrapper script of its own, no
# tini, no dumb-init and no supervisor. A single listener that handles its own
# signals is the entire requirement, and each of those would add a process, a
# failure mode and a dependency in order to observe a four-member JSON document.
# -----------------------------------------------------------------------------
CMD ["node", "server.js"]
