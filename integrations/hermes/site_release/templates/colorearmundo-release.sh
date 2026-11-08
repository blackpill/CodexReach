#!/bin/sh
set -eu
export SITE_RELEASE_PROJECT=colorearmundo
cd /srv/hermes/release-control-colorearmundo/code
exec /srv/hermes/release-control-colorearmundo/venv/bin/python -m integrations.hermes.site_release.cli "$@"
