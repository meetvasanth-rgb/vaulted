#!/bin/zsh
# Compiles the App Clip's plain-Swift logic with a small test program and runs it.
set -euo pipefail
cd "${0:A:h}/.."
OUT="$(mktemp -d)/clip-tests"
swiftc -o "$OUT" Shared/InviteLink.swift Shared/SharedInvite.swift VaultlixClip/InviteModel.swift ClipTests/main.swift
"$OUT"
