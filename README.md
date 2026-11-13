# BoloYaar

Lightweight "talk to strangers" voice + text chat. One Node.js file, one HTML page, no dependencies, no build step.
"BoloYaar" is a placeholder name. Search and replace it in `public/` to rename.

## Run it

    node server.js

Open http://localhost:3000 in two browser tabs (or a tab and a private window), create an ID in each, and press **Start talking**.
Needs Node 18 or newer.

## Features

- Five screens: landing page, "how do you want to join", sign up / log in / guest form, lobby, and the call screen.
- Accounts (username + password) or "continue without signing up". Sign-up and guest entry both need the "18+ and I agree to the Terms" checkbox; the server enforces it and logs each consent to `data/consent.log`.
- Random 1-to-1 voice calls (WebRTC, peer to peer) with text chat and a "… is typing" indicator. Mic denied = listen and type only.
- A live sound wave and a glowing orb that move with the real voices on the call.
- Add friend during a call (both people need an account, and the other person must accept). Friends appear in the lobby with online status and a Call button that rings them directly.
- Country: everyone picks their country when they join. It is shown to the person they talk to, and the lobby has a free "From" filter to match only with one country.
- Mute, Next, End, Report.
- Gender preference filter (Anyone / Female / Male), locked behind Premium and enforced on the server. After 30 s without a match the user is offered "Match with anyone".
- Calls are never cut automatically: no time limit, automatic ICE restart on weak networks, and a 30 s grace period if a user's connection drops.
- Reports go to `data/reports.log`. Three reports from different IP addresses block that IP for 24 hours.
- Passwords are stored as salted scrypt hashes. Accounts live in `data/users.json`.

## Settings (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | Port to listen on |
| `PREMIUM_CODES` | `DEMO-PREMIUM` | Comma-separated codes that unlock the gender filter. Demo only. |
| `TURN_URL`, `TURN_USER`, `TURN_PASS` | none | TURN relay (e.g. coturn) for users behind strict networks |
| `TRUST_PROXY` | off | Set to `1` behind nginx or Caddy so the real IP is read from `X-Forwarded-For` |
| `GRACE_MS` | 30000 | How long a dropped user's call is held |
| `DATA_DIR` | `./data` | Where accounts and logs are saved. Back this folder up. |

## Before a public launch

1. **HTTPS is required.** Browsers only allow the microphone on `https://` (or `localhost`). Put the server behind Caddy or nginx with a certificate.
2. **Add a TURN server.** Without one, roughly 1 in 5 calls on mobile data or office Wi-Fi will not connect.
3. **Replace the premium code with real payments** (e.g. Razorpay). The check is one line in `server.js`, marked with a comment.
4. **Get `public/terms.html` reviewed by a lawyer** and fill in the bracketed parts. It is a draft.
5. **Moderation.** Reports are only written to a file. Someone has to read them. Bans and reports are held in memory and reset when the server restarts.
6. **Accounts are basic.** There is no email, so there is no password reset yet. `data/users.json` should move to a real database before you have many users.
7. One server process holds all state in memory. That is fine for thousands of users; beyond that it needs a shared store.

## Tests

    node test/signaling.test.js   # server logic: consent, accounts, matching, filter, friends, resume, report
    node test/browser.test.js     # real call between two headless Chrome tabs with fake microphones

    node test/load.test.js 5000   # 5,000 simulated users joining, matching, chatting and pressing Next

All need Node 22+. The browser test also needs `google-chrome`.

## Load test results

Run in a 2-core cloud sandbox, with the simulated users on the same machine as the server:

| Users online | Dropped | Time to get matched (95%) | Server response (99%) | CPU (one core) | Memory |
|---|---|---|---|---|---|
| 5,000 | 0 | under 12 ms | under 52 ms | 10% | 134 MB |
| 15,000 | 0 | under 8 ms | under 7 ms | 28% | 168 MB |

This measures the matching and signalling server only. Voice audio is peer to peer and does not pass through it.
The test does not cover HTTPS, real internet latency, or the TURN relay, which carries the audio for calls that cannot connect directly.
For 5,000 real users, raise the open-file limit on the server (`ulimit -n 65535`) because each user holds one connection.
