# dsh-our-free-model-docker

![image build](https://github.com/DuoJLa/dsh-our-free-model-docker/actions/workflows/image.yml/badge.svg)

One-command Docker deployment for **dsh-our-free-model** (standalone service + WebUI + LAN API).

This repository contains **only deployment files**. GitHub Actions builds the default image and runs an end-to-end smoke test (WebUI, management login, API 401/200) on every push. At image build time the
Dockerfile clones the upstream source at a pinned ref (`v2.7.2` by default), so
the upstream source tree, model binaries, and secrets are not stored here.

> Not an official release of the upstream project. Upstream:
> https://github.com/Ebony-Vinyl/dsh-our-free-model — MIT.

## 1. One command

```bash
git clone https://github.com/DuoJLa/dsh-our-free-model-docker.git
cd dsh-our-free-model-docker
sh install.sh
```

That is all. The script:

1. checks Docker / Docker Compose;
2. generates two independent random tokens;
3. writes `docker/.env` (0600) — no manual editing;
4. builds the image (cloning upstream `v2.7.2` inside Docker);
5. starts the container and waits for health;
6. prints the WebUI URL, API URL, and both tokens;
7. saves credentials to `docker/credentials.txt` (0600).

Successful output:

```text
══════════════════════════════════════════
  部署成功
  WebUI   : http://192.168.1.10:8080
  管理令牌: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  API     : http://192.168.1.10:18901/v1
  API 令牌: yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy
  凭据文件: /path/dsh-our-free-model-docker/docker/credentials.txt
  常用命令: sh install.sh creds | status | logs | down
══════════════════════════════════════════
```

Open `http://<host-ip>:8080/` and log in with the **管理令牌**.

To bind a specific LAN interface on first run:

```bash
OFM_BIND_IP=192.168.1.10 sh install.sh
```

## 2. Call the API

```bash
export OFM_HOST=192.168.1.10
export OFM_TOKEN='<API 令牌>'

curl -s -H "Authorization: Bearer ${OFM_TOKEN}" \
  "http://${OFM_HOST}:18901/v1/models"

curl -s -H "Authorization: Bearer ${OFM_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-v4.1-flash-free","messages":[{"role":"user","content":"ping"}]}' \
  "http://${OFM_HOST}:18901/v1/chat/completions"
```

Anthropic Messages:

```bash
curl -s -H "Authorization: Bearer ${OFM_TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-v4.1-flash-free","max_tokens":64,"messages":[{"role":"user","content":"ping"}]}' \
  "http://${OFM_HOST}:18901/v1/messages"
```

## 3. Daily commands

```bash
sh install.sh            # deploy / rebuild / upgrade
sh install.sh creds      # show URLs and tokens (Docker not required)
sh install.sh status     # docker compose ps
sh install.sh logs       # follow logs
sh install.sh down       # stop and remove the container (keeps the data volume)
```

Forgot a token: `sh install.sh creds`.  
Change tokens: edit `docker/.env`, then `sh install.sh`.  
Change ports/bind IP: edit `docker/compose.yaml` or `OFM_BIND_IP` in `docker/.env`.

## 4. How it works

```text
browser  ── http://<host-ip>:8080 ──> container ui-proxy ──> 127.0.0.1:18900 (WebUI/admin)
client   ── http://<host-ip>:18901/v1 ──> LAN relay (Bearer API token)
```

- `8080`: WebUI; only the management token.
- `18901`: OpenAI/Anthropic-compatible API; only the API token.
- `18900`: container loopback only, never published.
- Data: Docker volume `ofm-data` → `/data`.

Build-time source pin lives in `docker/.env`:

```env
OFM_SOURCE_REPO=https://github.com/Ebony-Vinyl/dsh-our-free-model.git
OFM_SOURCE_REF=v2.7.2
```

To deploy another upstream version, change `OFM_SOURCE_REF` (tag/branch/commit)
and run `sh install.sh` again. The build clones that ref inside Docker; no
upstream source needs to be present on the host.

## 5. Security

- **Use TLS across untrusted networks.** Plain `http://host-ip:8080` sends the
  management token in clear text on the LAN. `docker/Caddyfile.lan` provides a
  host-level Caddy example:
  `https://ofm.example.com` → `127.0.0.1:8080`,
  `https://api.ofm.example.com` → `127.0.0.1:18901`.
- Keep the two tokens separate: the management token can change settings and
  read all provider keys; the API token should only call models.
- Bind `OFM_BIND_IP` to a specific LAN IP and firewall 8080/18901.
- Optional extra Basic Auth: add `OFM_UI_BASIC_AUTH=user:password` to
  `docker/.env`, then `sh install.sh`.
- Container: non-root UID 1000, `read_only`, `cap_drop: ALL`,
  `no-new-privileges`, `tmpfs /tmp`.
- Never publish `18900`; never mount `/var/run/docker.sock`.
- `docker/.env` and `docker/credentials.txt` are 0600 and excluded from the
  Docker build context. Do not commit them.

## 6. Account-channel OAuth limitation

The WebUI is reachable remotely, but the account channels' OAuth callbacks are
`127.0.0.1:<port>`:

- Browser and service on the same machine (Linux desktop, NAS with a browser,
  VNC/remote desktop): full login works.
- Browser on another computer (typical headless NAS): the callback goes to your
  computer's `127.0.0.1`, not the NAS. Gemini/LobsterAI use random ports and
  cannot be pre-forwarded; TRAE uses fixed 18080 and can be forwarded with
  `ssh -L 18080:127.0.0.1:18080`. Otherwise log in on a desktop and import the
  account backup, or run the container temporarily on a machine with a browser
  and move the `ofm-data` volume.

EAC uses a remote gateway callback and is not affected, but the container needs
outbound network access. Subscription credentials can be mounted read-only or
imported in the WebUI.

## 7. Full image (magpie model workspace)

The default image does not include the magpie engine; the WebUI's model
workspace page is unavailable, everything else works. For the full image:

```bash
docker build -f docker/Dockerfile.full -t ofm-standalone:2.7.2-full .
```

Then change `dockerfile:` in `docker/compose.yaml` to `docker/Dockerfile.full`
and run `sh install.sh`. The engine is built from the same pinned upstream ref
with Go; the build needs GitHub/Go module access and adds roughly 70 MB.

## 8. Advanced topologies

- `docker/compose.host.yaml`: host network + SSH tunnel, best when the browser
  runs on the same host and full OAuth login is needed.
- `docker/compose.api.yaml`: API-only, publishes 18901 only; management stays on
  container loopback.

## 9. Backup / upgrade

```bash
# backup (stop first)
docker compose -f docker/compose.yaml stop ofm
docker run --rm -v ofm-data:/data -v "$PWD/backup:/backup" alpine \
  tar czf /backup/ofm-$(date +%F).tgz -C /data .
docker compose -f docker/compose.yaml start ofm

# restore
docker compose -f docker/compose.yaml stop ofm
docker run --rm -v ofm-data:/data -v "$PWD/backup:/backup" alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/ofm-YYYY-MM-DD.tgz -C /data'
docker compose -f docker/compose.yaml start ofm
```

Upgrade: change `OFM_SOURCE_REF` in `docker/.env`, then `sh install.sh`.
Back up the `ofm-data` volume before every upgrade.

## 10. Troubleshooting

- **WebUI 403 “管理接口仅允许本机同源访问”**: do not map 8080 directly to
  18900; use the bundled `ui-proxy.mjs` or the provided compose.
- **WebUI 401**: check `OFM_MANAGEMENT_KEY` in `docker/.env`; rerun `sh install.sh`.
  One-time URL: `docker exec ofm cat /data/bootstrap-url`.
- **API 401**: use `Authorization: Bearer <OFM_LAN_KEY>`, not the management token.
- **`EEXIST` / data directory in use**: check for a second container using the
  same `ofm-data` volume; set `OFM_CLEAR_STALE_LOCK=0` to disable auto-cleanup.
- **Worker invalid execArgv**: do not put V8 flags on the command line; memory
  belongs in `NODE_OPTIONS`.
- **Build fails cloning upstream**: the build stage needs outbound access to
  GitHub. Set `OFM_SOURCE_REPO`/`OFM_SOURCE_REF` to a reachable mirror/ref.
- **OAuth callback fails**: see section 6.

## 11. License and attribution

Deployment files: MIT, following the upstream project's `LICENSE`.
Upstream: https://github.com/Ebony-Vinyl/dsh-our-free-model
See `NOTICE.md` for details. This repository is not an official upstream release.
