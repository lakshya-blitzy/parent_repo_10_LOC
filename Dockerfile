# Container image for the ParentRepo10Loc console application (.NET 8).
#
# Two stages, by design:
#   build - carries the full .NET 8 SDK, which is what restore and publish require.
#   final - carries only the .NET 8 console runtime, so the SDK, the package cache and
#           every intermediate compilation artifact stay out of the shipped image.
#
# The base image tags float on the 8.0 band instead of being pinned to a digest, so each
# rebuild picks up the current servicing patch of a framework that is approaching the end
# of its support window.
#
# Build and run from this repository's root:
#   docker build -t parent-repo-10-loc .
#   docker run --rm parent-repo-10-loc      # emits 12 on five lines, then exits 0

# -----------------------------------------------------------------------------
# Stage 1 - restore and publish using the .NET 8 SDK
# -----------------------------------------------------------------------------
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /source

# Only the three inputs the build genuinely needs are brought in:
#   global.json           - pins the SDK feature band, keeping the build reproducible
#   Directory.Build.props - the shared target framework and analysis settings that the
#                           project two directories below inherits from this directory
#   src/                  - the application project and its C# sources
# The test project, the CI definition, the documentation, the Git metadata and the
# sibling submodule tree are all deliberately excluded; see .dockerignore.
COPY global.json Directory.Build.props ./
COPY src/ ./src/

# The project path is stated explicitly on both commands below. /source itself holds no
# project or solution file, so a bare invocation would fail with MSB1003. Naming the
# project while keeping /source as the working directory is also what lets MSBuild
# discover the Directory.Build.props and global.json copied above it.
RUN dotnet restore src/ParentRepo10Loc/ParentRepo10Loc.csproj

# --no-restore relies on the layer above, so a source-only change does not re-resolve
# packages. Release configuration builds under the repository's warnings-as-errors gate.
RUN dotnet publish src/ParentRepo10Loc/ParentRepo10Loc.csproj \
    --configuration Release \
    --no-restore \
    --output /app

# -----------------------------------------------------------------------------
# Stage 2 - ship the published assembly on the minimal console runtime
# -----------------------------------------------------------------------------
FROM mcr.microsoft.com/dotnet/runtime:8.0 AS final
WORKDIR /app

COPY --from=build /app .

# Drop privileges to the unprivileged app account (UID 1654) that every .NET 8 Linux
# image provides. Those images run as root unless this is set, and selecting the account
# by UID rather than by name is what satisfies a runAsNonRoot admission policy.
USER $APP_UID

# Exec form, so the entry process receives signals directly and shuts down cleanly.
# This is a batch workload with no listening socket, so no port or health directives
# are declared.
ENTRYPOINT ["dotnet", "ParentRepo10Loc.dll"]
