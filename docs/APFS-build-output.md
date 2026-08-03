# macOS build output must land on APFS (not exFAT)

> **Obsolete as of Aug 2026.** `/Volumes/Callisto` is APFS now, so the output
> redirect described below was REMOVED — mac builds land in the project's own
> `dist-electron/` again, which is what `scripts/publish-app.js` reads
> (`pkg.build.directories.output`, resolved against the project root). This page
> is kept as the diagnosis, in case the working copy ever moves back to a
> non-native filesystem.

## Why (the exFAT failure)

When this project's working copy lived on an exFAT volume: exFAT cannot store a
file's extended attributes inline, so macOS writes them to `._`-prefixed
**AppleDouble** sidecar files. When electron-builder codesigns the `.app`, the
signature seals those xattrs. The signature then verifies fine locally, but when
`@electron/notarize` zips the app for Apple, the `._` companions don't survive
the round-trip — so Apple's notary service re-checks the binaries, finds the
sealed xattrs missing, and rejects the submission with:

```
"The signature of the binary is invalid."   (status: Invalid)
```

Confirmed directly: writing an xattr to a file on exFAT creates a `._` companion;
on APFS it's stored inline with no companion.

## The fix that was used

Only the packaged `.app`/DMG **assembly** needs native-FS fidelity — the source
could stay on Callisto. So the mac package/publish scripts redirected only
electron-builder's **output** to an APFS location under `$HOME`:

```
electron-builder --mac --arm64 ... -c.directories.output=$HOME/Projects/Briefcase-builds
```

> Note: an earlier attempt symlinked `dist-electron` itself to APFS. That breaks,
> because electron-builder's asar packer doesn't traverse the top-level symlink
> to collect the app's input files ("entry file main.js does not exist"). In this
> repo `dist-electron` holds both inputs and output, so only the *output* may be
> redirected — hence `-c.directories.output`, not a symlink.

## Where artifacts land (today)

```
dist-electron/
  ├── mac-arm64/Briefcase.app
  ├── mac/Briefcase.app            (x64)
  └── Briefcase-<version>*.dmg
```

## Build commands

```bash
npm run package:mac:signed     # Developer ID signed + Apple notarized
npm run package:mac            # unsigned / no notarization (fast local)
```
