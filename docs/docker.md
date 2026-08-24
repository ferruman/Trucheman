# Running Trucheman with Docker

Docker Compose is the supported installation path for people who do not want to install Node.js
or build the application manually. The published image supports Linux `amd64` and `arm64`, which
covers common Linux machines, Intel Macs, and Apple Silicon Macs through Docker Desktop.

## Install

Install Docker Desktop or Docker Engine with the Compose plugin, then run:

```sh
git clone https://github.com/ferruman/Trucheman.git
cd Trucheman
cp .env.example .env
```

Open `.env` in a text editor and configure the provider. At minimum, a live run needs translation
and editing API keys. Keep `.env` private; it is ignored by Git.

```dotenv
TRUCHEMAN_TRANSLATION_API_KEY=your-key
TRUCHEMAN_EDITING_API_KEY=your-key
```

The same model can serve every stage. For better production quality, use separate translation and
editing models and an independent critic model—preferably from another model family—so the critic
does not simply repeat the translator's and editor's blind spots. Test the combination on a short
chapter before processing a complete book.

Start the application:

```sh
docker compose up -d
```

Compose pulls `ghcr.io/ferruman/trucheman:latest` when it is available. When working from a source
checkout before an image has been published, Compose can build the same image locally:

```sh
docker compose up -d --build
```

Open `http://127.0.0.1:4173`. To use another host port, set `TRUCHEMAN_HTTP_PORT` in `.env`; the
container remains reachable only from the local machine.

## Secrets and storage

Compose mounts `.env` through its secrets mechanism at `/run/secrets/trucheman_env`. Provider keys
therefore do not appear in the image layers or the container environment shown by `docker inspect`.
They remain present on the host in `.env`, so protect that file like any other credential file.

Source EPUBs, checkpoints, batch identifiers, translated output, and reports live in the named
volume `trucheman-data`. `docker compose down` removes the container but preserves this volume.
`docker compose down -v` permanently removes it.

## Operations

Show status and health:

```sh
docker compose ps
```

Follow logs:

```sh
docker compose logs -f
```

Stop while preserving data:

```sh
docker compose down
```

Update to the newest published image:

```sh
docker compose pull
docker compose up -d
```

## Backup and restore

Stop Trucheman before taking a filesystem-level backup so every journal and state file is settled:

```sh
docker compose down
docker run --rm \
  --volume trucheman_trucheman-data:/data:ro \
  --volume "$PWD:/backup" \
  alpine:3.22 \
  tar -czf /backup/trucheman-data.tar.gz -C /data .
```

Restore into an empty volume:

```sh
docker volume create trucheman_trucheman-data
docker run --rm \
  --volume trucheman_trucheman-data:/data \
  --volume "$PWD:/backup:ro" \
  alpine:3.22 \
  tar -xzf /backup/trucheman-data.tar.gz -C /data
docker compose up -d
```

The default volume name follows Compose's `<project>_<volume>` convention. Confirm it with
`docker volume ls` if the project was started with a custom Compose project name.

## Security model

- The published port is bound to `127.0.0.1`, not every network interface.
- The process runs as the unprivileged `node` user.
- The root filesystem is read-only; only `/app/data` and the temporary filesystem are writable.
- Linux capabilities are dropped and privilege escalation is disabled.
- The image contains production dependencies and compiled output, not build tooling or source
  credentials.
- GitHub Actions smoke-tests the image before publishing it with provenance and an SBOM.

Trucheman is a single-user local application. Do not reverse-proxy it onto a public network without
adding authentication, TLS, request limits, and an explicit threat model.
