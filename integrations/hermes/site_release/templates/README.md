# Templates only — not installed

Do not install services or create permissions without separate user approval. Each service account owns only its private configuration, keys, env and SQLite/socket. Production defaults false; allowlist empty.

Client ownership: these wrappers assume the existing root-run Native Hermes operator (as the classgames pilot), which can connect to the service-owned 0600 socket without key-group changes. A non-root Hermes deployment is NOT enabled by these templates: it needs a separately reviewed narrow socket bridge/ACL restricted to this CLI and target. Never add Hermes to a group that can read signing/App/CF credentials, never chmod private keys to solve a socket error, and never silently enable global sudo. This setup is a later authorization gate, not an action in this PR.

Private env required at later installation: RELEASE_GITHUB_APP_ID, RELEASE_GITHUB_INSTALLATION_ID, CLOUDFLARE_READ_TOKEN, FEISHU_APP_ID, FEISHU_APP_SECRET, fixed SITE_RELEASE_PROJECT. Do not copy root's complete environment or use classgames production keys. Separate service/template paths and 9125/9126 loopback ports must be checked for collisions before installation.
