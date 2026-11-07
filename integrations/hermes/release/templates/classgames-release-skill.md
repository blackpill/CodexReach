---
name: classgames-manual-release
description: Prepare and inspect ClassGames releases; real human confirmation is verified independently.
---
Use only `python -m integrations.hermes.release.cli` with fixed project `classgames`.
- `prepare --project classgames`
- `locate-confirmation --release-id ID`
- `confirm --release-id ID --message-id ID`
- `status --release-id ID`, `reconcile --release-id ID`
- `prepare-rollback --project classgames --version-id ID` (known healthy history only)
- `cancel --release-id ID` (PREPARED only)
Never read service keys, use arbitrary shell deployments, assume a chat sender has release authority, or construct a fake confirmation. Never substitute the CodexReach development chat for the management chat. Do not say deployed without control-plane and health evidence. Show the complete target SHA, baseline version and unknown-diff warning exactly. Missing authority/credentials is a stop, not an excuse to fall back to root gh/wrangler. Production enablement, infrastructure setup and real production deployment require separate approval.
