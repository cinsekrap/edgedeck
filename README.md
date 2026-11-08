# EdgeDeck

A dashboard for the Corsair Xeneon Edge on macOS, standing in for iCUE.

- **Touch that works on a Mac.** EdgeDeck takes exclusive control of the Edge's touch controller, so touching the screen no longer moves your cursor; touches go straight to the dashboard. A calibration screen lines them up.
- **A widget dashboard** on the Edge, with pages you swipe between and a layout editor on your main screen.
- **Widgets:**
  - **Keys**, Stream Deck-style: open an app, run a Shortcut, send a keyboard shortcut, open a URL, run a shell command or AppleScript/JXA, switch profile.
  - **Now Playing** for Spotify and Apple Music, with seek and volume.
  - **System stats**: CPU, memory, network, disk and battery.
  - **Audio**: microphone mute, or output/input device switchers.
  - **Calendar**: upcoming events from every calendar account on the Mac, with a **Join** button for meeting links.
  - **Weather** from Open-Meteo (no account needed).
  - **OmniFocus**: any perspective, as it looks in OmniFocus. Tick tasks off and set planned dates from the Edge.
  - **Elgato Key Lights**: power, brightness and colour temperature, found automatically on your network.
  - **App badges**: unread counts from the Dock (Mail, Outlook, Slack, WhatsApp…), with your own labels.
  - **Home Assistant** entities and cameras.
  - **Script**: shows the result of an AppleScript or JXA script. Also a clock, text labels and a timer/stopwatch.
- **Meeting controls for Microsoft Teams and Zoom:** mute, camera, background blur, raise hand, reactions, chat, stop sharing and leave, showing live state. When a meeting starts, the Edge wakes and switches to the meeting page (optionally turning your Key Lights on), then goes back afterwards. Works through Accessibility, so it needs that permission.
- **Profiles** of pages, with export/import, plus pages that appear automatically when a given app is in front.
- **Screen saver** to protect the panel from burn-in: dims, then blanks, after a while idle, with a pixel shift and an optional schedule.
- **Settings window, first-run setup** and a global text size.

## Install

Download the latest DMG from [Releases](https://github.com/cinsekrap/edgedeck/releases), open it and drag EdgeDeck into Applications. It needs an Apple Silicon Mac running macOS 12 or later. **Set Up EdgeDeck** walks you through connecting the Edge and the permissions it needs.

## Build from source

To build it yourself, you need Xcode or the Command Line Tools (`xcode-select --install`). Then:

```bash
cd edgedeck
./build.sh
cp -R build/EdgeDeck.app /Applications/
open /Applications/EdgeDeck.app
```

The app runs from the menu bar (the icon with three panels). It has no Dock icon unless the editor is open.

The first build is unsigned, so macOS may block it the first time. If it does, go to **System Settings → Privacy & Security** and click **Open Anyway**.

## Releasing a DMG

```sh
SIGN_ID="Developer ID Application: Your Name (TEAMID)" NOTARY_PROFILE=EdgeDeck ./make-dmg.sh
```

This builds the app with the hardened runtime (entitlements in `Resources/EdgeDeck.entitlements`), makes `build/EdgeDeck-<version>.dmg` with a drag-to-Applications window, signs it, notarises it and staples the ticket. The version comes from `CFBundleShortVersionString` in `Resources/Info.plist`. Notarisation needs a one-off credentials setup:

```sh
xcrun notarytool store-credentials EdgeDeck --apple-id <your Apple ID> --team-id <TEAMID>
```

It asks for an app-specific password (appleid.apple.com → Sign-In and Security → App-Specific Passwords). Builds are Apple Silicon only: the macOS 27 toolchain no longer ships Intel Swift libraries. The window art comes from `tools/make-dmg-background.swift`.

## Permissions

| Permission | Why | Where |
|---|---|---|
| **Input Monitoring** | Needed to read the touch controller and stop it moving the cursor | Prompted on first launch. Once you've granted it, **quit and reopen EdgeDeck**. |
| **Accessibility** | Needed for keys that send keyboard shortcuts, and the media-key fallback | Prompted the first time a key sends a shortcut, or use menu bar → Permissions |
| **Automation** (Spotify, Music, and any app a Script widget or key controls) | Needed to read what's playing, control playback, and run scripts that talk to other apps | macOS asks the first time for each app |
| **Calendars** | Needed for the Calendar widget | macOS asks the first time a Calendar widget loads |
| **Local Network** | Needed to reach Home Assistant | macOS asks the first time |

The build is ad-hoc signed, so every rebuild counts as a new app to macOS and you'll need to grant Input Monitoring and Accessibility again. If you have an Apple Development certificate, run `SIGN_ID="Apple Development: …" ./build.sh` and your grants will carry over between builds.

## Connections

The Edge needs both video and USB data. A single USB-C cable carries both. If you use HDMI for video, you also need a USB cable for touch.

## Home Assistant

Open the editor, click **Settings**, and enter:

- URL, e.g. `http://homeassistant.local:8123` (or your Home Assistant VM's IP address)
- A long-lived access token (Home Assistant → your profile → Security → Long-lived access tokens). EdgeDeck keeps it in your login Keychain, not in the config file.

When it connects, entity fields in the editor give you a list of your entities to pick from. The dashboard talks to Home Assistant over its WebSocket API, so you don't need any CORS settings.

Entity tiles behave like this:

- **Tap** toggles lights, switches, fans, covers and input booleans. It also runs scenes and scripts, and presses buttons.
- **Lights** in tiles two or more columns wide get a brightness slider.
- **Locks** lock on a tap, but unlocking needs a press and hold (you can turn this off per tile).
- **Camera** tiles refresh every few seconds. Tap one to see it full screen, and tap again to close it.

If you set the URL to `mock`, you get sample entities, which is handy for trying out layouts.

## Keys

Each key can do one of these:

- open an app
- run a Shortcut
- send a keyboard shortcut (`cmd+shift+4`, `ctrl+up`, `cmd+alt+f13`, …)
- open a URL
- control media or volume
- call a Home Assistant service (`light.toggle` plus an entity)
- run a shell command
- jump to a page

A key can also light up when a Home Assistant entity is on.

## If touch doesn't line up

- In Settings, turn on **Show touch points** to see where each touch lands. Use **Flip** or **Swap X and Y** if the Edge is mounted rotated.
- Hold **⌥ Option** while opening the menu bar menu, then Diagnostics → **Record Next 300 Touch Reports**, touch the screen, then **Open Log**. The log has a summary of the touch controller and the raw reports, which is what's needed to fix a parsing problem.
- The default USB IDs are vendor `0x27C0`, product `0x0859`. If your unit reports different ones, add `"vendorId"` and `"productId"` to the `device` section of the config file (Settings → Show config file in Finder).

## Files

- Config: `~/Library/Application Support/EdgeDeck/config.json` (each save keeps the previous version as `config.backup.json`)
- Log: `~/Library/Logs/EdgeDeck.log`
- To preview the dashboard in a browser without the app, open `Resources/web/index.html`. Add `?mode=edit` for the editor. The preview uses sample data.

## Security

EdgeDeck holds a lot of access to your Mac (Accessibility, Input Monitoring, control of Teams, Zoom and OmniFocus) and can run commands you set up. This is how that's kept in check:

- **Only its own pages.** The dashboard, editor and settings are local HTML pages inside the signed app. They can't navigate anywhere else: web links open in your browser. The Mac side ignores messages from anything other than those pages. Release builds don't load pages from anywhere outside the app bundle.
- **Outside text is shown as text.** Calendar events, OmniFocus tasks, Home Assistant names, app names and weather are inserted as plain text, never as HTML.
- **Imports are reviewed.** Importing a profile or restoring a backup lists every Script widget, shell/AppleScript/JavaScript key and non-web URL key in it before anything is added. A backup without a Home Assistant token only reuses yours if it points at the same server.
- **Secrets.** The Home Assistant token lives in the Keychain. Exported backups leave it out unless you choose to include it, and profile exports never contain it.
- **The log** (`~/Library/Logs/EdgeDeck.log`) records what EdgeDeck did, not what's in your meetings, calendar or tasks.

Things to know:

- Anything that can change your config file can add keys or Script widgets that run commands as you, with EdgeDeck's permissions. Only import profiles you trust, and read the review list.
- Elgato Key Lights have no authentication: anything on your network can control them. That's how the lights work, not something EdgeDeck can change.
- Use an `https://` Home Assistant URL if you connect from outside your home network. Over plain `http://`, the token travels unencrypted.
- For debugging the web pages in a release build: `defaults write com.nicparkes.edgedeck WebInspector -bool YES`, then restart EdgeDeck (right-click a page → Inspect Element).

## How it fits together

```
Xeneon Edge touch (USB HID) ──▶ TouchReader (IOKit, seized) ──▶ HID descriptor parser
                                                               │ normalised contacts
                                                               ▼
           WKWebView dashboard on the Edge ◀── EdgeTouch.frame() ── DashboardController
               │  EdgeBridge (postMessage)
               ▼
           Bridge.swift ──▶ Media (AppleScript) · Actions (apps, Shortcuts, keys, shell) · Config
               │
           Home Assistant ◀── WebSocket from the page
```

## Licence

EdgeDeck is free software, released under the [GNU General Public License v3.0](LICENSE). Copyright © 2026 Nic Parkes.

EdgeDeck isn't affiliated with Corsair, Microsoft, Zoom, Elgato or The Omni Group. Xeneon is a trademark of Corsair.
