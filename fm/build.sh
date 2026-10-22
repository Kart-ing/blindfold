#!/bin/sh
# Builds bin/fm (Apple Foundation Models, on-device). Needs macOS 26 + Apple Intelligence enabled.
cd "$(dirname "$0")/.." && swiftc -O fm/main.swift -o bin/fm
