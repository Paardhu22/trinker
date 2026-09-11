# OWASP Juice Shop Evaluation

This compose file starts the intentionally vulnerable Juice Shop only for authorized local evaluation.

```bash
docker compose up -d
```

Use a separate target project directory for `.trinker/runtime.json`, pointing its `local` target at `http://localhost:3000`. Do not use this setup against a shared or production instance. The Phase-1 compiler only discovers source routes; Juice Shop's dynamic API requires a reviewed hand-written plan or a future OpenAPI/crawler input.
