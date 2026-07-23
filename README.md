# Glean Agent — Web UI

A minimal, self-contained web UI that embeds a Glean agent using the
[Glean Web SDK](https://developers.glean.com/libraries/web-sdk/overview).
It renders a full chat assistant grounded in your company knowledge, with
citations back to the source. Results are scoped to what the signed-in user is
allowed to see.

## Files

- `index.html` — the whole app: loads the SDK and calls `GleanWebSDK.renderChat()`.

## Setup

1. **Set the CDN script URL.** In `index.html`, update the SDK `<script src>` with
   the URL from your Glean developer portal (Admin → Platform → Web SDK). It is
   usually served from your backend host, e.g.
   `https://<your-org>-be.glean.com/embedded-search-latest.min.js`.

2. **Fill in `CONFIG`** near the top of the inline script:
   - `backend` — your Glean backend host, e.g. `https://<your-org>-be.glean.com/`
   - `agentId` — the ID of the agent to run.
     > Use `agentId`. Older Glean "Apps" used `applicationId`; new and migrated
     > agents require `agentId`.

3. **Serve the file.** The SDK needs an `http(s)` origin (not `file://`) so its
   auth redirects work. Any static server is fine:

   ```bash
   npx serve .
   # or
   python3 -m http.server 8000
   ```

   Then open the served URL. The origin must be added to your Web SDK's allowed
   domains in the Glean admin console.

## Authentication

### Default SSO (what this scaffold uses)

No backend required. Glean handles login through your configured SSO/OIDC and
scopes every answer to the signed-in user. This is the default `renderChat` call
in `index.html`.

### Server-to-server token (alternative)

If you'd rather mint tokens from your own backend, add a token endpoint and swap
the `renderChat` options:

```js
// Your backend returns { token, expirationTime } for the current user.
async function getGleanToken() {
  const res = await fetch('/api/get-glean-token', { method: 'POST' });
  return res.json();
}

GleanWebSDK.renderChat(document.getElementById('glean-chat'), {
  backend: CONFIG.backend,
  agentId: CONFIG.agentId,
  authMethod: 'token',
  authToken: await getGleanToken(),
  onAuthTokenRequired: async () => getGleanToken(), // refresh on expiry
});
```

See [Server-to-Server Authentication](https://developers.glean.com/libraries/web-sdk/authentication/server-to-server).

## Add a search box (optional)

Alongside chat, the SDK offers an autocomplete search box:

```js
GleanWebSDK.renderSearchBox(document.getElementById('glean-search'), {
  backend: CONFIG.backend,
});
```

Add a `<div id="glean-search"></div>` to the page and call it after the SDK loads.

## References

- [Web SDK overview](https://developers.glean.com/libraries/web-sdk/overview)
- [Chat component](https://developers.glean.com/libraries/web-sdk/components/chat)
- [Web SDK authentication](https://developers.glean.com/libraries/web-sdk/authentication/overview)
