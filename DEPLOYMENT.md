# Deploying the backend (Render)

Render's free/starter tier is simplest for a Node + WebSocket server like this
one — Vercel's serverless functions don't hold persistent WebSocket
connections, which is why your original deployment couldn't have supported
live chat even once it was fixed.

## 1. Push this folder to a GitHub repo
```bash
cd private-line-backend
git init
git add .
git commit -m "Private Line backend"
git branch -M main
git remote add origin https://github.com/<you>/private-line-backend.git
git push -u origin main
```

## 2. Create the Render service
1. https://render.com → New → Web Service
2. Connect your GitHub repo
3. Settings:
   - **Runtime**: Node
   - **Build command**: `npm install`
   - **Start command**: `npm start`
   - **Instance type**: Free (fine for testing; upgrade before real users — free
     instances spin down after inactivity, which will drop WebSocket connections)

## 3. Set environment variables
In Render's dashboard → Environment:
- `JWT_SECRET` — generate with `openssl rand -base64 48`, paste the output
- `PORT` — Render sets this automatically, you don't need to add it

## 4. Note your service URL
Render gives you something like `https://private-line-backend.onrender.com`.

- REST base URL for the Android app's `ApiService.BASE_URL`:
  `https://private-line-backend.onrender.com/`
- WebSocket URL for `ChatWebSocketClient`:
  `wss://private-line-backend.onrender.com/ws`

## 5. Database persistence

`db.js` uses a local SQLite file (`private_line.db`). On Render's free tier,
disk is **ephemeral** — it resets on redeploy. For anything beyond testing:
- Add a Render Disk (persistent volume) mounted where the app runs, or
- Swap SQLite for Render's managed Postgres (a bigger change — happy to do
  this migration when you're ready to move past the testing phase)

## 6. Point the Android app at it

Update `BASE_URL` in `network/ApiService.kt` and the WebSocket URL wherever
`ChatWebSocketClient` is constructed, then rebuild.
