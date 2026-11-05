#!/bin/sh
set -eu
exec systemd-run --quiet --wait --pipe --collect --uid=better-buy --gid=better-buy --property=EnvironmentFile=/etc/better-buy/better-buy.env --property=WorkingDirectory=/srv/better-buy/current/apps/api /usr/local/bin/better-buy-push-test "$@"
