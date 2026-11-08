#!/bin/bash
# Builds a signed (and, with NOTARY_PROFILE, notarised and stapled) DMG:
#   build/EdgeDeck-<version>.dmg, with a drag-to-Applications window.
#
#   SIGN_ID="Developer ID Application: Your Name (TEAMID)" NOTARY_PROFILE=EdgeDeck ./make-dmg.sh
#
# One-off setup for notarisation (stores an app-specific password in your Keychain):
#   xcrun notarytool store-credentials EdgeDeck --apple-id <your Apple ID> --team-id <TEAMID>
# Without NOTARY_PROFILE the DMG is signed but not notarised (fine for your own Macs).
set -euo pipefail
cd "$(dirname "$0")"

: "${SIGN_ID:?Set SIGN_ID to your Developer ID Application identity}"
case "$SIGN_ID" in "Developer ID Application:"*) ;; *) echo "SIGN_ID must be a Developer ID Application identity to distribute"; exit 1 ;; esac

VERSION=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" Resources/Info.plist)
VOLUME="EdgeDeck"
APP="build/EdgeDeck.app"
DMG="build/EdgeDeck-$VERSION.dmg"
RW="build/EdgeDeck-rw.dmg"
STAGE="build/dmg"

./build.sh
SIGNATURE=$(codesign -dv "$APP" 2>&1)
case "$SIGNATURE" in *"(runtime)"*) ;; *) echo "The app isn't signed with the hardened runtime"; exit 1 ;; esac

echo "Staging…"
rm -rf "$STAGE" "$RW" "$DMG"
mkdir -p "$STAGE/.background"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
cp Resources/dmg-background.tiff "$STAGE/.background/background.tiff"

# A volume with the same name already mounted would get the layout instead.
if [ -d "/Volumes/$VOLUME" ]; then hdiutil detach "/Volumes/$VOLUME" -quiet || true; fi

hdiutil create -volname "$VOLUME" -srcfolder "$STAGE" -fs HFS+ -format UDRW -ov "$RW" -quiet
MOUNT=$(hdiutil attach -readwrite -noverify -noautoopen "$RW" | grep -o '/Volumes/.*$' | head -1)

echo "Laying out the window…"
# Finder writes the layout into the volume's .DS_Store. Needs Automation permission
# for your terminal to control Finder; without it the DMG still works, just unstyled.
if ! osascript <<EOF
tell application "Finder"
    tell disk "$VOLUME"
        open
        set current view of container window to icon view
        set toolbar visible of container window to false
        set statusbar visible of container window to false
        -- 640 x 400 content plus the title bar.
        set the bounds of container window to {200, 120, 840, 552}
        set opts to the icon view options of container window
        set arrangement of opts to not arranged
        set icon size of opts to 128
        set text size of opts to 13
        set background picture of opts to file ".background:background.tiff"
        -- Finder draws an icon about 45 pt below its position; these put the icons'
        -- centres on the arrow's line (y 190 in the background).
        set position of item "EdgeDeck.app" of container window to {160, 145}
        set position of item "Applications" of container window to {480, 145}
        -- People who show hidden files would see .background and .fseventsd on top
        -- of the artwork: park them out of sight below the window.
        repeat with f in (every item of container window whose name starts with ".")
            set position of f to {320, 900}
        end repeat
        close
        open
        update without registering applications
        delay 1
        close
    end tell
end tell
EOF
then
    echo "warning: couldn't lay out the DMG window (allow your terminal to control Finder)"
fi
chmod -Rf go-w "$MOUNT" || true
sync
hdiutil detach "$MOUNT" -quiet || { sleep 2; hdiutil detach "$MOUNT" -force -quiet; }

echo "Compressing…"
hdiutil convert "$RW" -format UDZO -imagekey zlib-level=9 -o "$DMG" -quiet
rm -f "$RW"
rm -rf "$STAGE"

codesign --force --timestamp --sign "$SIGN_ID" "$DMG"

if [ -n "${NOTARY_PROFILE:-}" ]; then
    echo "Notarising (usually a few minutes)…"
    xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$DMG"
    xcrun stapler validate "$DMG"
    spctl --assess --type open --context context:primary-signature --verbose "$DMG"
else
    echo "Not notarised (set NOTARY_PROFILE to notarise). Other Macs will refuse to open it."
fi

echo
echo "Built $DMG"
