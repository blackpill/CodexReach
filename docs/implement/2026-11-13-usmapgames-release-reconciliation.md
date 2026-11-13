# USMapGames: reconcile a deployment whose workflow health check failed

**Change scope:** Native USMapGames controller only. This does not change the public claims endpoint, GitHub release tooling pin, release approvals, or any website deployment.

Incident: release `rel_fc735c0087ced2e0d27203c7`, [GitHub Run 43348847509](https://github.com/blackpill/usmapgames.com/actions/runs/43348847509), target `899663acdd4b955fb046d76acd9b7128e0331312`. The original workflow failed its post-deploy check, but its result confirms a deployment and later control-plane and public checks confirm the same live version. The original failing probe was not logged.

## Operator procedure (separate authorized maintenance)
1. Review this PR and verify its tests. Use the approved maintenance process on the existing USMapGames Native controller host to roll the controller to the reviewed commit. Preserve the project-specific configuration, credential scope and SQLite state (take a consistent protected backup before maintenance). Keep the website workflow's pinned publisher unchanged. Do not install or restart other sites' controllers.
2. From that host use the existing privileged local wrapper, first `/usr/local/bin/usmapgames-release status --release-id rel_fc735c0087ced2e0d27203c7`, then `/usr/local/bin/usmapgames-release reconcile --release-id rel_fc735c0087ced2e0d27203c7`. Keep the output private or redact its manifest (which includes historical confirmation material).
3. Verify status returns `RECONCILED_HEALTHY`, original `workflow_conclusion=failure` and `health_status=unhealthy`, fresh `reconcile_health_status=healthy`. Cloudflare must still show the same deployment ID and a single version at 100%, and the public release marker must still match. If any check is missing, fails or has drifted, stop: do not edit SQLite, replay a ticket or rerun the original workflow.
4. Only then prepare the next release with the normal workflow and require a new genuine Feishu approval for the exact current main SHA. Reconciliation never dispatches, deploys, rolls back, or permits automated rollback to the reconciled version.

Recovery applies only to an explicitly selected, already claimed and uncertain USMapGames deploy with matching first-attempt run and artifact identities, and matching Cloudflare snapshots before and after a fresh public health check. The background poller cannot close this state on this new path. Original GitHub failure remains immutable.
