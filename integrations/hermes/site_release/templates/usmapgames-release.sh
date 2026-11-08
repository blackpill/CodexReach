#!/bin/sh
set -eu
export SITE_RELEASE_PROJECT=usmapgames
cd /srv/hermes/release-control-usmapgames/code
exec /srv/hermes/release-control-usmapgames/venv/bin/python -m integrations.hermes.site_release.cli "$@"
