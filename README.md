# Claude in Zen

Personal-use Zen Browser add-on: a Claude panel in Zen's sidebar that can read and act on your tabs.
Not affiliated with or endorsed by Anthropic or Zen.

Plan and decisions: `claude/zen-addon-plan.md` in the Mod Making project.

## Status (v0.2.2)
- Sidebar panel with three pages: **Claude** (chat), **Profile**, **Settings**.
- Sign-in reuses the claude.ai session already open in Zen. It is kept in `storage.session`, so it clears when Zen quits.
- **Stop** cancels pending actions, disconnects the native host and turns file tools off. Nothing else.
- Test tools: `ping`, `tabs_list` (type `/tabs` or `/ping` in the chat).
- Next: native host, chat through Claude Code on the Pro plan, page tools.

## Branches
- `dev`: work in progress. Every change lands here first.
- `main`: versions F has tested and approved.

## Layout
| Path | What it is |
| :- | :- |
| `extension/` | The add-on (Manifest V2, persistent background page). |
| `extension/lib/policy.js` | Fixed safety rules: Google sign-in pages blocked, password/2FA/payment fields refused. |
| `extension/lib/state.js` | Session state and action log in `storage.session`. |
| `extension/background.js` | Sign-in, Stop, native host link, debug-port probe, tool router. |
| `extension/panel.*` | Sidebar UI. |
| `zen-profile/` | `user.js` and `userChrome.css`: sidebar on the right, Claude panel 420 px wide. |
| `build-xpi.ps1` | Packs `extension/` into `claude-in-zen.xpi`. |
| `Load in Zen.bat` | Builds the `.xpi` and opens `about:debugging` with its path copied. |
| `Sign add-on.bat` | Signs the add-on with Mozilla (needs API keys, see below). |

## Try it (temporary install)
1. Double-click **Load in Zen.bat**. It rebuilds `claude-in-zen.xpi` and opens `about:debugging` in Zen.
2. Click **Load Temporary Add-on…**, press **Ctrl+V** in the file name box (the path is already copied), then **Enter**.
3. Open the panel with the toolbar button or **Alt+Shift+C**.

A temporary install is removed when Zen restarts or updates. After a code change, run the .bat again and click **Reload**.

## Keep it installed
Zen's build does not hard-require signed add-ons (its `MOZ_REQUIRE_SIGNING` build constant is `false`), so there are two routes:

- **Quick:** `about:config` → `xpinstall.signatures.required` → **false**. Then `about:addons` → gear icon → **Install Add-on From File…** → `claude-in-zen.xpi`.
  Trade-off: Zen stops checking signatures on add-ons you install by hand from a file. Add-ons from the add-on store are unaffected.
- **Signed:** keeps signature checks on. Get Mozilla API keys (below), run **Sign add-on.bat**, then install the `.xpi` it puts in `signed\`.

To update, install the newer `.xpi` the same way. It replaces the old version in place.

### Mozilla API keys (signed route)
1. Sign in at https://addons.mozilla.org with your Mozilla account, open https://addons.mozilla.org/developers/addon/api/key/ and accept the developer agreement.
2. Click **Generate new credentials**. You get a **JWT issuer** (like `user:12345:678`) and a **JWT secret**.
3. Windows search → "Edit environment variables for your account" → under *User variables* add:
   - `WEB_EXT_API_KEY` = the JWT issuer
   - `WEB_EXT_API_SECRET` = the JWT secret
4. Double-click **Sign add-on.bat**. Each new version needs a higher version number and a new signature.

## Zen profile settings
`zen-profile\user.js` and `zen-profile\userChrome.css` are copied into the Zen profile folder
(`%APPDATA%\zen\Profiles\<profile>\user.js` and `...\chrome\userChrome.css`).
They dock the sidebar on the right and open the Claude panel at 420 px. Zen reads them at startup.
To undo, close Zen and delete both files from the profile.

## Debugging
`about:debugging` → Claude in Zen → **Inspect** → Console:
```js
await cizDebug.call('ping')
await cizDebug.call('tabs_list')
cizDebug.state()
```

## Safety rules (always on)
- Google sign-in pages are hands-off: no reading or acting on them.
- Passwords, 2FA codes and payment details are never typed.
- Text on web pages is treated as untrusted data, never as instructions.
- **Stop** cuts everything off at once.

## Native messaging host
Zen looks the host up at `HKCU\Software\Mozilla\NativeMessagingHosts\claude_in_zen`
(confirmed in Zen's `modules/NativeManifests.sys.mjs`: HKCU first, then HKLM 32-bit and 64-bit).
