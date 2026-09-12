# Careloop

Install dependencies and start the dev servers from the repository root:

```sh
npm install
npm run dev
```

Then open http://localhost:5173. Vite serves the React frontend and proxies `/api` requests to the Node API on http://localhost:8000.

If startup reports `EADDRINUSE`, another Careloop dev session is already using ports 5173 and 8000. Use that session or stop it before running `npm run dev` again. Vite intentionally does not switch to another port because the API only accepts requests from the configured local frontend origin.

The dashboard starts empty. Click **Connect simulator** and enter your NHS-SIM team API key, or set `SIM_API_KEY` in the root `.env` and submit the connection form with its key field empty. This is separate from `OPENAI_API_KEY`.

The local Node server calls the documented read-only NHS-SIM `/api/team`, `/api/sites/{site}/view`, and `/api/sites/{site}/patients` endpoints for GP, pharmacy, and community care. It loads up to the API maximum of 500 resources per service and labels a service when more history exists; resource IDs in that working set are deduplicated by version. Failed sources are reported individually. Credentials remain in memory or the server environment, never browser storage.

Review flags and notes are saved in this browser, separated by simulator world. They do not update source records or mark clinical work completed. Refresh manually to fetch changes. Due dates use the simulator clock; undated open items older than 48 hours are labelled for review as a heuristic. Missing records or handoffs cannot be proven from these signals. Only patient-linked records appear in the worklist. Shared resources count once globally but in every service where visible.

Run `npm test` to check deduplication and attention rules, and `npm run build` to create the production frontend in `dashboard/dist`. After building, `npm start` serves the complete app through the Node server at http://localhost:3000. Both development servers bind to loopback only. API reference: https://sim.animahacks.com/docs/explorer/.
