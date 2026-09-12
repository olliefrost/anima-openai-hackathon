import asyncio
import os
import time
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles


ROOT = Path(__file__).resolve().parent.parent
DASHBOARD = Path(__file__).resolve().parent
DIST = DASHBOARD / "dist"
SITES = ("gp", "pharmacy", "community")
MAX_REQUEST_BYTES = 4096
SIMULATOR_URL = "https://sim.animahacks.com"

load_dotenv(ROOT / ".env")

app = FastAPI(title="Careloop", docs_url=None, redoc_url=None)


class SimulatorError(Exception):
    pass


@app.middleware("http")
async def secure_local_access(request: Request, call_next):
    allowed_hosts = {"localhost", "127.0.0.1", "testserver"}
    if request.url.hostname not in allowed_hosts:
        response = JSONResponse({"error": "Local access only."}, status_code=403)
    elif request.url.path == "/api/data" and request.headers.get("origin"):
        origin = request.headers["origin"]
        allowed_origins = {
            f"http://localhost:{request.url.port or 80}",
            f"http://127.0.0.1:{request.url.port or 80}",
            "http://localhost:5173",
            "http://127.0.0.1:5173",
        }
        if origin not in allowed_origins:
            response = JSONResponse({"error": "Origin not allowed."}, status_code=403)
        else:
            response = await call_next(request)
    else:
        response = await call_next(request)

    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; style-src 'self'; script-src 'self'; "
        "connect-src 'self'; frame-ancestors 'none'"
    )
    return response


async def upstream(client: httpx.AsyncClient, path: str, key: str, **params: Any):
    try:
        response = await client.get(path, params=params, headers={"Authorization": f"Bearer {key}"})
        response.raise_for_status()
        data = response.json()
        if not isinstance(data, dict):
            raise SimulatorError("Unexpected simulator response.")
        return data
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        if status == 401:
            raise SimulatorError("Invalid simulator team key.") from exc
        if status == 403:
            raise SimulatorError("Team key does not have access to this service.") from exc
        raise SimulatorError(f"Simulator returned HTTP {status}.") from exc
    except (httpx.RequestError, httpx.TimeoutException) as exc:
        raise SimulatorError("Cannot reach NHS-SIM. Check your network and retry.") from exc
    except ValueError as exc:
        raise SimulatorError("Unexpected simulator response.") from exc


async def patients_for(client: httpx.AsyncClient, site: str, resources: list[dict], key: str):
    patient_ids = list(dict.fromkeys(resource.get("patientId") for resource in resources if resource.get("patientId")))

    async def find_patient(patient_id: str):
        page = await upstream(client, f"/api/sites/{site}/patients", key, q=patient_id, offset=0)
        if not isinstance(page.get("items"), list):
            raise SimulatorError("Unexpected simulator patient response.")
        return next((patient for patient in page["items"] if patient.get("id") == patient_id), None)

    patients = []
    for offset in range(0, len(patient_ids), 10):
        batch = await asyncio.gather(*(find_patient(patient_id) for patient_id in patient_ids[offset : offset + 10]))
        patients.extend(patient for patient in batch if patient is not None)
    return patients


async def site_data(client: httpx.AsyncClient, site: str, key: str):
    view = await upstream(client, f"/api/sites/{site}/view", key, offset=0, limit=500)
    resources = view.get("resources")
    if not isinstance(resources, list):
        raise SimulatorError("Unexpected simulator response.")
    patients = await patients_for(client, site, resources, key)
    resource_total = view.get("resourceTotal", len(resources))
    if not isinstance(resource_total, (int, float)):
        raise SimulatorError("Unexpected simulator response.")
    return {**view, "patients": patients, "truncated": len(resources) < resource_total}


@app.post("/api/data")
async def get_data(request: Request):
    body = await request.body()
    if len(body) > MAX_REQUEST_BYTES:
        return JSONResponse({"error": "Request too large."}, status_code=413)
    try:
        payload = await request.json() if body else {}
    except ValueError:
        return JSONResponse({"error": "Invalid request."}, status_code=400)
    key = (payload.get("key") or os.getenv("SIM_API_KEY")) if isinstance(payload, dict) else None
    if not isinstance(key, str) or not key:
        return JSONResponse(
            {"error": "Enter your NHS-SIM team API key, or set SIM_API_KEY in .env."},
            status_code=401,
        )

    try:
        async with httpx.AsyncClient(base_url=SIMULATOR_URL, timeout=20) as client:
            team = await upstream(client, "/api/team", key)

            async def load_site(site: str):
                try:
                    return {"site": site, **await site_data(client, site, key)}
                except SimulatorError as exc:
                    return {"site": site, "error": str(exc), "resources": [], "patients": []}

            sources = await asyncio.gather(*(load_site(site) for site in SITES))
        return {"team": team, "sources": sources, "fetchedAt": int(time.time() * 1000)}
    except SimulatorError as exc:
        return JSONResponse({"error": str(exc)}, status_code=502)


app.mount("/assets", StaticFiles(directory=DIST / "assets", check_dir=False), name="assets")


@app.get("/", include_in_schema=False)
async def index():
    index_file = DIST / "index.html"
    if not index_file.is_file():
        return JSONResponse(
            {"error": "Frontend build not found. Run `npm run build`, or use `npm run dev` for Vite development."},
            status_code=503,
        )
    return FileResponse(index_file)


@app.get("/{path:path}", include_in_schema=False)
async def frontend_route(path: str):
    if "." in Path(path).name:
        return JSONResponse({"error": "Not found"}, status_code=404)
    index_file = DIST / "index.html"
    return FileResponse(index_file) if index_file.is_file() else JSONResponse({"error": "Frontend build not found."}, status_code=503)
