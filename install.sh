#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${HOME}/.gemini/config/plugins/swarm-cost-monitor"

echo "Installing Swarm Cost Monitor to ${TARGET_DIR} ..."

mkdir -p "${TARGET_DIR}/assets" \
         "${TARGET_DIR}/skills/swarm-cost" \
         "${TARGET_DIR}/sidecars/swarm_cost/public"

cp "${SOURCE_DIR}/plugin.json" "${SOURCE_DIR}/README.md" "${TARGET_DIR}/"
cp "${SOURCE_DIR}/assets/logo.svg" "${TARGET_DIR}/assets/"
cp "${SOURCE_DIR}/skills/swarm-cost/SKILL.md" "${TARGET_DIR}/skills/swarm-cost/"
cp "${SOURCE_DIR}/sidecars/swarm_cost/sidecar.json" \
   "${SOURCE_DIR}/sidecars/swarm_cost/package.json" \
   "${SOURCE_DIR}/sidecars/swarm_cost/main.mjs" \
   "${SOURCE_DIR}/sidecars/swarm_cost/scanner.mjs" \
   "${SOURCE_DIR}/sidecars/swarm_cost/pricing.mjs" \
   "${TARGET_DIR}/sidecars/swarm_cost/"
cp "${SOURCE_DIR}/sidecars/swarm_cost/public/"* "${TARGET_DIR}/sidecars/swarm_cost/public/"

echo "Installed! Enable or toggle 'Swarm Cost Monitor' in Antigravity Customizations."
