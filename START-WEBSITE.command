#!/bin/zsh
set -e
cd "${0:A:h}"
if curl --silent --fail http://localhost:5180/ > /dev/null && curl --silent --fail http://localhost:4010/ready > /dev/null; then
  open http://localhost:5180/
  exit 0
fi
pnpm setup:local
exec pnpm dev:local --open
