#!/bin/bash

PORT="${SERVER_PORT:-3001}"
SCHEME="http"
CURL_ARGS=("--write-out" "%{http_code}" "--silent" "--output" "/dev/null")

if [ "$ENABLE_HTTPS" = "true" ] || [ "$ENABLE_HTTPS" = "1" ]; then
  SCHEME="https"
  CURL_ARGS+=("--insecure")
elif { [ "$TRUST_PROXY" = "true" ] || [ "$TRUST_PROXY" = "1" ]; } &&
  { [ "$FORCE_HTTPS" = "true" ] || [ "$FORCE_HTTPS" = "1" ]; }; then
  CURL_ARGS+=("--header" "X-Forwarded-Proto: https")
fi

# Send a request to the specified URL
response=$(curl "${CURL_ARGS[@]}" "$SCHEME://localhost:$PORT/api/ping")

# If the HTTP response code is 200 (OK), the server is up
if [ "$response" -eq 200 ]; then
  echo "Server is up"
  exit 0
else
  echo "Server is down"
  exit 1
fi
