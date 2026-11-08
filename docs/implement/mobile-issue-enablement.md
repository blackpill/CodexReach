# Mobile Issue Auto activation gate

This change permits explicitly enabled pinned Android/iOS projects after CI and group isolation prerequisites. It does not itself modify production environment, Worker allowlists, webhooks or Auto labels.

- Android: `blackpill/BluetoothClicker` (1336698184), Gradle only; JDK 17 and `ANDROID_HOME`/`ANDROID_SDK_ROOT` must be configured for the service. Use Play debug unit tests and unsigned debug build, not release publishing.
- iOS: `blackpill/endoscope-iOS` (1356671174), Swift/Xcode only; run Swift tests and `CODE_SIGNING_ALLOWED=NO` simulator build. No archive/upload/release.
- Both: `previewEnabled:false`, verified `verify` PR/main CI, unique project group, existing global serial execution slot, stable repo ID/remote/path checks and isolated verification worktree. Configured commands are trusted local operator input, not a sandbox.
- Runner boot and Issue binding/notification calls reject duplicate or quarantined group mappings. The final Feishu I/O quarantine guard remains installed and the old shared group remains permanently blocked.
- Do not migrate historical topics or use old shared targets as evidence. New group binding changes must occur only with the runner stopped and backed up. Do not use this as proof of general legacy session ownership repair.

Deployment: retain all existing projects, add mobile projects disabled first, configure toolchains, deploy reviewed code, then expand Worker allowlists and install per-repo webhooks one project at a time. Enable only the current project, inspect delivery and queue identity, and perform owner-approved Auto acceptance to PR/CI/notification readiness before enabling the next. Do not auto-merge or publish apps.
