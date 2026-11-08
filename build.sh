#!/bin/bash
# Builds EdgeDeck.app into ./build. Needs Xcode or the Command Line Tools
# (install with: xcode-select --install).
set -euo pipefail
cd "$(dirname "$0")"

echo "Compiling…"
swift build -c release --arch "$(uname -m)"

APP="build/EdgeDeck.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp ".build/release/EdgeDeck" "$APP/Contents/MacOS/EdgeDeck"
cp Resources/Info.plist "$APP/Contents/Info.plist"
cp -R Resources/web "$APP/Contents/Resources/web"
cp Resources/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

# Ad-hoc signature by default. If you have a signing identity, run
#   SIGN_ID="Developer ID Application: Your Name (TEAMID)" ./build.sh
# so macOS keeps your permission grants between rebuilds. Real identities get the
# hardened runtime and a secure timestamp, as notarisation requires, so everyday
# builds run exactly as a release does.
if [ "${SIGN_ID:--}" = "-" ]; then
    codesign --force --sign - "$APP"
else
    codesign --force --options runtime --timestamp \
        --entitlements Resources/EdgeDeck.entitlements --sign "$SIGN_ID" "$APP"
fi
codesign --verify --strict "$APP"

echo
echo "Built $APP"
echo "Install with:  cp -R $APP /Applications/ && open /Applications/EdgeDeck.app"
