# LexAI — Deploy Guide

This folder is a complete, deployable app:

- `index.html` — the frontend (everything you've seen so far)
- `api/chat.js` — a small backend that holds your Gemini API key and talks to Google on the frontend's behalf
- `package.json` — lets Vercel recognize this as a Node project

No API key is ever exposed to the browser — it lives only on the server side, as an environment variable.

## 1. Get a Gemini API key

Go to **https://aistudio.google.com/apikey**, sign in, and create a key. Copy it — you'll paste it into Vercel in step 3.

## 2. Push this folder to GitHub (or skip to step 3 and drag-and-drop instead)

```bash
cd lexai-app
git init
git add .
git commit -m "LexAI initial deploy"
```

Create a new empty repo on GitHub, then:

```bash
git remote add origin https://github.com/YOUR_USERNAME/lexai-app.git
git push -u origin main
```

*(No GitHub? On vercel.com you can also just drag the whole `lexai-app` folder into the "Add New Project" screen — no git required.)*

## 3. Deploy on Vercel

1. Go to **https://vercel.com/new**
2. Import the GitHub repo (or drag-and-drop the folder)
3. Before clicking Deploy, open **Environment Variables** and add:
   - `GEMINI_API_KEY` → paste the key from step 1
   - *(optional)* `GEMINI_MODEL` → only set this if you want a model other than the default (`gemini-3.6-flash`)
4. Click **Deploy**

Vercel gives you a live URL like `https://lexai-app.vercel.app` — that's it. It works from any browser, any device, not just inside Claude.ai.

## 4. Test it

Open your deployed URL, ask a research question. If something's wrong, check **Vercel → your project → Deployments → the latest one → Functions → api/chat** for the error log — the backend returns a plain-English `error` field if the Gemini call fails (e.g. bad key, wrong model name).

## Updating later

Any time you want UI changes, edit `index.html` and redeploy (`git push`, or drag-and-drop again). The backend (`api/chat.js`) only needs to change if you want to switch providers or change how the AI is prompted.
