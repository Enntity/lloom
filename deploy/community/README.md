# LLooM Community Production MVP

This is a deliberately small, public **read-only** community registry. It serves
the catalog, leaderboard, signed recipe packs, and a lightweight website. It does
not accept anonymous HTTP submissions, execute recipes, host model weights, mount
the Docker socket, or join Cortex/Concierge networks.

Deploy it on a dedicated Hetzner VM such as `lloom-community-01`, not on the
Cortex or Concierge host. The independent VM is the security boundary: a registry
bug must not gain network reachability to Cortex, Redis, MongoDB, workspaces, or
their credentials.

## One-time release prerequisites

1. Enable required pull-request reviews and required CI checks on `main` before
   publishing a release image.
2. Generate the release signing key offline. Keep the private key only on the
   deployment host (or an HSM/KMS); commit and distribute only the public key.

   ```sh
   umask 077
   openssl genpkey -algorithm ed25519 -out lloom-community-2026-private.pem
   openssl pkey -in lloom-community-2026-private.pem -pubout -out lloom-community-2026-public.pem
   ```

3. Ship the public key with the first client release and pin it in client config.
   Do **not** rely on `trustHostKeys: true` for production. A client should use a
   local `trustedKeys` entry for `lloom-community-2026` and keep
   `trustHostKeys: false`; that way a compromise of this web host cannot replace
   the trust root.
4. Build and publish an image with a commit-SHA tag, inspect it, then record its
   immutable digest. Do the same for Caddy. Mutable `latest` tags are forbidden.

## Host setup

Use a supported minimal Ubuntu image. Permit inbound TCP 80 and 443; allow SSH
only through the administration VPN or fixed administrator addresses. Enable
automatic security updates and run Docker rootless when the host policy allows
it. Do not place any other application, database, Redis, model runtime, cloud
credential, or Docker API on this VM.

Copy this directory to `/opt/lloom-community`, then create a root-owned `0600`
`/opt/lloom-community/.env` from `.env.example`. Store both key files outside the
repository under `/opt/lloom-community/secrets/`, also root-owned `0600`.

Before first start, validate interpolation without printing the environment file:

```sh
cd /opt/lloom-community
docker compose --env-file .env -f docker-compose.prod.yml config --quiet
docker compose --env-file .env -f docker-compose.prod.yml pull
docker compose --env-file .env -f docker-compose.prod.yml up -d
```

Verify only through the public domain after DNS points to the VM:

```sh
curl --fail --proto '=https' --tlsv1.2 https://lloom.enntity.com/health
curl --fail --proto '=https' --tlsv1.2 https://lloom.enntity.com/v1/keys
curl -i -X POST https://lloom.enntity.com/v1/recipe-packs
```

The final command must return `405 submissions_disabled`. That is intentional:
contributors open a GitHub PR, maintainers reproduce the recipe in disposable
machines, then an authorized release process signs and publishes it.

## Security properties to preserve

- The app has no published host port; only Caddy exposes 80/443.
- Neither container mounts `/var/run/docker.sock` or host source/data paths.
- The registry runs as an unprivileged UID with a read-only root filesystem, no
  Linux capabilities, `no-new-privileges`, PID/memory/CPU limits, and a small
  `noexec` temporary filesystem.
- Production refuses an ephemeral signing key and refuses public submission mode.
- A per-client application-level rate limit protects the catalog even if a reverse
  proxy rate-limit policy is changed accidentally.
- The app rejects bodies over 1 MiB, limits request/header lifetimes, disables
  wildcard CORS, returns generic production 5xx errors, and sends browser
  hardening headers.
- Back up Caddy's certificate volume and retain the public release manifest; do
  not back up or copy the private signing key into ordinary application backups.

## Promotion workflow

1. Contributor submits a PR with a declarative recipe, provenance, immutable
   model/container/package references, and reproducible benchmark evidence.
2. CI validates schemas and policy; maintainers run the recipe only in an
   isolated disposable test environment.
3. A reviewer labels it experimental or stable. Stable releases require two
   maintainer approvals and a signed release artifact.
4. Publish the new image digest only after the public key pin is available to
   clients. Revocations are a new signed release, never an in-place mutation.

Votes and popularity are not a promotion mechanism. The public site may later
show them as discovery signals, but default recommendations remain maintainer
curated and benchmark-backed.
