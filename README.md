# DeepSeek Harness Portable Releases

Windows portable release assets and the source for the safe desktop updater.

## Release channels

- `v*` releases contain the existing portable Harness archives and
  `release-manifest.json` files.
- `updater-v*` releases contain the managed desktop launcher
  `DeepSeek-Harness-Updater.exe` and its SHA-256 manifest.

User state, sessions, API credentials, and local secrets are never included in
repository content or release assets.

## Safe updater

The source is in [`updater/`](updater/). The launcher:

1. reads the complete packument from the official npm registry and selects the
   highest published `@deepseek-ai/dsh` RC;
2. installs the exact version into the inactive slot and verifies every
   `@deepseek-ai/dsh*` package plus the root npm integrity digest;
3. checks `dsh-plugin-deepsea-cockpit`,
   `dsh-plugin-session-lifecycle`, and `dsh-plugin-usage-cost` for peer ranges,
   injection points, syntax, and server importability;
4. runs an isolated HTTP boot probe without copying settings, credentials,
   sessions, or secret-like environment variables;
5. creates a local-only backup of `DSH_HOME`, plugins, desktop configuration,
   and launch scripts before the short switch window;
6. switches the `runtime/node_modules` junction atomically, probes the real
   startup path on port 3080, and automatically restores the old slot and local
   backup if activation fails.

Updates are never installed merely because a new version is detected. The user
must explicitly choose the update action from the tray menu.

## Development

```powershell
cd updater
npm ci
npm test
npm run selftest
npm run dist
```

The GitHub Actions workflow builds on pull requests, `main`, and `feature/**`
branches. It publishes only for an `updater-v*` tag or an explicitly confirmed
manual release.
