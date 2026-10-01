# Job Hunt Agent project instructions

Before changing this project, read `SESSION_HANDOFF.md` completely, then read the relevant sections of `README.md`.

Security requirements:

- Never print, quote, commit, or copy the value of `GEMINI_API_KEY`, Google credentials, profile contact details, or résumé contents into chat or logs.
- `.env`, `profile.json`, `sources.json`, `Resumes/`, `data/`, browser state, and generated artifacts are private.
- The active background deployment and authoritative live tracker are under `~/Library/Application Support/Job Hunt Agent`; the project directory is the editable source tree.
- Use `install-autopilot.command` after tested source or profile changes. It preserves the deployed `data/` directory.
- Keep final application submission supervised unless the user explicitly changes that requirement after reviewing the safety implications.

Run `npm run typecheck` and `npm test` before redeploying. Verify the live service and `/api/state` after deployment.
