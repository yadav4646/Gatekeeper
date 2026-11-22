# Keycloak realm

`gatekeeper-realm.json` (agents, roles and the gateway audience mapper) lands here in
M2 and is imported on startup via `--import-realm`. Until then Keycloak starts empty;
the admin console is at http://localhost:8081 (admin/admin, local only).
