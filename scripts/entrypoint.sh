#!/bin/bash
set -e

echo "🃏 Tarot Backend Service Starting..."
echo "   PORT: ${PORT:-7860}"
echo "   NODE_ENV: ${NODE_ENV:-production}"

if [ -x "$PUPPETEER_EXECUTABLE_PATH" ]; then
  echo "   Chromium: $PUPPETEER_EXECUTABLE_PATH ($($PUPPETEER_EXECUTABLE_PATH --version | head -1))"
else
  echo "   ⚠️ Chromium not found at $PUPPETEER_EXECUTABLE_PATH"
fi

if [ -n "$GEMINI_API_KEY" ]; then
  echo "   Gemini API: configured"
else
  echo "   ⚠️ GEMINI_API_KEY not set (reading endpoint will return 500)"
fi

exec "$@"
