Mods

This folder holds mods: small changes to the panel, written by the AI (the self-improve
option) or by hand. The core, everything else in extension\ and host\, is not changed by the AI.

A mod is a folder with lowercase letters, digits and dashes in its name, for example
extension\mods\wider-composer\. It holds:

  panel.js    runs in the panel, after the core has loaded
  style.css   styles the panel
  mod.json    optional: {"name": "...", "description": "..."}

A mod that fails is turned off on its own, and the error is shown under Settings, Mods.
The rest of Claude in Zen keeps running. "Turn all mods off" turns every mod off.
A change to a mod takes effect the next time the panel opens (Settings, Mods, Reload panel).

Mod folders are not in git unless you add them on purpose (git add -f).
