# Shared web Gantt (Cloudflare Pages + Access)

A small site that shows and edits the task notes in one private GitHub repo
(`REPO` in `wrangler.toml`). The Obsidian plugin's **Shared folder (GitHub)** setting mirrors
that same repo into a vault folder, so edits made here show up in Obsidian and vice versa.

- `public/`: the page (`app.js` is built from `src/` with `npm run build:web` at the repo root).
- `functions/api/[[path]].ts`: the only code that talks to GitHub. It holds the token, checks
  the Cloudflare Access login on every request, and only touches `.md` task files in `REPO`.

## Security model

- Cloudflare Access sits in front of the site: only the emails you allow can load it.
- The API also verifies the signed Access token itself (signature, audience, issuer, expiry)
  and checks the email against `ALLOWED_EMAILS`. If any of those settings is missing it refuses
  every request, so a misconfigured deploy fails closed. This also covers the `*.pages.dev`
  address, which Access doesn't protect by default.
- The GitHub token never reaches the browser. Use a fine-grained token limited to the one repo.
- Paths with `..`, dot-folders or non-Markdown files are rejected; the repo README is never
  served or written.
- Every web edit is a commit that names who made it: `Web edit by david@…: Task.md`.

## One-time setup

1. **GitHub token**: github.com → Settings → Developer settings → Fine-grained tokens →
   Generate. Resource owner: you. Repository access: *Only select repositories* →
   `dermaglow-tasks`. Permissions: *Contents: Read and write* (Metadata: read is added
   automatically). Copy the token.
2. **Deploy** (from this `web/` folder, once):
   ```
   npx wrangler login
   npx wrangler pages deploy
   ```
   The first run asks to create the `dermaglow-gantt` project; accept.
3. **Custom domain**: Cloudflare dashboard → Workers & Pages → dermaglow-gantt →
   Custom domains → add e.g. `gantt.yourdomain.com`.
4. **Cloudflare Access**: Zero Trust → Access → Applications → Add → Self-hosted.
   - Domain: `gantt.yourdomain.com`. Add a second destination for `dermaglow-gantt.pages.dev`
     too, so the default address is covered as well.
   - Policy: Allow, Include → Emails → your email and David's.
   - Save, then open the application and copy the **Application Audience (AUD) Tag**.
   - Your team domain is shown under Zero Trust → Settings → Custom pages
     (`<team>.cloudflareaccess.com`).
5. **Variables**: Workers & Pages → dermaglow-gantt → Settings → Variables and secrets
   (Production), then redeploy (`npx wrangler pages deploy`) so they take effect:
   - `GITHUB_TOKEN` (secret): the token from step 1
   - `ALLOWED_EMAILS` (secret): `you@example.com,david@example.com`
   - `ACCESS_TEAM_DOMAIN`: `<team>.cloudflareaccess.com`
   - `ACCESS_AUD`: the AUD tag from step 4

`REPO` and `BRANCH` come from `wrangler.toml`.

## Updating

After changing `src/`, run `npm run build:web` at the repo root, then `npx wrangler pages deploy`
from `web/`.
