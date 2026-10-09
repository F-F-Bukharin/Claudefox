Signed builds of Claude in Zen go here.

Get one from addons.mozilla.org: Developer Hub -> Claude in Zen -> Manage Status & Versions ->
pick the version -> download the .xpi file into this folder. (Sign add-on.bat also saves here.)

Install in Zen.bat, the update link in the panel's Settings and Build friends zip.bat use the newest
.xpi in this folder whose version matches extension\manifest.json. When none matches (for example
right after a code change, before the new version is signed), they use an unsigned build instead,
which needs about:config -> xpinstall.signatures.required = false.
