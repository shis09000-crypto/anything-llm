# Athena Production Transport Security

Production deployments must not expose Athena frontend-to-backend traffic over
plain HTTP or WS. Local development can continue to use `http://localhost` and
`ws://localhost`.

## Direct Node HTTPS

Set:

```env
NODE_ENV=production
ENABLE_HTTPS=true
HTTPS_CERT_PATH=sslcert/cert.pem
HTTPS_KEY_PATH=sslcert/key.pem
```

If certificate loading fails in production, Athena exits instead of falling back
to HTTP. Direct Node HTTPS uses TLS 1.2 minimum, keeps TLS 1.3 preferred by the
runtime, and restricts TLS 1.2 to modern AEAD cipher suites.

## Reverse Proxy TLS Termination

Set:

```env
NODE_ENV=production
PUBLIC_APP_URL=https://athena.example.com
ATHENA_ALLOWED_ORIGINS=https://athena.example.com
TRUST_PROXY=true
FORCE_HTTPS=true
```

The proxy must forward `X-Forwarded-Proto: https`. WebSocket routes must forward
the normal upgrade headers. Athena only trusts `X-Forwarded-Proto` when
`TRUST_PROXY=true`.

### Nginx

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  '' close;
}

server {
  listen 80;
  server_name athena.example.com;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl http2;
  server_name athena.example.com;

  ssl_certificate /etc/letsencrypt/live/athena.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/athena.example.com/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_prefer_server_ciphers on;
  ssl_ciphers ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256;
  add_header Strict-Transport-Security "max-age=15552000; includeSubDomains" always;

  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;

    # Keep SSE and long-running model streams interactive.
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 605s;
    proxy_send_timeout 605s;
  }
}
```

### Caddy

```caddyfile
athena.example.com {
  header Strict-Transport-Security "max-age=15552000; includeSubDomains"

  reverse_proxy 127.0.0.1:3001 {
    header_up X-Forwarded-Proto https
    flush_interval -1
  }
}
```

For end-to-end TLS from proxy to Node, point the upstream at the Node HTTPS
listener and enable `ENABLE_HTTPS=true`.

## Pre-release Security Checks

Use the low-side-effect hardening checks before production deployment:

```bash
node server/scripts/audit-resource-communication-access.js
node server/scripts/audit-security-hardening.js
git diff --check
```

Then verify the development runtime can stay up after launcher exit:

```bash
bash ./run-development --no-open
bash ./status --env development
curl -sS -i http://localhost:3002/api/ping
```
