#!/bin/bash

# Ensure we're in the correct directory
cd /usr/src/app

if [ -n "$MEETING_URL" ]; then
    echo "MEETING_URL detected, starting in One-Shot mode..."
    # xvfb-run-wrapper handles PulseAudio and Xvfb setup
    # then executes node dist/autostart.js
    exec /usr/src/app/xvfb-run-wrapper node dist/autostart.js
else
    echo "No MEETING_URL detected, starting in Server mode..."
    # xvfb-run-wrapper handles PulseAudio and Xvfb setup
    # then executes the standard server
    exec /usr/src/app/xvfb-run-wrapper node dist/index.js
fi
