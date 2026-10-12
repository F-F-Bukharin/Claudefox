Mods

This folder holds mods: small changes to the panel. Improve Claudefox makes them when you ask for one, and you
can write one by hand. An improve run changes only the mods in this folder. The core of Claudefox, everything
else in extension\ and host\, is never changed by it.

A mod is a folder whose name is 2 to 40 lowercase letters, digits or dashes, for example
extension\mods\wider-composer\. It holds:

  panel.js    runs in the panel each time the panel opens, after the panel has loaded
  style.css   styles the panel
  mod.json    optional: {"name": "...", "description": "..."}, shown under Settings, Mods

A new mod starts off: turn it on under Settings, Mods, then Reload panel. (Mods that were already here before this
rule came in kept their state.)

A mod needs panel.js or style.css, or both. Wrap panel.js in (function () { ... })() so its names do not clash with
the panel's or another mod's. Inside it, $('id') finds an element, send(type, extra) messages the background page,
and the variable state holds the panel's current state. Those names belong to the panel: a mod that uses them may
need changing when the panel changes.

A mod that throws an error, or does not load, is turned off, and its error is shown under Settings, Mods. The other
mods keep running. Turn all mods off stops every mod. Check the folder updates the list; a mod is loaded when the
panel opens, so a new or changed mod takes effect after Reload panel.

A mod has the same access as the rest of the add-on. It is not a sandbox: a mod that is on can still break the
panel, and its switch, or Turn all mods off, is how you get back to a working add-on. What lets Claude reach further
needs a yes in the helper's confirm window, a Windows window outside Zen that no mod can answer: Unsafe mode, file
tools, a folder for local pages, a tool that runs a program, and a plugin install.

Mod folders are not in git unless you add them on purpose (git add -f), because they are made on this PC.
Notes on earlier improve runs are kept in %LOCALAPPDATA%\claude-in-zen\memory.
