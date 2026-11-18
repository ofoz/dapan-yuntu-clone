#!/usr/bin/env bash
set -Eeuo pipefail

VERSION=20261118-01
TAG=dapan-cloud-v$VERSION
ASSET=dapan-cloud-docker-$VERSION.tar.gz
REPO=ofoz/dapan-yuntu-clone
RELEASE_URL=https://github.com/$REPO/releases/download/$TAG
ROOT=/opt/dapan-cloud
RELEASE_DIR=$ROOT/releases/$VERSION
IMAGE=dapan-cloud:$VERSION
TMP_DIR=$(mktemp -d /tmp/dapan-cloud-release.XXXXXX)
ARCHIVE=$TMP_DIR/$ASSET
CHECKSUM=$TMP_DIR/$ASSET.sha256

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

if [ "$(uname -m)" != x86_64 ]; then
  echo "此生产包面向 x86_64 服务器；当前架构为 $(uname -m)。" >&2
  exit 1
fi
command -v docker >/dev/null || { echo "未找到 Docker。" >&2; exit 1; }
command -v curl >/dev/null || { echo "未找到 curl。" >&2; exit 1; }
command -v sha256sum >/dev/null || { echo "未找到 sha256sum。" >&2; exit 1; }

if [ -e "$RELEASE_DIR" ]; then
  echo "版本目录已存在，为避免覆盖而停止：$RELEASE_DIR" >&2
  exit 1
fi

echo "下载 GitHub Release: $TAG"
curl --fail --location --retry 3 --silent --show-error "$RELEASE_URL/$ASSET" --output "$ARCHIVE"
curl --fail --location --retry 3 --silent --show-error "$RELEASE_URL/$ASSET.sha256" --output "$CHECKSUM"
(cd "$TMP_DIR" && sha256sum --check "$(basename "$CHECKSUM")")

EXTRACT_DIR=$TMP_DIR/extracted
mkdir -p "$EXTRACT_DIR"
tar -xzf "$ARCHIVE" --strip-components=1 -C "$EXTRACT_DIR"
grep -Fq '"siteUrl": "https://dp.192163.xyz"' "$EXTRACT_DIR/manifest.json"

docker build --tag "$IMAGE" "$EXTRACT_DIR"
mkdir -p "$ROOT/releases"
mv "$EXTRACT_DIR" "$RELEASE_DIR"
mkdir -p "$ROOT"
if [ -f "$ROOT/compose.yaml" ]; then
  cp -a "$ROOT/compose.yaml" "$ROOT/compose.yaml.before-$VERSION"
fi
cp "$RELEASE_DIR/compose.yaml" "$ROOT/compose.yaml"
if [ -f "$ROOT/.env" ]; then
  cp -a "$ROOT/.env" "$ROOT/.env.before-$VERSION"
  ENV_TMP=$(mktemp "$ROOT/.env.XXXXXX")
  awk -v image="$IMAGE" 'BEGIN { updated=0 } /^DAPAN_IMAGE=/ { print "DAPAN_IMAGE=" image; updated=1; next } { print } END { if (!updated) print "DAPAN_IMAGE=" image }' "$ROOT/.env" > "$ENV_TMP"
  mv "$ENV_TMP" "$ROOT/.env"
else
  cat > "$ROOT/.env" <<EOF
DAPAN_IMAGE=$IMAGE
APP_BIND_HOST=127.0.0.1
APP_PORT=3000
MARKET_DATA_PROVIDER=auto
MARKET_CACHE_SECONDS=15
EOF
fi

cd "$ROOT"
docker compose config --quiet
docker compose up -d
healthy=0
for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error http://127.0.0.1:3000/api/heatmap/status; then
    healthy=1
    printf '\n应用健康检查通过，镜像：%s\n' "$IMAGE"
    break
  fi
  sleep 2
done
if [ "$healthy" -ne 1 ]; then
  docker compose logs --tail=100 dapan-cloud || true
  echo "健康检查失败。旧镜像保留，可通过恢复 .env.before-$VERSION 中的 DAPAN_IMAGE 回滚。" >&2
  exit 1
fi
docker compose ps
