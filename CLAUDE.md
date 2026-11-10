# EdgeDeck — notes for working on the code

A macOS menu-bar app that runs a touch dashboard on the Corsair Xeneon Edge
(14.5", 2560x720 touchscreen) on a Mac. Licensed GPL-3.0.

- Swift (AppKit, WebKit, IOKit HID, ServiceManagement), Swift Package, `swift-tools-version:5.7` (Swift 5 language
  mode; don't bump it).
- Dashboard, editor, Settings and Setup are plain HTML/JS in `Resources/web/`, loaded in WKWebViews.
- Personal notes (your setup, status, what's left to test) go in `CLAUDE.local.md`, which git ignores.

## Building and releasing
- `./build.sh` → `build/EdgeDeck.app`. Ad-hoc signed by default; with `SIGN_ID="Developer ID Application: …"` it's
  signed with the hardened runtime, a timestamp and `Resources/EdgeDeck.entitlements` (apple-events, calendars), so
  TCC grants survive rebuilds and everyday builds match releases. Ad-hoc builds lose TCC grants every time.
- `make-dmg.sh` (SIGN_ID + NOTARY_PROFILE) → `build/EdgeDeck-<version>.dmg`: drag-to-Applications window, signed,
  notarised, stapled. Finder draws icons ~45 pt below their AppleScript position; dot-files are parked off-window.
- Apple Silicon only: the macOS 27 Command Line Tools have no x86_64 Swift compatibility libraries.
- Updates (`Updater.swift`): checks GitHub's latest non-pre-release release (a minute after launch, then daily, if
  `config.updates.autoCheck`); menu bar "Update to EdgeDeck x…" and Settings → Updates. Install = download DMG →
  SHA-256 must match both the release notes' hash and GitHub's asset digest → mount → ditto next to the app →
  signature requirement (Developer ID, same team as the running app, same bundle ID) → spctl "Notarized Developer
  ID" → newer version → replaceItemAt → relaunch. Ad-hoc builds can't self-update. So release notes MUST include the
  DMG's SHA-256. Tested end to end 10 Nov 2026 (0.0.9 → 0.1.0; TCC grants survived).
- Art is drawn in code: `tools/make-icon.swift` (AppIcon.icns), `tools/make-dmg-background.swift`.
- Bundle ID `com.nicparkes.edgedeck`; changing it resets every TCC grant.
- Preview the web UI without the app: open `Resources/web/index.html` (`?mode=edit` for the editor); bridge.js mocks
  every command with sample data.

## Hardware facts
- The Edge runs at 1920x1080 over DisplayPort (macOS won't offer native 2560x720); the dashboard lays out at
  2560x720 and pre-squashes (`device.fixStretch`).
- Touch: single contact only on macOS. Every touch is pointer report ID 7, X 0–16383, Y 0–9599. The panel ignores the
  Device Mode switch (multi-touch was tried and removed, Nov 2026). Calibration is an affine fit in
  `device.calibration` (Settings → Calibrate, or ⌥ Diagnostics).
- If touch is wrong: hold ⌥ while opening the menu bar menu → Diagnostics → Record Next 300 Touch Reports, then read
  the log. The whole Diagnostics submenu only appears while ⌥ is held.
- Touch chip is WCH, bcdDevice 0x0150 (Nov 2026). After a firmware update (only via iCUE on Windows), recheck
  native display modes and whether multi-touch reports appear.

## Architecture
- `TouchReader.swift`: matches the touch controller (default VID 0x27C0, PID 0x0859), opens it with
  `kIOHIDOptionsTypeSeizeDevice` so macOS stops moving the cursor, reads raw input reports.
- `HIDDescriptor.swift`: own HID report-descriptor parser plus `TouchInterpreter`, which turns reports into
  normalised contacts. Supports multi-touch digitizers (including hybrid contact-count mode) and falls back
  to a single absolute pointer report. Other Mac drivers for this panel report X 0–16383, Y 0–9599, with touch
  as Button 1 (usage page 0x09), so expect the pointer fallback to be what's used.
- `Windows.swift`: borderless dashboard window at `.statusBar` level on the Edge screen (found by name "XENEON"
  or a >3:1 aspect ratio); separate editor and Settings windows on the main screen
  (Dock icon only while either is open, `AppWindows`). Touches are sent to the page as
  `EdgeTouch.frame([[id,x,y],...])`, never as mouse events.
- `Bridge.swift`: JS↔Swift messages (`window.webkit.messageHandlers.edge`, replies via `EdgeBridge._reply`).
  Commands: config.get/save, media.state/control/seek, volume.set/mute, action.run, app.icon, apps.list,
  shortcuts.list, status, permissions.accessibility, editor.open, log, system.stats, audio.state/setOutput/setInput/
  micMute, calendar.events, script.run, display.canvas, touch.calibrate, teams.state/action,
  omnifocus.perspectives/view/complete/plan/launch, config.update (one top-level section, or '*' for several), settings.open,
  file.save/open (save/open panels), app.front,
  config.reveal, login.get/set, permissions.open, elgato.list/set, badges.list.
- `Media.swift`: Spotify / Music via AppleScript (only when the app is running), media keys as a fallback.
- `Actions.swift`: open app, run Shortcut, keystrokes (CGEvent, needs Accessibility), URL, shell, AppleScript/JXA.
- `SystemStats.swift`: CPU / memory / network (en* interfaces only) / disk / battery from public APIs; cached 0.9 s.
- `Audio.swift`: CoreAudio device lists, default input/output switching, mic mute (mute control, else input volume 0).
- `CalendarSource.swift`: EventKit upcoming events, meeting join-link detection. Needs Calendars permission.
- `TeamsAXClient.swift` + `TeamsAccessibility.swift`: Teams meeting state/controls via Accessibility (Teams' local
  API was retired 30 Jun 2026, MC1266901). Teams (MSWebView2/Chromium) exposes DOM ids as AXDOMIdentifier once
  AXManualAccessibility is requested; buttons microphone-button / video-button / raisehands-button / share-button /
  hangup-button, state read from their English titles ("Unmute mic", "Turn camera on"…). Polls 1 s, presses with
  AXPress and re-activates the previous app. Confirmed working (Nov 2026). Reactions: press
  reaction-menu-button, then like/heart/applause/laugh/surprised-button in the pop-up (Escape to Teams' pid if it stays
  open); confirmed working (Teams only shows
  reactions while your camera is on). While a pop-up is open Teams hides the toolbar
  from AX, so the meeting is kept alive while the meeting window keeps its title (max 5 min). Teams also re-renders
  its toolbar (cached buttons go stale): EdgeDeck rescans immediately, and a meeting only ends after the Leave
  button has been gone 5 s (the log says why: window closed / retitled). AXManualAccessibility/AXEnhancedUserInterface
  are re-requested on every scan while no meeting is found, because Teams launched after EdgeDeck ignored the first
  request. Teams' labels drift ("Raise your hand" became "Raise"), so state checks match words like "lower"/"stop".
  Raise-hand state: newer Teams never relabels the button; it's in your own video tile's description ("Myself video,
  …, Hand raised …"). With the camera off (solo meeting) there's no tile, so EdgeDeck uses its own last tap.
  A 5 s grace also covers Teams momentarily not being found (seen at EdgeDeck startup).
- Meeting lights (core.js meetingLights): waits up to ~5 s for Elgato discovery, stores which lights it switched on in
  localStorage (edgedeck.meetingLights) so a restart mid-meeting still switches them back off, restores them at
  startup if the meeting ended meanwhile, and logs "Meeting lights: …". Confirmed working.
  Blur: open video-button-configure, read whether the "… blur" AXMenuItem is current (AXValue 1 / mark ✓), press it
  or "No background effect" (shown as "None"), Escape to close. Confirmed working. Diagnostics → Inspect
  Teams Controls logs the tree.
- `Zoom.swift`: `ZoomAXClient` reads/presses Zoom's menu bar (Meeting: Mute/Unmute audio, Start/Stop video, Stop share,
  Record; View: Show/Hide chat; checked on Zoom Workplace 7.2.5). The audio item = in a meeting; a meeting only ends
  after it's been missing 3 s (menus get rebuilt). Leave = window's End/Leave button then "Leave meeting" (never
  "End meeting for all"). `MeetingHub` merges Teams + Zoom: whichever is in a meeting drives `EdgeTeams` (state has
  `app`). Reactions + raise hand: the window's "React" button opens a pop-up ("Menu window") with buttons labelled
  "👍, Option+Command+5", "✋ Raise hand, Option+Y". Zoom hides its toolbar (React, End) until hovered, and hidden
  buttons aren't in the AX tree, so EdgeDeck briefly turns on Window → "Always Show Meeting Controls", presses, and
  turns it back off (shortcuts are a last resort; ⌘W via postToPid didn't work). All confirmed working Nov 2026.
  Blur: "Video options" pop-up has a "Blur my background" checkbox (AXValue 0/1), read then pressed. Confirmed working.
  Diagnostics → Inspect Zoom Menus waits 5 s, then logs (buttons, checkboxes, menu items).
- `OmniFocus.swift`: OmniFocus 4 perspectives. No API returns a perspective's contents, so EdgeDeck keeps its own
  OmniFocus document window parked on the Edge (hidden under the dashboard; recognised by its position), sets its
  perspective name, waits for the content to settle, and reads the content tree via `evaluate javascript` (Omni
  Automation) as JSON. Complete / set plannedDate by task id. Serial queue; Automation permission for OmniFocus.
  Confirmed working on the real panel (Nov 2026): grouping headings (incl. date groups), complete with undo,
  planned-date sheet, newspaper columns on wide widgets. Possible polish: repeat a group heading in a new column.
- `ElgatoLights.swift`: Elgato Key Lights via Bonjour (_elg._tcp, declared in NSBonjourServices) + plain HTTP on 9123
  (/elgato/lights; temperature in mireds 143–344). Tested with Key Light MK.2 (fw 1.0.4). Key Light Air MK.2 uses an
  encrypted protocol and isn't supported. Optional "lights on during meetings" (teams.lightsOn) in core.meetingLights.
- `DockBadges.swift`: Dock badge counts via Accessibility (Dock items' AXStatusLabel).
- `Scripts.swift`: runs AppleScript/JXA via osascript (script on stdin, 20 s timeout); JSON output is parsed.
- Web: `core.js` (config, grid rendering, gestures, pages/swipe), `widgets.js` (registry: key, media,
  ha-entity, ha-camera, clock, label — each has name, size, props, create), `integrations.js` (system, audio, calendar, weather,
  script, timer; weather calls Open-Meteo directly from JS), `omnifocus.js` (perspective widget, 3 s undo on complete,
  planned-date sheet with working-day presets), `teams.js` (EdgeTeams state + Teams widget; a meeting
  starting wakes the Edge and shows the `teams.page` page, returning afterwards), `ha.js` (Home Assistant WebSocket
  client; URL "mock" gives sample entities), `editor.js` (layout editor built from widget `props`;
  saves only `pages`), `elgato.js` (Key Lights widget), `badges.js` (app badges
  widget; editor `checklist` control), `settings.js` (Settings window: sidebar sections, each change saves its config section at once
  via config.update; reuses the editor's form controls through `window.EditorForm`).
- Screen saver (core.js `Saver`): dim / blank after idle, first touch only wakes, 3 px pixel shift every 3 min,
  optional schedule; settings in `config.screensaver`. Menu bar → Blank Edge Now.
- Config v2 (core.js toProfiles/mergeDefaults): `profiles: [{id, name, grid, pages: [{name, widgets, showWhenApps?}]}]`,
  `activeProfile`, `meeting: {name, grid, widgets}` (shown only during meetings, outside profiles; its `teams` widget
  can't be deleted), plus shared sections (theme, device, screensaver, teams, homeAssistant). At runtime `cfg.pages`
  and `cfg.grid` alias the active profile's (never saved; use `forSaving`). v1 configs (top-level pages/grid) are
  migrated on dashboard start: the old meeting page becomes `meeting`. Editor saves via config.update section '*'.
  Pages with `showWhenApps` follow the front app (Swift broadcasts frontAppChanged). Profile files:
  `.edgedeck-profile` {format, version, profile}; backups `.edgedeck-backup` {format, version, config}; imports flag
  Script widgets, shell/AppleScript/JXA keys and non-web URL keys. Menu bar → Profile submenu; key action "Switch profile".
- Setup (`setup.js`, `SetupController`): 7-step first-run window (welcome, connect, Input Monitoring with automatic
  relaunch — only when the touch controller is present but not seized, at most once per 2 min — calibrate,
  integrations checklist with inline permissions, starting layout, done). UserDefaults `setupDone`/`setupStep` (resumes
  after relaunch; existing configs count as done). The Edge shows "Setting up…" via `EdgeDeck.setupProgress`. First run
  replaces the starter layout; re-running adds the chosen layout as a new profile. Templates: `EdgeDeck.buildTemplate`
  (work / minimal / blank, packed by `packPages`); the default config uses Minimal (no unconfigured HA tiles).
  Menu bar → Set Up EdgeDeck…. Input Monitoring is no longer requested at launch until setup is done.
- Config: `~/Library/Application Support/EdgeDeck/config.json`. Log: `~/Library/Logs/EdgeDeck.log`.

## Security (audited Nov 2026)
- `NavigationGuard` (Windows.swift) keeps every web view on bundled files (`WebViewFactory.isOwnPage`); http(s)
  links open in the browser. `Bridge` drops messages not from the main frame of a bundled page.
- Release builds: no `EDGEDECK_WEB` / current-directory web root, Web Inspector only via the `WebInspector` default.
- Home Assistant token: Keychain (service "EdgeDeck", account "homeAssistant.token"). `ConfigStore.save` strips it
  from any config written (a missing key leaves the stored token; empty deletes it); `loadForPage` (config.get)
  adds it back. Old plain-text tokens are migrated on first load, backup included.
- Widgets must escape outside text (`esc()` in each file, or textContent / `h()`). Never put data in innerHTML raw.
- Import review (editor.js `describePages`) flags Script widgets, shell/AppleScript/JXA keys, non-http(s) URL keys.
  Backup restore reuses the current HA token only when the URL matches.
- Don't log meeting/window titles, calendar events, task names or people's names.

## Web UI conventions
- Build DOM with the editor's `h(tag, attrs, ...kids)` (exported as `window.EditorForm.h`); it skips null/false kids.
  `el.replaceChildren(...)` does NOT: it prints null as text. Filter first (setup.js `fill()`).
- Text font sizes in style.css are `calc(<px> * var(--text-scale, 1))`; icon/emoji sizes are not scaled.
- Bridge calls from JS: `EdgeBridge.call(cmd, args)`; anything new needs a case in bridge.js's browser mock too.
- Config writes go through `config.update` (one section or '*'), never whole-config saves (except backup restore and
  the one-off v1→v2 migration), so the editor, Settings and dashboard don't overwrite each other.


## Ideas, not built
- Widgets loaded from `~/Library/Application Support/EdgeDeck/widgets/` as well as bundled ones (folder wins on
  name clash). Must stay inside the security rules above (no code from outside the bundle without review).
- OmniFocus: repeat a group heading at the top of a new column.
