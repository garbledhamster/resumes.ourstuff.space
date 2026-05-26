# ResumeDoc

`resumes.ourstuff.space` is a static resume packet app backed by Firebase Auth,
a targeted Firebase Function codebase, and the shared Ourstuff Stripe Worker.

## Local Test

Open the repo with Five Server, then use the local function base in `config.js`:

```powershell
cd C:\Github\resumes.ourstuff.space\functions-resumes
npm install
cd ..
firebase emulators:start --only functions,firestore,storage
```

The app uses Firebase sign-in, creates private resume packages, starts Stripe
Checkout through `C:\Codex\stripe-worker-api`, and downloads the generated DOCX
through the authenticated Firebase API.

## Ready Check

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\github-ready.ps1 -UiChanged
```

Reports are written to `artifacts\frontend-validation`.

## Deploy Notes

Use targeted deploys for the shared Firebase project:

```powershell
firebase deploy --only functions:resumes --project ourstuff-firebase
```

The checked-in Firestore and Storage rules include the current Ourstuff/AI Brain
rules plus ResumeDoc private package paths, but avoid broad deploys unless you
intend to refresh shared rules.

The Stripe checkout route lives in the shared Worker:

```powershell
cd C:\Codex\stripe-worker-api
npm run deploy
```
