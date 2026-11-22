#!/usr/bin/env bash
# Smoke-test a running gateway over real HTTP.
#   scripts/smoke.sh                      # http://localhost:8080
#   GATEWAY=http://localhost:8080 scripts/smoke.sh
set -euo pipefail

GATEWAY="${GATEWAY:-http://localhost:8080}"
VERSION="2026-07-28"
META="\"_meta\":{\"io.modelcontextprotocol/protocolVersion\":\"$VERSION\",\"io.modelcontextprotocol/clientCapabilities\":{},\"io.modelcontextprotocol/clientInfo\":{\"name\":\"smoke\",\"version\":\"0\"}}"
fail=0

# rpc <method> <params-json-without-braces> [mcp-name] -> prints "status body"
rpc() {
  local method="$1" params="$2" name="${3:-}"
  local args=(-s -w '\n%{http_code}' "$GATEWAY/mcp"
    -H 'content-type: application/json'
    -H 'accept: application/json, text/event-stream'
    -H "mcp-protocol-version: $VERSION"
    -H "mcp-method: $method")
  [[ -n "$name" ]] && args+=(-H "mcp-name: $name")
  local sep=""; [[ -n "$params" ]] && sep=","
  curl "${args[@]}" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\",\"params\":{${params}${sep}${META}}}"
}

check() { # check <label> <expected-status> <grep-pattern> <output>
  local label="$1" want="$2" pattern="$3" out="$4"
  local status body; status="$(tail -n1 <<<"$out")"; body="$(sed '$d' <<<"$out")"
  if [[ "$status" == "$want" ]] && grep -q -- "$pattern" <<<"$body"; then
    echo "PASS  $label"
  else
    echo "FAIL  $label (HTTP $status): ${body:0:300}"; fail=1
  fi
}

curl -sf "$GATEWAY/healthz" >/dev/null || { echo "gateway not reachable at $GATEWAY"; exit 1; }

check "tools/list merges namespaced tools" 200 '"crm__read_customer"' "$(rpc tools/list '')"
check "tools/list is private-scoped"       200 '"cacheScope":"private"' "$(rpc tools/list '')"
check "tools/call routes to crm"            200 'Alan Turing' \
  "$(rpc tools/call '"name":"crm__read_customer","arguments":{"id":"c-002"}' crm__read_customer)"
check "unknown tool -> -32602"              200 '"code":-32602' \
  "$(rpc tools/call '"name":"crm__nope","arguments":{}' crm__nope)"
check "Mcp-Name mismatch -> 400/-32020"     400 '"code":-32020' \
  "$(rpc tools/call '"name":"crm__delete_customer","arguments":{"id":"c-001"}' crm__read_customer)"
check "server/discover"                      200 '"supportedVersions"' "$(rpc server/discover '')"

status="$(curl -s -o /dev/null -w '%{http_code}' "$GATEWAY/mcp")"
[[ "$status" == 405 ]] && echo "PASS  GET /mcp -> 405" || { echo "FAIL  GET /mcp -> $status"; fail=1; }

exit "$fail"
