# Routine Tracker

A modern, server-based routine tracker with two scheduling models, browser-specific Google account sessions, server-side encrypted Google OAuth tokens, Google Drive backup/restore, and an in-app calendar that syncs Google Calendar events.

## 1. What is included

### Two routine types

**Frequency target** — track a minimum/maximum count over a repeating period. Example: aloe vera 2–3 times every 1 week. Each check-in is recorded, progress is counted within the current period, and the app distinguishes the minimum target from an optional extra.

**Repeat after completion** — schedule the next occurrence from the actual completion time. Example: change bedsheets every 2 weeks. If the task is due in week 2 but you complete it in week 3, the next date is week 5. It does not keep the old schedule and does not create a backlog of missed occurrences.

Frequency periods are anchored to the start date you choose. A period of `1 week` means seven days from that anchor; a period of `1 month` follows calendar months.

### Google account and browser sessions

- Each browser receives its own HTTP-only, signed session cookie.
- The server stores the session and the browser's Google account association in SQLite.
- Google access/refresh tokens are stored only on the server and encrypted with AES-256-GCM.
- A browser that has already connected normally returns to its own app session without signing in again.
- The **Switch account** action opens Google's account chooser. A different browser can connect a different Google account.
- Browsers connected to the same Google account share that account's routine data when they use the same server/database.

The session cookie is configured for one year and rolls forward as the browser revisits the app. No web app can promise a session literally forever: users can clear cookies, browsers can remove old cookies, servers can be reset, and Google can revoke or expire refresh tokens. Use HTTPS in any public deployment.

### Google Drive

The app writes a visible file called **Routine Tracker Backup.json** in the connected user's My Drive. It contains routine definitions and completion history. Changes are backed up automatically after a short pause, and the Settings page also has manual **Sync to Drive** and **Restore from Drive** controls. Restore merges records and does not delete the current data.

The integration requests Google's `drive.file` scope, which limits app access to files created/opened by this app. It does not request unrestricted access to the user's entire Drive.

### Google Calendar

The app syncs the connected Google account's **primary calendar** and shows Google events, routine due dates, and completion markers in the in-app month calendar. Incremental sync tokens are stored on the server; the calendar refreshes in the background every few minutes and when the calendar page is opened.

Google Calendar's legacy feed format is iCalendar/ICS rather than a general RSS feed. This app uses the official Calendar API instead of depending on an RSS/ICS URL, because the API supports incremental updates and deleted events. Calendar access is read-only; the app does not create or edit Google Calendar events.

## 2. Run locally on your laptop

You need Node.js 20 or newer and npm.

1. Extract the project folder.
2. Open a terminal in that folder.
3. Install the dependencies:

   ```bash
   npm install
   ```

4. Create your environment file:

   **Windows PowerShell**

   ```powershell
   Copy-Item .env.example .env
   ```

   **macOS / Linux**

   ```bash
   cp .env.example .env
   ```

5. Generate two secrets. Run this twice and use the first output as `SESSION_SECRET`. Use the second output as the encryption key.

   ```bash
   openssl rand -hex 32
   ```

   Put the first value in `SESSION_SECRET`. Put the second value in `TOKEN_ENCRYPTION_KEY`. The encryption key must be exactly 64 hexadecimal characters.

6. Edit `.env`. You can start the app without Google credentials, but Google features remain disconnected until OAuth is configured.
7. Start the app:

   ```bash
   npm start
   ```

8. Open [http://localhost:4317](http://localhost:4317).

**Port note (Windows):** this version uses port `4317` by default to avoid the common `3000` conflict. When upgrading an existing installation, edit your existing `.env` file (not just `.env.example`) and set these three lines to the same port:

   ```dotenv
   PORT=4317
   BASE_URL=http://localhost:4317
   GOOGLE_REDIRECT_URI=http://localhost:4317/auth/google/callback
   ```

   Also add `http://localhost:4317/auth/google/callback` under **Authorized redirect URIs** in your Google OAuth client. Then stop the old Node process and run `npm start` again.

Your routine data is stored in `data/routine-tracker.sqlite`. Keep that file to retain your routines and completion history.

## 3. Configure Google OAuth, Drive, and Calendar

You need a Google Cloud project and a Web application OAuth client.

1. Open the [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select a project.
3. Enable **Google Drive API** and **Google Calendar API** for the project.
4. Configure the OAuth consent screen / Google Auth Platform. For a personal setup, add your Google account as a test user while developing.
5. Create an OAuth Client ID with application type **Web application**.
6. Add this exact Authorized redirect URI:

   ```text
   http://localhost:4317/auth/google/callback
   ```

7. Copy the Client ID and Client Secret into `.env`:

   ```dotenv
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REDIRECT_URI=http://localhost:4317/auth/google/callback
   BASE_URL=http://localhost:4317
   COOKIE_SECURE=false
   ```

8. Restart the Node server, open the app, go to **Settings & sync**, and choose **Connect Google**.

The requested permissions are: basic Google identity, Google Drive files created/opened by this app, and read-only access to Calendar events. Google may show an unverified-app warning while the OAuth project is in testing. Do not share the OAuth client with people you do not trust until you have completed the appropriate Google publishing and verification requirements.

**Important refresh-token testing limitation:** for an External OAuth consent screen left in **Testing**, Google generally issues refresh tokens that expire after 7 days when non-basic scopes such as Drive or Calendar are requested. Before relying on automatic long-term sync, publish the OAuth app to **In production** and complete any verification Google requires. Even production refresh tokens can be invalidated by revocation, long inactivity, account policy, or other Google security events. If that happens, reconnect Google in Settings.

## 4. Browser-specific Google accounts

The first time you connect Google in a browser, the OAuth callback is tied to that browser's session cookie. The server records that browser session's Google account. Later visits in that browser reuse the app session. A new browser starts with a separate local profile and can connect a different Google account.

To change the Google account associated with a browser, go to **Settings & sync → Switch account**. This opens Google's account chooser. Signing out of Google on a browser moves that browser to a new local workspace; it does not revoke the server token or disconnect other browsers using the same Google account.

The app uses one server database. If the same Google account is used in two browsers on this same server, both browsers see the same routines. If you run completely separate installations on different machines, use the Drive backup/restore feature to move the data between them.

## 5. Move it to Oracle Cloud Infrastructure later

The project is Docker-ready. The SQLite database is kept in `/app/data`, which is mounted from the host at `./data` in `docker-compose.yml`.

A straightforward OCI deployment is:

1. Create an OCI Compute VM (Oracle Linux or Ubuntu) and attach a persistent block volume for app data.
2. Install Docker Engine and the Docker Compose plugin.
3. Copy this project to the VM and put the persistent volume at a stable path, such as `/srv/routine-tracker/data`.
4. Put `.env` on the VM. **Keep the same `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` when migrating an existing database.** Changing the encryption key makes previously encrypted Google tokens unreadable.
5. Set your public HTTPS URL:

   ```dotenv
   BASE_URL=https://routines.example.com
   GOOGLE_REDIRECT_URI=https://routines.example.com/auth/google/callback
   COOKIE_SECURE=true
   NODE_ENV=production
   ```

6. Add the matching HTTPS redirect URI to your Google OAuth client in Cloud Console.
7. Configure a reverse proxy such as Caddy or Nginx to terminate HTTPS and forward traffic to port 4317. `Caddyfile.example` is included as a starting point.
8. Ensure the data directory is on the persistent volume. Either run the compose project from the mounted volume or change the `./data:/app/data` mapping in `docker-compose.yml` to the actual host path. Ensure the mounted data folder is writable by the container user (UID 1000), for example with `sudo chown -R 1000:1000 /srv/routine-tracker/data`.
9. Build and start:

   ```bash
   docker compose up -d --build
   ```

Do not expose the app publicly over plain HTTP. Use HTTPS so the session cookie can be marked Secure. Back up the SQLite database and `.env` secrets securely. The Drive backup is an additional data backup, not a substitute for protecting the server database and encryption key.

## 6. Useful commands

```bash
# Start normally
npm start

# Development mode (Node watch mode)
npm run dev

# Docker build and launch
docker compose up -d --build

# View logs
docker compose logs -f routine-tracker

# Stop container
docker compose down
```

Health endpoint: `GET /api/health`.

## 7. Notes and current boundaries

- The app is designed as a single-server, personal tracker. SQLite is appropriate for a laptop or one OCI VM with persistent storage; use a managed database if you later want multiple app servers or high concurrency.
- Google Calendar integration currently displays the primary calendar only, and is read-only.
- The app stores Google Calendar event copies in its database and refreshes them incrementally. It does not publish an RSS feed of your routines.
- Routine frequency periods are anchored to their chosen start date, not automatically aligned to Monday or the first day of a calendar month.
- A completion can be logged whenever it is actually done. For interval routines, that completion time determines the next due date.
- Drive backups are merged during restore. If two separate installations both edit the same routine while offline, the last-updated routine definition wins when merged; completion history is retained by unique completion ID.
- Keep the `data` folder and encryption key private. The server should be accessible only through a trusted HTTPS endpoint if deployed publicly.

## Official Google documentation

- [OAuth 2.0 web server applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google OAuth refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)
- [Google Drive API OAuth scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Google Calendar incremental synchronization](https://developers.google.com/workspace/calendar/api/guides/sync)
- [Google Calendar API authorization scopes](https://developers.google.com/workspace/calendar/api/auth)
