# Claude in Zen

Personal-use Zen Browser add-on: a Claude panel in Zen's sidebar that can read and act on your tabs,
running on your own Claude plan through Claude Code.
Not affiliated with or endorsed by Anthropic or Zen.

Plan, decisions and TODO: `claude/zen-addon-plan.md` in the Mod Making project.
Friends: see `START HERE.txt` (it ships in the friends zip).

## Status (v0.5.0)
- **Chat** with Claude in the panel, streamed, with a chip for each tool it uses and a Cancel link.
  Follow-ups continue the conversation; `/clear` starts a new one.
- **Speed / Quality** button under the message box: Speed is Haiku 5.5, Quality is Opus 5.5, both on high effort.
  In Speed, the small **Speed Plus** button switches Haiku 5.5 to max effort and turns the Speed button purple.
  The line under the message box says what the next message runs on, and each reply shows the model and effort it
  actually ran with.
- **Update from Settings**: the Add-on row shows the installed version and the one in your project folder; **update**
  has the helper rebuild the add-on and hand it to Zen's install prompt. The leftover `.xpi` tab closes on its own.
- **Page tools**: list, open, switch and close tabs; navigate; read the page outline (with element refs) or its text;
  find, click (by ref, selector, or x and y from a screenshot, with real pointer events), fill, press keys, scroll,
  wait for something, play/pause/seek video and audio, screenshot.
- Claude works on the **current tab** (it is told which one with every message) and leaves your other tabs out of it
  unless you ask about them.
- **File tools** (Settings, off by default): one folder, Read only (Read, Glob, Grep) or Read and write (adds Edit, Write).
  Never a shell.
- **Accounts**: the chat spends the Claude Code account of the add-on's own profile, shown in Settings, with a warning
  when it differs from the claude.ai account in Zen. On a usage limit the panel offers "Log out and add another account"
  (also the **switch** link in Settings).
- **Sign-in is remembered**: after the first Sign in, Zen signs the panel back in on its own at startup by checking
  the claude.ai session again (only email, name and account id are kept, never cookies). It ends when you sign out
  in the panel or on claude.ai.
- **First-run guide** on the empty chat page until the helper, Claude Code and both sign-ins are ready.
- Test commands that need no Claude: `/tabs`, `/ping`, `/help`.

## How it fits together
```
panel  <->  background page  <->  helper (native messaging host, started by Zen)
                                     |  runs "claude -p" per message, on its own Claude Code profile
                                     v
                               Claude Code  ->  Zen tool server (MCP, host/zen-mcp.js)
                                                   |  named pipe, per-session token
                                                   v
                                                 helper  ->  background page  ->  tab
```

## Rules (always on)
- Google sign-in pages and non-web pages (`about:`, `file:`) are never read or touched.
- Passwords, 2FA codes and payment details are never typed; those fields are refused.
- Text on web pages is untrusted data, wrapped as such, never instructions.
- No "ask before doing" step for now. Later, only actions flagged as Important will ask first.
- **Stop** cuts everything at once: page actions, the running answer and its Claude Code process, the helper,
  any sign-in window, and file tools.
- API-key and third-party-provider variables are stripped, so usage always runs on the signed-in plan.

## Branches and commits
- `dev`: work in progress. Every finished addition is its own commit here.
- `main`: versions F has tested and approved.

## Layout
| Path | What it is |
| :- | :- |
| `extension/` | The add-on (Manifest V2, persistent background page). |
| `extension/lib/policy.js` | Fixed rules: blocked pages, sensitive fields. |
| `extension/lib/state.js` | Session state and action log in `storage.session` (cleared when Zen quits; the sign-in marker lives in `storage.local`). |
| `extension/lib/tools.js` | The tools Claude uses on Zen; page code runs in the add-on's isolated content-script world. |
| `extension/background.js` | Sign-in, Stop/Start, helper link, chat relay, account switch, tool router. |
| `extension/panel.*` | Sidebar UI. |
| `host/claude-in-zen-host.js` | The helper: native messaging, pipe server, Claude Code chat turns, account switch. |
| `host/zen-mcp.js`, `host/lib/tools.js` | The Zen tool server (MCP over stdio) and its tool catalog. |
| `host/install.ps1` | Registers the helper with Zen for this Windows user (no admin). |
| `zen-profile/` | `user.js` and `userChrome.css` (sidebar on the right, Claude panel about 660 px wide) and `apply.ps1`, which merges them into the Zen profile. |
| `test/`, `host/test/` | Tests; `Run tests.bat` or `node test/run-all.js` runs them all. |

| Script | What it does |
| :- | :- |
| `Install helper.bat` | Installs the helper. Run it yourself: installs made from the Claude desktop app land in its private copy of AppData, which Zen can't see. |
| `Sign in Claude Code.bat` | Signs the add-on's Claude Code profile (`%LOCALAPPDATA%\claude-in-zen\claude`) in. Separate from Claude Code in VS Code or a terminal. |
| `Link add-on to Zen.bat` | **Best for development.** Close Zen first. Points Zen at `extension\` in this folder, so **update** in Settings reloads add-on and helper in one click: no `.xpi`, no install prompt, no restart. Undo with `zen-profile\link.ps1 -Unlink`. |
| `Install in Zen.bat` | Builds the `.xpi` (or picks the newest signed one) and opens it in Zen for a permanent install. Run it again to update. |
| `Load in Zen.bat` | Builds the `.xpi` and opens `about:debugging` with its path copied (temporary install). |
| `Sign add-on.bat` | Signs the add-on with Mozilla (needs API keys, see below). |
| `Build friends zip.bat` | Builds `dist\claude-in-zen-friends-v<version>.zip`, using a signed `.xpi` from `signed\` if there is one. |
| `Apply Zen settings.bat` | Close Zen first. Merges the `zen-profile` settings into your Zen profile between marker lines; `apply.ps1 -Remove` undoes it. |
| `Run tests.bat` | Runs all tests. |

## Try it (temporary install)
1. Double-click **Load in Zen.bat**. It rebuilds `claude-in-zen.xpi` and opens `about:debugging` in Zen.
2. Click **Load Temporary Add-on…**, press **Ctrl+V** in the file name box, then **Enter**.
3. Open the panel with the toolbar button or **Alt+Shift+C**, and follow the checklist on the chat page.

A temporary install is removed when Zen restarts. After a code change, click **Reload** in `about:debugging` (temporary install) or **update** in Settings (permanent install).
Helper changes apply the next time Zen starts it: press Stop, then Start.

## Keep it installed
Zen's build does not hard-require signed add-ons (`MOZ_REQUIRE_SIGNING` is `false`), so there are two routes:

- **Quick:** `about:config` → `xpinstall.signatures.required` → **false**. Then double-click **Install in Zen.bat**
  (or `about:addons` → gear icon → **Install Add-on From File…** → `claude-in-zen.xpi`). Trade-off: Zen stops checking signatures on add-ons you install
  from a file. Store add-ons are unaffected.
- **Signed:** keeps signature checks on. Get Mozilla API keys (below), run **Sign add-on.bat**, then install the `.xpi`
  it puts in `signed\`.

### Mozilla API keys (signed route)
1. Sign in at https://addons.mozilla.org, open https://addons.mozilla.org/developers/addon/api/key/ and accept the agreement.
2. Click **Generate new credentials** to get a **JWT issuer** and a **JWT secret**.
3. Windows search → "Edit environment variables for your account" → add `WEB_EXT_API_KEY` (issuer) and
   `WEB_EXT_API_SECRET` (secret).
4. Double-click **Sign add-on.bat**. Each new version needs a higher version number.

## Debugging
- Settings → Action log shows every action, chat turn and error. **check** re-reads the Claude Code account.
- Helper and tool server logs (metadata only, never page content): `%LOCALAPPDATA%\claude-in-zen\logs\`.
- `about:debugging` → Claude in Zen → **Inspect** → Console: `await cizDebug.call('tabs_list')`, `cizDebug.state()`.
- Zen finds the helper at `HKCU\Software\Mozilla\NativeMessagingHosts\claude_in_zen`.
