Claude in Zen: the output folder (no longer used)

Files Claude makes and that Settings > Saving files stores ("Store in output folder") now go to %LOCALAPPDATA%\claude-in-zen\output, in Claude in Zen's data folder. Each file keeps its name. A name that is already taken gets " (2)", " (3)" and so on, so nothing is overwritten.

This folder is no longer used. When the helper starts, any files still here (except this README) are moved to the new place, with a number added on a name clash.

"Download now" is the default. It saves to Downloads\Claude in Zen, as before. If the helper is not running, or a file cannot be stored, the file is downloaded instead and the log says why.

Git keeps only this README; the files themselves are not committed.
