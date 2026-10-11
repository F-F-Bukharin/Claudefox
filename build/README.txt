Build output. Everything in this folder is made by the scripts in tools\ and is kept out of git
(only this file is).

claude-in-zen.xpi   The add-on, built from extension\ by "Install in Zen.bat" or "Load in Zen.bat". Unsigned.
signed\             Signed builds. Sign with "tools\Sign add-on.bat" (needs your Mozilla API keys, see README.md),
                    or download the .xpi from addons.mozilla.org into this folder.
                    "Install in Zen.bat", the update link in the panel's Settings and "Build friends zip.bat" use
                    the newest .xpi here whose version matches extension\manifest.json. When none matches, they use
                    the unsigned build, which needs about:config -> xpinstall.signatures.required = false.
friends\            The zip to send to friends ("Build friends zip.bat"): Claudefox-v<version>.zip (the add-on is called Claudefox there).
