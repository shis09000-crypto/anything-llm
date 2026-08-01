#!/usr/bin/env python3
"""Render the production single-host micro-module Compose topology.

The preproduction overlay is the code-authoritative list of runtime roles and
service wiring. Production intentionally reuses that contract, but joins the
already running production infrastructure network and never reuses
preproduction identities or secrets.
"""

from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path

import yaml


BACKEND_IMAGE_SERVICES = {
    "anything-llm-api",
    "anything-llm-edge-probe",
    "anything-llm-background-worker",
    "anything-llm-realtime-gateway",
    "anything-llm-reader-worker",
    "anything-llm-scheduler",
    "anything-llm-operations-plane",
    "anything-llm-chat-runtime",
    "anything-llm-agent-runtime",
    "anything-llm-model-gateway",
    "anything-llm-tool-broker",
    "anything-llm-crypto-market",
    "anything-llm-crypto-account",
    "anything-llm-crypto-forecast",
    "anything-llm-key-custody",
    "anything-llm-identity",
    "anything-llm-knowledge-ingest",
    "anything-llm-rag",
    "anything-llm-operations-shadow-agents",
    "anything-llm-browser-plane",
    "anything-llm-browser-worker",
    "anything-llm-collector",
}


def module_image_variable(service_name: str) -> str:
    module = service_name.removeprefix("anything-llm-")
    return f"ATHENA_PROD_{module.replace('-', '_').upper()}_IMAGE"

# The production topology mirrors the validated preproduction trust boundary:
# only Key Custody receives platform master-key material. All other services
# call its mTLS policy endpoint and cannot silently fall back to local unwrap.
LOCAL_KEY_SERVICES = {"anything-llm-key-custody"}

EXTERNAL_SERVICES = {"nats", "clickhouse", "otel-collector"}
EXCLUDED_SERVICES = {
    "nats",
    "clickhouse",
    "tempo",
    "loki",
    "otel-collector",
    "prometheus",
    "prometheus-init",
    "grafana",
    "athena-preproduction-ingress",
}

DEFAULT_SERVICE_PORTS = {
    "anything-llm-reader-worker": 3011,
    "anything-llm-background-worker": 3012,
    "anything-llm-realtime-gateway": 3013,
    "anything-llm-scheduler": 3014,
    "anything-llm-operations-plane": 3015,
    "anything-llm-chat-runtime": 3016,
    "anything-llm-agent-runtime": 3017,
    "anything-llm-model-gateway": 3018,
    "anything-llm-tool-broker": 3019,
    "anything-llm-crypto-market": 3020,
    "anything-llm-crypto-account": 3021,
    "anything-llm-crypto-forecast": 3022,
    "anything-llm-key-custody": 3023,
    "anything-llm-edge-probe": 3025,
    "anything-llm-identity": 3026,
    "anything-llm-knowledge-ingest": 3027,
    "anything-llm-rag": 3028,
    "anything-llm-operations-shadow-agents": 3029,
    "anything-llm-browser-plane": 3030,
    "anything-llm-browser-worker": 3031,
}


def transform_string(value: str) -> str:
    result = value.replace(
        "./preproduction/api-mtls-proxy.conf",
        "__ATHENA_PRODUCTION_API_MTLS_PROXY__",
    ).replace(
        "./preproduction/edge-proxy-ssl.conf",
        "__ATHENA_PRODUCTION_EDGE_PROXY_SSL__",
    )
    replacements = (
        ("ATHENA_PREPROD_", "ATHENA_PROD_"),
        ("ATHENA_PREPRODUCTION_", "ATHENA_PRODUCTION_"),
        ("athena-preproduction", "athena-production"),
        ("preproduction-", "production-"),
        ("/preproduction/", "/production/"),
        ("preproduction-ed25519", "production-ed25519"),
        ("preproduction-mldsa65", "production-mldsa65"),
        ("preprod-storage:/app/server/storage", "${ATHENA_PROD_STORAGE_DIR:?required}:/app/server/storage"),
        ("preprod-collector-hotdir:/app/collector/hotdir", "${ATHENA_PROD_COLLECTOR_HOTDIR:?required}:/app/collector/hotdir"),
        ("preprod-collector-outputs:/app/collector/outputs", "${ATHENA_PROD_COLLECTOR_OUTPUTS:?required}:/app/collector/outputs"),
        ("./preproduction.empty.env:/app/server/.env:ro", "${ATHENA_PROD_RUNTIME_ENV:?required}:/app/server/.env:ro"),
    )
    for source, target in replacements:
        result = result.replace(source, target)
    return result.replace(
        "__ATHENA_PRODUCTION_API_MTLS_PROXY__",
        "${ATHENA_PROD_REPO_DIR:?required}/docker/preproduction/api-mtls-proxy.conf",
    ).replace(
        "__ATHENA_PRODUCTION_EDGE_PROXY_SSL__",
        "${ATHENA_PROD_REPO_DIR:?required}/docker/preproduction/edge-proxy-ssl.conf",
    )


def transform(value):
    if isinstance(value, str):
        return transform_string(value)
    if isinstance(value, list):
        return [transform(item) for item in value]
    if isinstance(value, dict):
        return {key: transform(item) for key, item in value.items()}
    return value


def healthcheck(port: int, path: str = "/ready") -> dict:
    return {
        "test": [
            "CMD-SHELL",
            f'curl --silent --fail --insecure "https://127.0.0.1:{port}{path}" >/dev/null',
        ],
        "interval": "15s",
        "timeout": "5s",
        "start_period": "45s",
        "retries": 20,
    }


def readiness_path(service_name: str) -> str:
    # These runtimes pre-date MicroModuleServiceHost and intentionally expose
    # their existing /health contract. All hosted modules use /ready.
    if service_name in {
        "anything-llm-background-worker",
        "anything-llm-reader-worker",
        "anything-llm-realtime-gateway",
    }:
        return "/health"
    return "/ready"


def service_port(service_name: str, environment: dict) -> int | None:
    port_names = (
        "BACKGROUND_WORKER_PORT",
        "REALTIME_GATEWAY_PORT",
        "READER_WORKER_PORT",
        "SCHEDULER_PORT",
        "OPERATIONS_PLANE_PORT",
        "CHAT_RUNTIME_PORT",
        "AGENT_RUNTIME_PORT",
        "MODEL_GATEWAY_PORT",
        "TOOL_BROKER_PORT",
        "CRYPTO_MARKET_PORT",
        "CRYPTO_ACCOUNT_PORT",
        "CRYPTO_FORECAST_PORT",
        "KEY_CUSTODY_PORT",
        "EDGE_PROBE_PORT",
        "IDENTITY_PORT",
        "KNOWLEDGE_INGEST_PORT",
        "RAG_PORT",
        "OPERATIONS_SHADOW_AGENTS_PORT",
        "BROWSER_PLANE_PORT",
        "BROWSER_WORKER_PORT",
    )
    for port_name in port_names:
        if port_name in environment:
            return int(environment[port_name])
    return DEFAULT_SERVICE_PORTS.get(service_name)


def render(source: Path) -> dict:
    contract = yaml.safe_load(source.read_text())
    services = {}
    for name, raw in contract["services"].items():
        if name in EXCLUDED_SERVICES:
            continue
        service = transform(copy.deepcopy(raw))
        service["volumes"] = [
            volume
            for volume in service.get("volumes", [])
            if "preprod-evidence" not in str(volume)
        ]
        service.pop("profiles", None)
        service.pop("build", None)
        service.pop("container_name", None)
        service["networks"] = ["production"]

        dependencies = service.get("depends_on")
        if isinstance(dependencies, dict):
            service["depends_on"] = {
                key: value
                for key, value in dependencies.items()
                if key not in EXTERNAL_SERVICES and key not in EXCLUDED_SERVICES
            }
        elif isinstance(dependencies, list):
            service["depends_on"] = [
                value
                for value in dependencies
                if value not in EXTERNAL_SERVICES and value not in EXCLUDED_SERVICES
            ]

        environment = service.setdefault("environment", {})
        if name in BACKEND_IMAGE_SERVICES:
            service["image"] = f"${{{module_image_variable(name)}:?required}}"
            service["init"] = True
            service["stop_grace_period"] = "120s"
            service["restart"] = "unless-stopped"
            environment["STORAGE_DIR"] = "/app/server/storage"
            environment["TRUST_PROXY"] = "true"
            environment["FORCE_HTTPS"] = "true"
            environment["ATHENA_PASSWORD_PEPPER_FILE"] = (
                "/run/secrets/athena_password_pepper"
            )
            service.setdefault("volumes", []).append(
                "${ATHENA_PROD_SECRETS_DIR:?required}/runtime-secrets/password-pepper:/run/secrets/athena_password_pepper:ro"
            )
            service["volumes"] = list(dict.fromkeys(service["volumes"]))
            if name != "anything-llm-collector":
                # CollectorApi is imported by several split runtimes. A
                # single HTTPS endpoint keeps startup fail-closed while each
                # caller presents its own module certificate.
                environment["COLLECTOR_ENDPOINT"] = (
                    "https://anything-llm-collector:8888"
                )
        if name not in {"anything-llm-web", "anything-llm-api-tls", "postgresql", "minio", "minio-init"}:
            environment["APP_ENV"] = "production"
            environment["NODE_ENV"] = "production"
            environment["ATHENA_RUNTIME_TOPOLOGY"] = "micro-modules"
            environment["ATHENA_NATS_TLS_SERVER_NAME"] = "athena-production-nats"
            environment["ATHENA_KEY_CUSTODY_DIRECT_FIELD_CUTOVER"] = "true"
            environment["ATHENA_KEY_CUSTODY_CUTOVER"] = (
                "false" if name in LOCAL_KEY_SERVICES else "true"
            )
            environment["ATHENA_MODEL_GATEWAY_CUTOVER"] = (
                "false" if name == "anything-llm-model-gateway" else "true"
            )
            environment["PUBLIC_APP_URL"] = "https://athenallm.online"
            environment["ATHENA_ALLOWED_ORIGINS"] = "https://athenallm.online"
            environment["ATHENA_PLUGIN_CAPABILITY_ED25519_KEY_ID"] = "production-ed25519"
            environment["ATHENA_PLUGIN_CAPABILITY_MLDSA65_KEY_ID"] = "production-mldsa65"

        if name in LOCAL_KEY_SERVICES:
            environment["ATHENA_KEY_PROVIDER"] = "secret-file"
            environment["ATHENA_MASTER_KEY_FILE"] = "/run/secrets/athena_master_key"
            environment["ATHENA_AUDIT_HYBRID_SIGNATURES"] = "required"
            environment["ATHENA_AUDIT_MLDSA65_KEY_ID"] = (
                "${ATHENA_PROD_AUDIT_MLDSA65_KEY_ID:?required}"
            )
            environment["ATHENA_AUDIT_MLDSA65_PRIVATE_KEY_FILE"] = (
                "/run/secrets/audit-mldsa65-private.pem"
            )
            environment["ATHENA_AUDIT_MLDSA65_PUBLIC_KEY_FILE"] = (
                "/run/secrets/audit-mldsa65-public.pem"
            )
            environment["ATHENA_AUDIT_MLDSA65_HARDWARE_PROTECTION"] = (
                "${ATHENA_PROD_AUDIT_MLDSA65_HARDWARE_PROTECTION:?required}"
            )
            service.setdefault("volumes", []).append(
                "${ATHENA_PROD_SECRETS_DIR:?required}/runtime-secrets/master-key:/run/secrets/athena_master_key:ro"
            )
            service.setdefault("volumes", []).extend(
                [
                    "${ATHENA_PROD_SECRETS_DIR:?required}/runtime-secrets/audit-mldsa65-private.pem:/run/secrets/audit-mldsa65-private.pem:ro",
                    "${ATHENA_PROD_SECRETS_DIR:?required}/runtime-secrets/audit-mldsa65-public.pem:/run/secrets/audit-mldsa65-public.pem:ro",
                ]
            )
            service["volumes"] = list(dict.fromkeys(service["volumes"]))

        if name in {"anything-llm-api", "anything-llm-background-worker"}:
            # Preserve the existing hybrid audit/agent signing boundary while
            # moving the runtime from the monolith to independent roles. Only
            # the roles that already held these keys receive private material.
            environment["ATHENA_AUDIT_HYBRID_SIGNATURES"] = "required"
            environment["ATHENA_EXTERNAL_AGENT_MLDSA_REQUIRED"] = "true"
            environment["ATHENA_AUDIT_MLDSA65_KEY_ID"] = (
                "${ATHENA_PROD_AUDIT_MLDSA65_KEY_ID:?required}"
            )
            environment["ATHENA_AUDIT_MLDSA65_PRIVATE_KEY_FILE"] = (
                "/run/secrets/audit-mldsa65-private.pem"
            )
            environment["ATHENA_AUDIT_MLDSA65_PUBLIC_KEY_FILE"] = (
                "/run/secrets/audit-mldsa65-public.pem"
            )
            environment["ATHENA_AUDIT_MLDSA65_HARDWARE_PROTECTION"] = (
                "${ATHENA_PROD_AUDIT_MLDSA65_HARDWARE_PROTECTION:?required}"
            )
            environment["ATHENA_AGENT_MLDSA65_KEY_ID"] = (
                "${ATHENA_PROD_AGENT_MLDSA65_KEY_ID:?required}"
            )
            environment["ATHENA_AGENT_MLDSA65_PRIVATE_KEY_FILE"] = (
                "/run/secrets/agent-mldsa65-private.pem"
            )
            environment["ATHENA_AGENT_MLDSA65_PUBLIC_KEY_FILE"] = (
                "/run/secrets/agent-mldsa65-public.pem"
            )
            service.setdefault("volumes", []).extend(
                [
                    "${ATHENA_PROD_SECRETS_DIR:?required}/runtime-secrets/audit-mldsa65-private.pem:/run/secrets/audit-mldsa65-private.pem:ro",
                    "${ATHENA_PROD_SECRETS_DIR:?required}/runtime-secrets/audit-mldsa65-public.pem:/run/secrets/audit-mldsa65-public.pem:ro",
                    "${ATHENA_PROD_SECRETS_DIR:?required}/runtime-secrets/agent-mldsa65-private.pem:/run/secrets/agent-mldsa65-private.pem:ro",
                    "${ATHENA_PROD_SECRETS_DIR:?required}/runtime-secrets/agent-mldsa65-public.pem:/run/secrets/agent-mldsa65-public.pem:ro",
                ]
            )
            service["volumes"] = list(dict.fromkeys(service["volumes"]))

        if name == "anything-llm-api":
            environment["ATHENA_IOS_HIGH_RISK_PQ_REQUIRED"] = "true"

        if name in {"anything-llm-chat-runtime", "anything-llm-agent-runtime"}:
            service["volumes"] = [
                volume.replace(
                    "${ATHENA_PROD_RUNTIME_ENV:?required}:/app/server/.env:ro",
                    "${ATHENA_PROD_AGENT_RUNTIME_ENV:?required}:/app/server/.env:ro",
                )
                for volume in service.get("volumes", [])
            ]

        if name == "anything-llm-crypto-forecast":
            # SQLite remains only an instance-local, disposable query cache.
            # PostgreSQL owns snapshot metadata and S3 owns immutable bytes.
            environment["ATHENA_CRYPTO_FORECAST_STORE"] = "postgres-s3"
            environment["ATHENA_CRYPTO_FORECAST_CACHE_ROOT"] = (
                "/tmp/athena-crypto-forecast-cache"
            )
            environment["ATHENA_CRYPTO_FORECASTING_ENABLED"] = (
                "${ATHENA_PROD_CRYPTO_FORECASTING_ENABLED:-true}"
            )
            service["tmpfs"] = [
                "/tmp/athena-crypto-forecast-cache:rw,nosuid,nodev,noexec,size=512m,mode=0700,uid=1000,gid=1000"
            ]

        port = service_port(name, environment)
        if port:
            service["healthcheck"] = healthcheck(
                port, readiness_path(name)
            )
        if name == "anything-llm-api":
            service["healthcheck"] = {
                "test": ["CMD-SHELL", "curl --silent --fail --header 'X-Forwarded-Proto: https' http://127.0.0.1:3001/api/ready >/dev/null"],
                "interval": "15s",
                "timeout": "5s",
                "start_period": "60s",
                "retries": 20,
            }
            service["mem_limit"] = "640m"
        elif name == "anything-llm-browser-worker":
            service["mem_limit"] = "768m"
            # Chromium's namespace sandbox performs a final chroot into an
            # empty proc fd. Grant only that capability; SYS_ADMIN and the
            # unsafe --no-sandbox mode remain prohibited.
            service["cap_add"] = ["SYS_CHROOT"]
            service["init"] = True
            service["cap_drop"] = ["ALL"]
            service["security_opt"] = [
                "no-new-privileges:true",
                "seccomp=./playwright-seccomp-profile.json",
            ]
            service["shm_size"] = "256m"
            environment["BROWSER_WORKER_MIN_CGROUP_HEADROOM_BYTES"] = "268435456"
            environment["BROWSER_WORKER_MEMORY_ADMISSION_MODE"] = "cgroup-isolated"
            environment["STORAGE_DIR"] = "/tmp/athena-browser-worker"
        elif name == "anything-llm-browser-plane":
            service["mem_limit"] = "256m"
            service["volumes"] = [
                volume
                for volume in service.get("volumes", [])
                if ":/app/server/storage" not in volume
            ]
            service["tmpfs"] = [
                "/tmp/athena-browser-plane:rw,nosuid,nodev,noexec,size=256m,mode=0700,uid=1000,gid=1000"
            ]
            environment["STORAGE_DIR"] = "/tmp/athena-browser-plane"
        elif name in {"anything-llm-chat-runtime", "anything-llm-agent-runtime"}:
            service["mem_limit"] = "448m"
        elif name in BACKEND_IMAGE_SERVICES:
            service["mem_limit"] = "256m"

        services[name] = service

    # The public API keeps two independently replaceable slots behind the
    # mTLS proxy. Both use the same service identity and application contract,
    # while their NATS durable names remain distinct. A release replaces one
    # slot, waits for readiness, and only then replaces the other slot.
    api_blue = services["anything-llm-api"]
    api_blue["environment"]["ATHENA_API_INSTANCE_SLOT"] = "blue"
    api_green = copy.deepcopy(api_blue)
    api_green["environment"]["ATHENA_API_INSTANCE_SLOT"] = "green"
    api_green["environment"]["ATHENA_NATS_CONSUMER_NAME"] = (
        "production-api-green"
    )
    services["anything-llm-api-green"] = api_green

    postgresql = services["postgresql"]
    postgresql["volumes"] = [
        "${ATHENA_PROD_STATE_DIR:?required}/postgresql:/var/lib/postgresql/data",
        "${ATHENA_PROD_REPO_DIR:?required}/docker/postgresql/init-athena.sh:/docker-entrypoint-initdb.d/10-athena.sh:ro",
    ]
    postgresql["ports"] = ["127.0.0.1:55432:5432"]
    postgresql["command"] = [
        "postgres", "-c", "max_connections=140", "-c", "shared_buffers=128MB",
        "-c", "effective_cache_size=512MB", "-c", "log_min_duration_statement=750",
    ]
    postgresql["mem_limit"] = "640m"

    minio = services["minio"]
    minio["volumes"] = [
        "${ATHENA_PROD_STATE_DIR:?required}/minio:/data",
        "${ATHENA_PROD_SECRETS_DIR:?required}/service-mtls/minio.pem:/certs/public.crt:ro",
        "${ATHENA_PROD_SECRETS_DIR:?required}/service-mtls/minio.key:/certs/private.key:ro",
        "${ATHENA_PROD_SECRETS_DIR:?required}/service-mtls/ca.pem:/certs/CAs/ca.pem:ro",
    ]
    minio["ports"] = ["127.0.0.1:59000:9000"]
    minio["mem_limit"] = "384m"

    web = services["anything-llm-web"]
    web["image"] = "nginx:1.27-alpine"
    web["restart"] = "unless-stopped"
    web["ports"] = ["127.0.0.1:3001:3000"]
    web["volumes"] = [
        "${ATHENA_PROD_WEB_ROOT:?required}:/usr/share/nginx/html:ro",
        "${ATHENA_PROD_REPO_DIR:?required}/docker/nginx-web.conf.template:/etc/nginx/templates/default.conf.template:ro",
        "${ATHENA_PROD_REPO_DIR:?required}/docker/preproduction/edge-proxy-ssl.conf:/etc/nginx/conf.d/athena-proxy-ssl.conf:ro",
        "${ATHENA_PROD_SECRETS_DIR:?required}/service-mtls:/run/secrets/athena-mtls:ro",
    ]
    web["healthcheck"] = {
        "test": ["CMD", "wget", "-q", "-O", "-", "http://127.0.0.1:3000/health"],
        "interval": "10s", "timeout": "3s", "start_period": "20s", "retries": 30,
    }
    web["mem_limit"] = "96m"
    web["environment"]["ATHENA_BROWSER_STREAM_UPSTREAM"] = (
        "https://anything-llm-browser-worker:3031"
    )

    api_tls = services["anything-llm-api-tls"]
    api_tls["mem_limit"] = "64m"

    collector = services["anything-llm-collector"]
    # Preserve the existing production Chromium sandbox contract. The
    # alternative would be --no-sandbox, which is not an acceptable security
    # downgrade for Collector parsing workloads.
    collector["cap_add"] = ["SYS_ADMIN"]
    collector["healthcheck"] = {
        "test": [
            "CMD-SHELL",
            "curl --silent --fail --insecure --cert /run/secrets/athena-mtls/collector.pem --key /run/secrets/athena-mtls/collector.key https://127.0.0.1:8888/health >/dev/null",
        ],
        "interval": "15s", "timeout": "5s", "start_period": "45s", "retries": 20,
    }
    collector["mem_limit"] = "384m"

    edge = services["anything-llm-edge-probe"]
    edge.pop("depends_on", None)
    edge["environment"]["ATHENA_EDGE_LOCAL_HEALTH_URL"] = "http://anything-llm-web:3000/health"

    services["prometheus"] = {
        "image": "prom/prometheus:v3.4.2",
        "restart": "unless-stopped",
        "command": [
            "--config.file=/etc/prometheus/prometheus.yml",
            "--storage.tsdb.retention.time=30d",
            "--web.enable-lifecycle",
        ],
        "volumes": [
            "${ATHENA_PROD_REPO_DIR:?required}/docker/observability/prometheus.preproduction.yaml:/etc/prometheus/prometheus.yml:ro",
            "${ATHENA_PROD_REPO_DIR:?required}/docker/observability/alert-rules.yaml:/etc/prometheus/alert-rules.yaml:ro",
            "${ATHENA_PROD_REPO_DIR:?required}/docker/observability/slo-recording-rules.yaml:/etc/prometheus/slo-recording-rules.yaml:ro",
            "${ATHENA_PROD_SECRETS_DIR:?required}/service-mtls:/run/secrets/athena-mtls:ro",
            "${ATHENA_PROD_SECRETS_DIR:?required}/runtime-secrets/metrics-token:/run/secrets/athena_metrics_token:ro",
            "prometheus-data:/prometheus",
        ],
        "ports": ["127.0.0.1:59090:9090"],
        "healthcheck": {
            "test": ["CMD", "wget", "-q", "-O", "-", "http://127.0.0.1:9090/-/ready"],
            "interval": "10s", "timeout": "3s", "start_period": "20s", "retries": 30,
        },
        "mem_limit": "256m",
        "networks": ["production"],
    }

    return {
        "name": "athena-production-micro",
        "networks": {
            "production": {"external": True, "name": "${ATHENA_PROD_NETWORK:-anythingllm-v2_default}"}
        },
        "volumes": {
            "prometheus-data": {
                "external": True,
                "name": "anythingllm-v2_athena-prometheus-data",
            }
        },
        "services": services,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default="docker/docker-compose.preproduction.yml")
    parser.add_argument("--output", default="docker/docker-compose.production-micro.json")
    args = parser.parse_args()
    rendered = render(Path(args.source))
    Path(args.output).write_text(json.dumps(rendered, indent=2) + "\n")
    print(json.dumps({"success": True, "services": len(rendered["services"]), "output": args.output}))


if __name__ == "__main__":
    main()
