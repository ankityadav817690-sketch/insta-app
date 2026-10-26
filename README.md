# InstaClone — multi-user photo & reels app

Real accounts, real posting. No external npm packages: Node 22 + built-in SQLite.

## Run

```bash
cd insta-app
node server.js                 # http://localhost:3000
PORT=8080 node server.js       # another port
```

## Features

- **Accounts** — signup (name, username, optional email), login by username or email, logout, change password
- **Forgot password** — reset code valid 30 minutes, signs out all old sessions
- **Posts** — upload a photo (jpg/png/gif/webp, max 10 MB) with caption, delete your own
- **Feed** — your posts + people you follow (falls back to everyone until you follow someone)
- **Likes** (tap or double-tap), **comments**, **saves/bookmarks**
- **Stories** — photo stories that expire after 24 hours, seen/unseen rings, auto-advancing full-screen viewer with progress bars
- **Reels** — vertical full-screen video feed with snap scroll, autoplay of the visible reel, likes, upload up to 50 MB (mp4/webm/mov)
- **Explore** — all posts grid + search people
- **Follow / unfollow**, followers & following lists (tap the numbers)
- **Profile** — posts grid, profile photo upload, edit name and bio

## Files

```
insta-app/
  server.js          API + static server (all endpoints under /api)
  public/index.html  whole frontend in one file
  uploads/           uploaded photos, videos and avatars
  insta.db           SQLite database (created on first run)
```

Set `DATA_DIR=/data` (a mounted persistent disk) on a host so `insta.db` and `uploads/` survive deploys. `DB_PATH` and `UPLOAD_DIR` override them individually.

## API quick reference

```
POST /api/signup            {fullname, username, email, password}
POST /api/login             {username, password}
POST /api/logout
GET  /api/me
POST /api/forgot            {usernameOrEmail}   -> {resetToken}
POST /api/reset             {token, password}
POST /api/change-password   {current, next}
GET  /api/posts?mode=feed|explore|saved
POST /api/posts             multipart: image, caption
POST /api/posts/:id/like | /save | /comments   DELETE /api/posts/:id
GET  /api/stories           POST /api/stories (multipart: media)   POST /api/stories/:id/view
GET  /api/reels             POST /api/reels (multipart: video, caption)   POST /api/reels/:id/like
POST /api/profile           multipart: fullname, bio, avatar
GET  /api/users/search?q=   GET /api/users/suggested
GET  /api/users/:u          /posts  /followers  /following   POST /api/users/:u/follow
```

## Deploy so phones can use it

Needs a Node host, not a static host (Netlify Drop will not work — there is a server and a database).

1. Push the folder to GitHub.
2. Render.com (or Railway): new Web Service, start command `node server.js`.
3. Add a persistent Disk mounted at `/data` and set env `DATA_DIR=/data`.
4. You get a public URL like `https://your-app.onrender.com` — open it on any phone and use "Add to Home screen" for an app-like icon.

## Known limits

- Password reset shows the reset code on screen because no email service is wired up. To send it by email, plug in an SMTP/API mail provider in `/api/forgot` and remove `resetToken` from the response.
- Images/videos live on disk — for a real launch use S3 or Cloudinary.
- No rate limiting, email verification or content moderation yet.
- Stories expire by timestamp; old rows are not cleaned up automatically.
