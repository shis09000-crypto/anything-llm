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
to HTTP.

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
the normal upgrade headers.

### Nginx

```nginx
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

  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
```

### Caddy

```caddyfile
athena.example.com {
  reverse_proxy 127.0.0.1:3001 {
    header_up X-Forwarded-Proto https
  }
}
```

For end-to-end TLS from proxy to Node, point the upstream at the Node HTTPS
listener and enable `ENABLE_HTTPS=true`.
