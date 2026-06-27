# Run AnythingLLM in production without Docker

> [!WARNING]
> This method of deployment is **not supported** by the core-team and is to be used as a reference for your deployment.
> You are fully responsible for securing your deployment and data in this mode.
> **Any issues** experienced from bare-metal or non-containerized deployments will be **not** answered or supported.

Here you can find the scripts and known working process to run AnythingLLM outside of a Docker container.

### Minimum Requirements
> [!TIP]
> You should aim for at least 2GB of RAM. Disk storage is proportional to however much data
> you will be storing (documents, vectors, models, etc). Minimum 10GB recommended.

- NodeJS v18
- Yarn


## Getting started

1. Clone the repo into your server as the user who the application will run as.
`git clone git@github.com:Mintplex-Labs/anything-llm.git`

2. `cd anything-llm` and run `yarn setup`. This will install all dependencies to run in production as well as debug the application.

3. `cp server/.env.example server/.env` to create the basic ENV file for where instance settings will be read from on service start.

4. Ensure that the `server/.env` file has _at least_ these keys to start. These values will persist and this file will be automatically written and managed after your first successful boot.
```
STORAGE_DIR="/your/absolute/path/to/server/storage"
```

5. Edit the `frontend/.env` file for the `VITE_BASE_API` to now be set to `/api`. This is documented in the .env for which one you should use.
```
# VITE_API_BASE='http://localhost:3001/api' # Use this URL when developing locally
# VITE_API_BASE="https://$CODESPACE_NAME-3001.$GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN/api" # for GitHub Codespaces
VITE_API_BASE='/api' # Use this URL deploying on non-localhost address OR in docker.
```

## To start the application

AnythingLLM is comprised of three main sections. The `frontend`, `server`, and `collector`. When running in production you will be running `server` and `collector` on two different processes, with a build step for compilation of the frontend.

1. Build the frontend application.
`cd frontend && yarn build` - this will produce a `frontend/dist` folder that will be used later.

2. Copy `frontend/dist` to `server/public` - `cp -R frontend/dist server/public`.
This should create a folder in `server` named `public` which contains a top level `index.html` file and various other files/folders.

3. Migrate and prepare your database file.
```
cd server && npx prisma generate --schema=./prisma/schema.prisma
cd server && npx prisma migrate deploy --schema=./prisma/schema.prisma
```

4. Boot the server in production
`cd server && NODE_ENV=production node index.js &`

5. Boot the collection in another process
`cd collector && NODE_ENV=production node index.js &`

AnythingLLM should now be running on `http://localhost:3001` locally. For
production access, put it behind HTTPS/WSS with a reverse proxy or enable Node
HTTPS directly.

## Updating AnythingLLM

To update AnythingLLM with future updates you can `git pull origin master` to pull in the latest code and then repeat steps 2 - 5 to deploy with all changes fully.

_note_ You should ensure that each folder runs `yarn` again to ensure packages are up to date in case any dependencies were added, changed, or removed.

_note_ You should `pkill node` before running an update so that you are not running multiple AnythingLLM processes on the same instance as this can cause conflicts.


### Example update script

```shell
#!/bin/bash

cd $HOME/anything-llm &&\
git checkout . &&\
git pull origin master &&\
echo "HEAD pulled to commit $(git log -1 --pretty=format:"%h" | tail -n 1)"

echo "Freezing current ENVs"
curl -I "http://localhost:3001/api/env-dump" | head -n 1|cut -d$' ' -f2

echo "Rebuilding Frontend"
cd $HOME/anything-llm/frontend && yarn && yarn build && cd $HOME/anything-llm

echo "Copying to Server Public"
rm -rf server/public
cp -r frontend/dist server/public

echo "Killing node processes"
pkill node

echo "Installing collector dependencies"
cd $HOME/anything-llm/collector && yarn

echo "Installing server dependencies & running migrations"
cd $HOME/anything-llm/server && yarn
cd $HOME/anything-llm/server && npx prisma migrate deploy --schema=./prisma/schema.prisma
cd $HOME/anything-llm/server && npx prisma generate

echo "Booting up services."
truncate -s 0 /logs/server.log # Or any other log file location.
truncate -s 0 /logs/collector.log

cd $HOME/anything-llm/server
(NODE_ENV=production node index.js) &> /logs/server.log &

cd $HOME/anything-llm/collector
(NODE_ENV=production node index.js) &> /logs/collector.log &
```

## Using Nginx?

If you are using Nginx, use HTTPS at the public edge and proxy to the local
server. Chats, Agent sessions, and model streams require WebSocket/SSE-friendly
proxy settings.

```nginx
map $http_upgrade $connection_upgrade {
   default upgrade;
   '' close;
}

server {
   listen 80;
   server_name [insert FQDN here];
   return 301 https://$host$request_uri;
}

server {
   listen 443 ssl http2;
   server_name [insert FQDN here];

   ssl_certificate /etc/letsencrypt/live/[insert FQDN here]/fullchain.pem;
   ssl_certificate_key /etc/letsencrypt/live/[insert FQDN here]/privkey.pem;
   ssl_protocols TLSv1.2 TLSv1.3;
   ssl_prefer_server_ciphers on;
   ssl_ciphers ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256;
   add_header Strict-Transport-Security "max-age=15552000; includeSubDomains" always;

   location / {
      # Prevent timeouts on long-running requests.
      proxy_connect_timeout       605;
      proxy_send_timeout          605;
      proxy_read_timeout          605;
      send_timeout                605;
      keepalive_timeout           605;

      # Enable readable HTTP Streaming for LLM streamed responses
      proxy_buffering off;
      proxy_cache off;

      # Proxy your locally running service
      proxy_pass  http://127.0.0.1:3001;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto https;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;
    }
}
```

When using this proxy in production, set `PUBLIC_APP_URL=https://your-domain`,
`ATHENA_ALLOWED_ORIGINS=https://your-domain`, `TRUST_PROXY=true`, and
`FORCE_HTTPS=true` in `server/.env`.
