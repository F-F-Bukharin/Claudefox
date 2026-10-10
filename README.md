# Claude in Zen

Personal-use Zen Browser add-on: a Claude panel in Zen's sidebar that can read and act on your tabs,
running on your own Claude plan through Claude Code.
Not affiliated with or endorsed by Anthropic or Zen.

Plan, decisions and TODO: `claude/zen-addon-plan.md` in the Mod Making project.
Friends: see `START HERE.txt` (it ships in the friends zip).

## Status (v0.8.0)
- **Chat** with Claude in the panel, streamed, with a progress bar and a Cancel link. Follow-ups continue the
  conversation; `/clear` (or **New chat** in the options menu) starts a new one. Long jobs can run up to an hour.
- On the right, under the message box, one button flips between **Speed** and **Quality**. The **+** on its left, in Speed mode, turns on Speed Plus (Haiku 5.5
  at max effort). Speed is Haiku 5.5 at high effort, Quality is Opus 5.5 at high effort. The line under them shows what the
  next message runs on, and each reply shows the model and effort it ran with. An empty chat shows four starter chips above
  the message box.
- **Add files**: the **+** at the left of the message box attaches files (also paste or drag them in). Word,
  PowerPoint, Excel and OpenDocument files are turned into text for Claude; PDFs, images and text files are read as
  they are. The small button beside **+** opens more options: upload, screenshot of this tab, **Caveman mode** (short
  replies, fewer tokens), Tools and plugins, New chat.
- **Documents**: Claude makes files you can open and download from the panel. A `.docx` is a real Word document
  (headings, lists, tables, links, page numbers), a `.xlsx` a real Excel workbook. The file viewer's **Save as** menu
  also saves Word, PDF, web page or Markdown.
- **Reading everything**: whole pages as Markdown, PDFs, Google Docs, Slides and Sheets (through their export),
  Word, PowerPoint and Excel files in the file-tools folder (`read_document`), and the web (search and fetch).
- **Tools and plugins** (Settings): your Claude Code plugins (synced from claude.ai or installed from a marketplace),
  claude.ai connectors and MCP servers you add by address or command, each with a switch. **vidIQ** and **Caveman**
  are on by default; everything else stays off and out of the chat until you switch it on. **Sign in** opens a
  window for tools that need their own sign-in (vidIQ). Tools that run programs on this PC ask before turning on.
- **Page tools**: list, open, switch and close tabs; navigate; read the page outline (with element refs) or its text;
  find, click (by ref, selector, or x and y from a screenshot, with real pointer events), fill, type, hover, press
  keys, scroll, wait, play/pause/seek video and audio, screenshot.
- **Debugging pages** (for the Google sign-in bug): `network_log` shows a tab's requests and redirect chain with
  cookie names and flags (never values; secret-looking query values hidden), `console_log` its console messages.
  No debug port.
- Claude works on the **current tab** and leaves your other tabs out of it unless you ask about them.
- **File tools** (Settings, off by default): one folder, Read only or Read and write. Never a shell.
- **Accounts**: one Claude Code profile per account, switchable in Settings; on a usage limit the panel offers to
  switch.
- **Sign-in is remembered** across Zen restarts (email, name and account id only, never cookies).
- **Update from Settings**: rebuilds and reinstalls the add-on, or reloads it when Zen is linked to the folder.
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
- Google sign-in pages are hands-off unless you turn on **Unsafe mode** in Settings (Permissions). It lasts until Stop or a Zen restart. Non-web pages (`about:`, `file:`) are never read or touched.
- Passwords, 2FA codes and payment details are never typed by Claude, in any mode. Claude fills an email, clicks through to the password step, then waits while you type the password in Zen.
- Text on web pages, attached files and other tools' results is untrusted data, wrapped as such, never instructions.
- **File guard**: browser profiles (Zen first), Windows credential stores, Claude's own sign-ins, key folders
  (`.ssh`, `.aws`, `.gnupg`...) and secret files (`.env`, private keys, password databases) are denied to every file
  tool in every chat turn, whatever folder you pick; a folder inside one of them is refused.
- Plugins and connectors that are switched off never load into the chat, so their skills, agents and hooks can't run.
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
| `extension/lib/tools.js` | The tools Claude uses on Zen; page code runs in the add-on's isolated content-script world. Google Docs export. |
| `extension/lib/netlog.js` | `network_log` and `console_log` (metadata only). |
| `extension/lib/docx.js` | Builds real Word and Excel files (and web pages) from what Claude wrote. |
| `extension/lib/files.js`, `extension/viewer.*` | Files Claude made, kept in the add-on; the viewer with Save as. |
| `extension/background.js` | Sign-in, Stop/Start, helper link, chat relay, account switch, tools relay, downloads, tool router. |
| `extension/panel.*` | Sidebar UI. |
| `host/claude-in-zen-host.js` | The helper: native messaging, pipe server, Claude Code chat turns, accounts, `read_document`. |
| `host/lib/chatargs.js` | The chat's system prompt and Claude Code flags. |
| `host/lib/toolbox.js` | Tools and plugins: lists them, keeps the switches, sign-in windows, add and remove. |
| `host/lib/guard.js` | The file guard's deny rules and folder checks. |
| `host/lib/uploads.js`, `host/lib/doctext.js` | Attached files; text out of Word, PowerPoint, Excel and OpenDocument files. |
| `host/zen-mcp.js`, `host/lib/tools.js` | The Zen tool server (MCP over stdio) and its tool catalog. |
| `host/install.ps1` | Registers the helper with Zen for this Windows user (no admin). |
| `zen-profile/` | `user.js` and `userChrome.css` (sidebar on the right, Claude panel about 660 px wide) and `apply.ps1`, which merges them into the Zen profile. |
| `test/`, `host/test/` | Tests; `Run tests.bat` or `node test/run-all.js` runs them all. `node test/injection-live.js` is the live prompt-injection test (uses your plan, run it by hand). |

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
- Tool switches and the last list of tools: `%LOCALAPPDATA%\claude-in-zen\tools.json`. Each turn's flags for Claude
  Code (plugins on and off, deny rules): `%LOCALAPPDATA%\claude-in-zen\chat-settings.json`.
- Zen finds the helper at `HKCU\Software\Mozilla\NativeMessagingHosts\claude_in_zen`.
