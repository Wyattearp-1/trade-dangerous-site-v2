# Trade Dangerous — Web

A browser port of the core idea behind [Trade Dangerous](https://github.com/eyeonus/Trade-Dangerous):
a multi-hop trade route optimizer for Elite: Dangerous.

This is **not** the original TD codebase. TD is a Python CLI/GUI app with its own SQLite
database. This project re-implements the *routing idea* as a self-contained static site
and uses GitHub Actions to keep trade data as fresh as a static site can be.

## One-shot GitHub setup

1. Create a new empty repository on GitHub.
2. Push this folder as the **root** of that repo (not nested inside another folder):

   ```bash
   cd trade-dangerous-web
   git init
   git add .
   git commit -m "Initial Trade Dangerous Web"
   git branch -M main
   git remote add origin https://github.com/YOUR_USER/YOUR_REPO.git
   git push -u origin main
   ```

3. In the repo on GitHub:
   - **Settings → Pages → Build and deployment → Source** → **GitHub Actions**
   - **Settings → Actions → General** → allow Actions / allow workflows to run
   - (Optional) **Settings → Actions → General → Workflow permissions** → Read and write
     (needed so the data-refresh workflow can commit updated `trade-data.json`)

4. Open the **Actions** tab → run **Deploy to GitHub Pages** and **Refresh trade data**
   once each via *Run workflow*. After that, the schedule keeps data updated and every
   push to `main` redeploys the site.

The site works immediately with the included sample dataset. The first real data
rebuild may take several minutes depending on the source and size of the dump.

## Data sources

| Source     | How to use                                      | Notes |
|------------|--------------------------------------------------|-------|
| **Spansh** (default) | `TD_SOURCE=spansh` or workflow default | Full station/market dump from [spansh.co.uk/dumps](https://spansh.co.uk/dumps). Large; Actions use a soft station cap. |
| **EDDBlink / Tromador** | `TD_SOURCE=eddblink` or choose in workflow UI | Same feed [Trade Dangerous recommends](https://github.com/eyeonus/Trade-Dangerous/wiki/Plugin-Options). Often smaller / fresher live prices. |
| **Sample** | `TD_SOURCE=sample` | Leaves the checked-in demo data alone. |

**Inara:** Inara does not offer a public bulk market dump or bulk API suitable for offline
routing (only a rate-limited CMDR/profile API). The UI therefore links every station in
route results to Inara so you can verify live prices and details there.

Override the Spansh URL with `TD_SOURCE_URL` or the Tromador base with `TD_EDDBLINK_BASE`
if upstream paths change.

## Local development

```bash
# serve the static site
python -m http.server 8000
# open http://localhost:8000

# optional: rebuild data yourself
pip install -r scripts/requirements.txt
python scripts/build_data.py --source spansh --out data/trade-data.json --max-stations 10000
python scripts/build_data.py --source eddblink --out data/trade-data.json
```

## Data shape (contract for the optimizer)

```json
{
  "generated_at": "2026-09-26T00:00:00Z",
  "source": "…",
  "systems":  { "SYSTEM NAME": { "x": 0, "y": 0, "z": 0 } },
  "stations": {
    "SYSTEM NAME/STATION NAME": {
      "system": "SYSTEM NAME",
      "pad": "L",
      "distLs": 490,
      "planetary": false,
      "market": {
        "COMMODITY NAME": { "buy": 9250, "sell": 8900, "supply": 3400, "demand": 0 }
      }
    }
  }
}
```

## What the optimizer does

Multi-hop trade runs in the browser (`js/optimizer.js`): start station, credits,
insurance reserve, cargo capacity, jump range, max jumps per hop, hop count,
avoid-lists, optional “head toward” system, optional loop, minimum profit.
At each hop it evaluates nearby stations, picks the best cargo load, and keeps
a beam of the best partial routes.

This is a genuine re-implementation of TD’s *approach*, not a guarantee of
identical output to the real tool (which has years of edge-case handling).

## License

MIT for this code. Not affiliated with Frontier Developments, Elite Dangerous,
Trade Dangerous, Spansh, Inara, or Tromador — inspired by Trade Dangerous only.
