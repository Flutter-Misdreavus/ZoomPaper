#!/usr/bin/env bash
#
# ZoomPaper 一键安装脚本
#
# 从 GitHub Releases 自动下载最新版 .dmg（优先 universal 通用版，
# 其次按机器架构匹配 aarch64 / x64），安装到 /Applications。
# 适用平台：macOS（Apple Silicon / Intel）。
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/Flutter-Misdreavus/ZoomPaper/main/install.sh | sh
#
set -euo pipefail

REPO="Flutter-Misdreavus/ZoomPaper"
APP_NAME="ZoomPaper"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"

# ---------- 获取最新版本 ----------
echo "==> 正在获取最新版本信息 ..."
RELEASE_JSON="$(curl -fsSL "${API_URL}")" || {
  echo "错误：无法访问 GitHub Releases，请检查网络后重试。" >&2
  exit 1
}

TAG="$(printf '%s' "${RELEASE_JSON}" | grep -o '"tag_name": *"[^"]*"' | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/')"
if [ -z "${TAG}" ]; then
  echo "错误：未能解析最新版本号，请确认仓库已发布安装包。" >&2
  exit 1
fi
echo "==> 最新版本：${TAG}"

# ---------- 架构检测 ----------
case "$(uname -m)" in
  arm64)  ARCH="aarch64" ;;
  x86_64) ARCH="x64" ;;
  *)
    echo "错误：不支持的架构 $(uname -m)，ZoomPaper 目前仅支持 macOS。" >&2
    exit 1
    ;;
esac
echo "==> 当前架构：${ARCH}"

# ---------- 已安装版本比对（已最新则跳过） ----------
if [ -d "/Applications/${APP_NAME}.app" ]; then
  INSTALLED="$(defaults read "/Applications/${APP_NAME}.app/Contents/Info" CFBundleShortVersionString 2>/dev/null || true)"
  if [ -n "${INSTALLED}" ] && [ "${INSTALLED}" = "${TAG#v}" ]; then
    echo "==> 已安装最新版本（${TAG}），无需重复安装。"
    exit 0
  fi
fi

# ---------- 解析下载地址 ----------
# 优先通用版（universal，Apple Silicon 与 Intel 通用），其次架构专属包
ALL_DMG_URLS="$(printf '%s' "${RELEASE_JSON}" \
  | grep -o '"browser_download_url": *"[^"]*"' \
  | sed 's/.*"\([^"]*\)"$/\1/' \
  | grep "\.dmg$" || true)"
UNIVERSAL_URL="$(printf '%s\n' "${ALL_DMG_URLS}" | grep "_universal\.dmg$" | head -n 1 || true)"
ARCH_URL="$(printf '%s\n' "${ALL_DMG_URLS}" | grep "_${ARCH}\.dmg$" | head -n 1 || true)"
DMG_URL="${UNIVERSAL_URL:-${ARCH_URL}}"
if [ -z "${DMG_URL}" ]; then
  echo "错误：未找到可用的安装包（${APP_NAME}_*_universal.dmg 或 ${APP_NAME}_*_${ARCH}.dmg）。" >&2
  exit 1
fi

# ---------- 下载 ----------
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT
DMG_PATH="${TMP_DIR}/${APP_NAME}.dmg"

echo "==> 正在下载 ${DMG_URL} ..."
curl -fL --progress-bar "${DMG_URL}" -o "${DMG_PATH}"

# ---------- 安装 ----------
echo "==> 正在挂载并安装到 /Applications ..."
MOUNT_POINT="${TMP_DIR}/mnt"
mkdir -p "${MOUNT_POINT}"
hdiutil attach "${DMG_PATH}" -nobrowse -mountpoint "${MOUNT_POINT}" >/dev/null

if [ -d "/Applications/${APP_NAME}.app" ]; then
  echo "==> 移除旧版本 ..."
  rm -rf "/Applications/${APP_NAME}.app"
fi
cp -R "${MOUNT_POINT}/${APP_NAME}.app" /Applications/
hdiutil detach "${MOUNT_POINT}" >/dev/null

cat <<EOF

==> 安装完成！ZoomPaper ${TAG} 已安装到 /Applications。

由于应用未经过 Apple 签名公证，首次打开方式：
  1. 在「访达」中找到 ZoomPaper.app，右键点击 → 选择「打开」；
  2. 如提示「无法验证开发者」，点击「仍要打开」即可。

或使用终端命令移除隔离标记后直接打开：
  xattr -dr com.apple.quarantine "/Applications/ZoomPaper.app"
EOF
