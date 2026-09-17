# witness-serve production pin

Authoritative loopback host for `https://witness.outbid.sh` (systemd user unit
`witness.service` on `:4032`).

| Field | Value |
|---|---|
| Worktree | `/home/twzrd/witness-serve` |
| Git SHA | `180cc37ff62c54cbbe90237009bc21c3c6c5396b` |
| Branch tip | `origin/master` (detached checkout) |
| Previous pin | `2054818` (`feat(witness): explicit browse retrieve…` #52) |
| Upgraded (UTC) | 2026-09-17 |
| Env file | `/home/twzrd/witness-serve/.env` (not in git) |

## Upgrade verification (2026-09-17)

- `npm ci` + `npm test`: **752** pass
- `systemctl --user restart witness.service`: active, `witness listening on http://127.0.0.1:4032`
- `GET http://127.0.0.1:4032/openapi.json` → 200
- `GET https://witness.outbid.sh/llms.txt` → 200
- Shopify mandate modules present; **`SHOPIFY_STORE_URL` unset** → mandate path no-op

## Systemd

Stock unit file references `/home/twzrd/witness`; live drop-in overrides
**WorkingDirectory**, **ExecStart**, and **ExecStartPre** to this worktree and
`.env`. Do not prune this worktree.

## Refresh procedure

```bash
git -C /home/twzrd/witness-serve fetch origin
git -C /home/twzrd/witness-serve checkout --detach origin/master
cd /home/twzrd/witness-serve && npm ci && npm test
echo "$(git -C /home/twzrd/witness-serve rev-parse HEAD)" > /home/twzrd/witness-serve/SERVE_SHA
systemctl --user restart witness.service
```

Update this doc and commit when the pin changes.
