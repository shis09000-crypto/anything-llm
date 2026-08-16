FROM ghcr.io/sagernet/sing-box:v1.13.12@sha256:da0e2331395c9025a85fa58892772b4cdbe5f2e530e93defeec3968175d06c6d AS singbox

FROM alpine:3.22
RUN apk add --no-cache ca-certificates curl jq
COPY --from=singbox /usr/local/bin/sing-box /usr/local/bin/sing-box
COPY docker/browser-egress-gateway/supervisor.sh /usr/local/bin/browser-egress-gateway-supervisor
RUN chmod 0555 /usr/local/bin/sing-box /usr/local/bin/browser-egress-gateway-supervisor
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/browser-egress-gateway-supervisor"]
