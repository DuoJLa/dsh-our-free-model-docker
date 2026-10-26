#!/bin/sh
# One-command deployment for Our Free Model (standalone + Web UI + LAN API).
# Usage:
#   sh install.sh             # build, start, wait for health, print credentials
#   sh install.sh creds       # show the current URLs and tokens
#   sh install.sh status      # docker compose ps
#   sh install.sh logs        # follow logs
#   sh install.sh down        # stop and remove the container
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DOCKER_DIR="$ROOT/docker"
COMPOSE_FILE="$DOCKER_DIR/compose.yaml"
ENV_FILE="$DOCKER_DIR/.env"
CRED_FILE="$DOCKER_DIR/credentials.txt"

say() { printf '%s\n' "$*"; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }

need_docker() {
  command -v docker >/dev/null 2>&1 || die "未找到 docker，请先安装 Docker"
  docker compose version >/dev/null 2>&1 || die "docker compose 不可用（需要 Docker Compose v2）"
  [ -f "$COMPOSE_FILE" ] || die "找不到 $COMPOSE_FILE"
}

require_env() {
  [ -f "$ENV_FILE" ] || die "未找到 docker/.env；请先执行 sh $0"
}

gen_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32 | tr -d '\n'
  elif command -v od >/dev/null 2>&1; then
    od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
  else
    die "无法生成随机令牌：请安装 openssl"
  fi
}

env_value() {
  value=$(sed -n "s/^$1=//p" "$ENV_FILE" | head -n 1 | tr -d '\r')
  case "$value" in
    \"*\") value=${value#\"}; value=${value%\"} ;;
    \'*\') value=${value#\'}; value=${value%\'} ;;
  esac
  printf '%s' "$value"
}

host_ip() {
  candidate=""
  if command -v ip >/dev/null 2>&1; then
    candidate=$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}')
  fi
  if [ -z "$candidate" ] && command -v hostname >/dev/null 2>&1; then
    candidate=$(hostname -I 2>/dev/null | tr ' ' '\n' | awk '/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/{print; exit}')
  fi
  if [ -z "$candidate" ] && command -v ipconfig >/dev/null 2>&1; then
    candidate=$(ipconfig getifaddr en0 2>/dev/null || true)
  fi
  if [ -z "$candidate" ] && command -v ifconfig >/dev/null 2>&1; then
    candidate=$(ifconfig 2>/dev/null | awk '/inet / && $2 != "127.0.0.1" {print $2; exit}')
    candidate=${candidate#addr:}
  fi
  if [ -z "$candidate" ]; then candidate="127.0.0.1"; fi
  printf '%s' "$candidate"
}

public_host() {
  bind=$(env_value OFM_BIND_IP)
  case "$bind" in
    ""|0.0.0.0|"::") host_ip ;;
    *) printf '%s' "$bind" ;;
  esac
}

write_credentials() {
  mgmt=$(env_value OFM_MANAGEMENT_KEY)
  lan=$(env_value OFM_LAN_KEY)
  host=$(public_host)
  {
    echo "# Our Free Model credentials ($(date '+%Y-%m-%d %H:%M:%S'))"
    echo "WebUI: http://$host:8080"
    echo "管理令牌（WebUI 登录）: $mgmt"
    echo "API: http://$host:18901/v1"
    echo "API 令牌（Bearer）: $lan"
  } > "$CRED_FILE"
  chmod 600 "$CRED_FILE"
}

ensure_env() {
  if [ -f "$ENV_FILE" ]; then
    mgmt=$(env_value OFM_MANAGEMENT_KEY)
    lan=$(env_value OFM_LAN_KEY)
    [ -n "$mgmt" ] || die "docker/.env 缺少 OFM_MANAGEMENT_KEY；请补全或删除 .env 后重跑"
    [ -n "$lan" ] || die "docker/.env 缺少 OFM_LAN_KEY；请补全或删除 .env 后重跑"
    say "→ 复用现有 docker/.env"
  else
    say "→ 生成管理令牌与 API 令牌"
    mgmt=$(gen_token)
    lan=$(gen_token)
    bind=${OFM_BIND_IP:-0.0.0.0}
    tz=${TZ:-Asia/Shanghai}
    umask 077
    {
      echo "TZ=$tz"
      echo "OFM_BIND_IP=$bind"
      echo "OFM_MANAGEMENT_KEY=$mgmt"
      echo "OFM_LAN_KEY=$lan"
    } > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  fi
  [ -f "$CRED_FILE" ] || write_credentials
}

wait_health() {
  say "→ 等待健康检查（最多 90 秒）"
  i=0
  status="unknown"
  while [ "$i" -lt 90 ]; do
    cid=$(cd "$DOCKER_DIR" && docker compose ps -q 2>/dev/null | head -n 1)
    if [ -n "$cid" ]; then
      status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || true)
      case "$status" in
        healthy) say "→ 服务健康"; return 0 ;;
        unhealthy|exited|dead) break ;;
      esac
    fi
    i=$((i + 1))
    sleep 1
  done
  (cd "$DOCKER_DIR" && docker compose logs --tail=50) || true
  die "健康检查未通过（status=$status）；查看日志：sh $0 logs"
}

print_card() {
  mgmt=$(env_value OFM_MANAGEMENT_KEY)
  lan=$(env_value OFM_LAN_KEY)
  host=$(public_host)
  say ""
  say "══════════════════════════════════════════"
  say "  部署成功"
  say "  WebUI   : http://$host:8080"
  say "  管理令牌: $mgmt"
  say "  API     : http://$host:18901/v1"
  say "  API 令牌: $lan"
  say "  凭据文件: $CRED_FILE"
  say "  常用命令: sh $0 creds | status | logs | down"
  say "══════════════════════════════════════════"
}

cmd_up() {
  need_docker
  ensure_dockerignore
  ensure_env
  say "→ 构建并启动容器（首次会下载基础镜像）"
  if ! (cd "$DOCKER_DIR" && docker compose up -d --build); then
    (cd "$DOCKER_DIR" && docker compose logs --tail=50) || true
    die "启动失败；查看日志：sh $0 logs"
  fi
  wait_health
  write_credentials
  print_card
}

ensure_dockerignore() {
  if [ ! -f "$ROOT/.dockerignore" ]; then
    cp "$DOCKER_DIR/dockerignore" "$ROOT/.dockerignore"
    say "→ 已创建 .dockerignore"
  elif ! grep -q 'docker/.env' "$ROOT/.dockerignore" 2>/dev/null; then
    say "警告：现有 .dockerignore 未排除 docker/.env / credentials.txt"
  fi
}

cmd_creds() {
  require_env
  [ -f "$CRED_FILE" ] || write_credentials
  print_card
}

cmd_status() {
  need_docker
  require_env
  (cd "$DOCKER_DIR" && docker compose ps)
}

cmd_logs() {
  need_docker
  require_env
  (cd "$DOCKER_DIR" && docker compose logs -f --tail=100)
}

cmd_down() {
  need_docker
  require_env
  (cd "$DOCKER_DIR" && docker compose down)
}

case "${1:-up}" in
  up|install) cmd_up ;;
  creds) cmd_creds ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  down) cmd_down ;;
  *) die "用法：sh $0 [up|creds|status|logs|down]" ;;
esac
