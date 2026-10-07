# Webhooks

`POST /api/plaid/webhook` verifies Plaid's signed JWT before trusting anything,
including a SHA-256 of the body so a genuine signature cannot be replayed over a
tampered payload. Local development needs a tunnel:

```bash
cloudflared tunnel --url http://localhost:3000
```

Without a webhook URL, the daily cron still syncs once a day and the **Refresh**
button still works on demand; you just don't get pushed updates between runs.
