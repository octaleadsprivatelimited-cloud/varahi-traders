#!/bin/zsh
set -e
cd "${0:A:h}"
if curl --silent --fail http://localhost:5180/ > /dev/null; then
  open http://localhost:5180/
  exit 0
fi
docker compose up -d --wait mysql redis
pnpm --dir commerce-api db:deploy
pnpm --dir commerce-api seed
pnpm dev:api &
varahi_api_pid=$!
trap 'kill "$varahi_api_pid" 2>/dev/null || true' EXIT INT TERM
open http://localhost:5180/
pnpm dev
