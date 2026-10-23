#!/bin/bash
# NIR for Mac: builds NIR Wallet and NIR Майнер on this Mac from NIR's open
# source code (docs/install-mac.md). Paste into Terminal:
#
#   curl -fsSL https://nircoin.com/install.sh | bash
#
# What it does, in order, and only what is missing:
#   1. Apple's Command Line Tools (git, compiler): Apple's own install window;
#   2. Node.js, checked against nodejs.org's published SHA-256 sums;
#   3. Python 3.11+ from python.org, accepted only with the Python Software
#      Foundation's Apple signature (asks for the Mac password once);
#   4. NIR's source from GitHub, then builds both apps on this Mac.
# Apps built on this Mac need no Apple developer signature. Nothing is sent
# anywhere; wallet keys are created later, inside NIR Wallet.
set -euo pipefail

NODE_VERSION="26.12.0"
PYTHON_VERSION="3.13.1"
PYTHON_SIGNER="Developer ID Installer: Python Software Foundation"
REPO="https://github.com/Buddhacoin/NIR.git"
BASE="$HOME/Library/Application Support/NIR Install"
SOURCE="$BASE/source"

say() { printf '\n\033[1;32m==\033[0m %s\n' "$1"; }
note() { printf '   %s\n' "$1"; }
fail() { printf '\n\033[1;31mНе получилось:\033[0m %s\n' "$1" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || fail "NIR пока работает только на Mac."
MACOS_MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
(( MACOS_MAJOR >= 13 )) || fail "нужна macOS 13 (Ventura) или новее."
case "$(uname -m)" in
  arm64) NODE_ARCH="arm64" ;;
  x86_64) NODE_ARCH="x64" ;;
  *) fail "этот процессор не поддерживается: $(uname -m)." ;;
esac

printf '\n\033[1mNIR — блокчейн, который майнят решением задач.\033[0m\n'
note "Установщик соберёт NIR Wallet и NIR Майнер прямо на этом Mac."
note "Это тестовая сеть: монеты пока ничего не стоят."
mkdir -p "$BASE"

say "1/4 Инструменты разработчика macOS"
if xcode-select -p >/dev/null 2>&1 && /usr/bin/git --version >/dev/null 2>&1; then
  note "Уже есть."
else
  note "Откроется окно Apple: нажмите «Установить» и дождитесь конца (5–15 минут)."
  xcode-select --install >/dev/null 2>&1 || true
  until xcode-select -p >/dev/null 2>&1 && /usr/bin/git --version >/dev/null 2>&1; do sleep 10; done
  note "Готово."
fi

say "2/4 Node.js $NODE_VERSION"
NODE_DIR="$BASE/node-v$NODE_VERSION-darwin-$NODE_ARCH"
NODE="$NODE_DIR/bin/node"
if [[ "$("$NODE" --version 2>/dev/null || true)" == "v$NODE_VERSION" ]]; then
  note "Уже есть."
else
  TMP="$(mktemp -d)"
  TARBALL="node-v$NODE_VERSION-darwin-$NODE_ARCH.tar.gz"
  curl -fsSLo "$TMP/$TARBALL" "https://nodejs.org/dist/v$NODE_VERSION/$TARBALL"
  curl -fsSLo "$TMP/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  (cd "$TMP" && grep " $TARBALL\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null) \
    || fail "Node.js не прошёл проверку контрольной суммы."
  rm -rf "$NODE_DIR"
  tar -xzf "$TMP/$TARBALL" -C "$BASE"
  rm -rf "$TMP"
  note "Скачан и проверен."
fi

say "3/4 Python 3.11+"
PYTHON=""
for candidate in /Library/Frameworks/Python.framework/Versions/3.1[1-9]/bin/python3.1[1-9] \
    /opt/homebrew/bin/python3 /usr/local/bin/python3; do
  if [[ -x "$candidate" ]] && "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 11))' 2>/dev/null; then
    PYTHON="$candidate"
  fi
done
if [[ -n "$PYTHON" ]]; then
  note "Уже есть: $PYTHON"
else
  TMP="$(mktemp -d)"
  PKG="python-$PYTHON_VERSION-macos11.pkg"
  curl -fsSLo "$TMP/$PKG" "https://www.python.org/ftp/python/$PYTHON_VERSION/$PKG"
  pkgutil --check-signature "$TMP/$PKG" | grep -q "$PYTHON_SIGNER" \
    || fail "установщик Python не подписан Python Software Foundation."
  note "Установщик подписан Python Software Foundation. Введите пароль этого Mac:"
  sudo /usr/sbin/installer -pkg "$TMP/$PKG" -target / >/dev/null
  rm -rf "$TMP"
  PYTHON="/Library/Frameworks/Python.framework/Versions/${PYTHON_VERSION%.*}/bin/python${PYTHON_VERSION%.*}"
  [[ -x "$PYTHON" ]] || fail "Python не установился."
  note "Установлен."
fi

say "4/4 NIR"
if [[ -d "$SOURCE/.git" ]]; then
  git -C "$SOURCE" fetch -q --depth 1 origin main
  git -C "$SOURCE" reset -q --hard origin/main
else
  rm -rf "$SOURCE"
  git clone -q --depth 1 "$REPO" "$SOURCE"
fi
note "Код: $(git -C "$SOURCE" rev-parse --short HEAD)"
APPS="/Applications"
if [[ ! -w "$APPS" ]]; then APPS="$HOME/Applications"; mkdir -p "$APPS"; fi
build() {
  local app="$1" script="$2"
  if [[ -e "$APPS/$app" ]]; then
    note "$app уже установлен. Обновления — в его Настройках."
    return
  fi
  note "Собираю $app (1–3 минуты)…"
  (cd "$SOURCE" && NIR_MINING_PYTHON="$PYTHON" "$NODE" "$script" "$APPS/$app" >/dev/null) \
    || fail "$app не собрался. Запустите команду ещё раз; если не поможет — напишите нам."
}
build "NIR Wallet.app" blockchain/wallet-macos-build.mjs
build "NIR Miner.app" blockchain/mining-macos-build.mjs

printf '\n\033[1;32mГотово!\033[0m NIR Wallet и NIR Майнер — в папке %s.\n' "$APPS"
note "Сначала откроется NIR Wallet: создайте кошелёк и запишите 24 слова на бумагу."
note "Потом в NIR Майнер нажмите «Подключить NIR Wallet» и «Начать майнинг»."
open "$APPS/NIR Wallet.app" || true
