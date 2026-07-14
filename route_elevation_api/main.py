from fastapi import FastAPI, HTTPException
import httpx
import polyline
import math
from fastapi.middleware.cors import CORSMiddleware
import numpy as np
from typing import List, Dict, Any, Optional

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],     # or ["http://localhost:3000"]
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

OSRM_URL = (
    "http://router.project-osrm.org/route/v1/driving/"
    "{start_lon},{start_lat};{end_lon},{end_lat}"
    "?overview=full&geometries=polyline"
)

ELEVATION_URL = "https://api.open-elevation.com/api/v1/lookup"


# -------------------------
# Vectorized Haversine (pairs)
# -------------------------
def haversine_vectorized(lat_arr, lon_arr):
    """
    Compute haversine distance between consecutive points.
    lat_arr, lon_arr: 1D numpy arrays of lat/lon in degrees.
    Returns distances array of length N (first element 0).
    """
    R = 6371000.0
    lat = np.deg2rad(lat_arr)
    lon = np.deg2rad(lon_arr)

    # delta between consecutive points
    dlat = lat[1:] - lat[:-1]
    dlon = lon[1:] - lon[:-1]

    sin_dlat2 = np.sin(dlat / 2.0) ** 2
    sin_dlon2 = np.sin(dlon / 2.0) ** 2
    a = sin_dlat2 + np.cos(lat[:-1]) * np.cos(lat[1:]) * sin_dlon2
    # guard numerical issues
    a = np.minimum(1.0, np.maximum(0.0, a))
    c = 2.0 * np.arcsin(np.sqrt(a))
    d = R * c

    # prepend 0 for the first point
    return np.concatenate(([0.0], d))


# -----------------------------------
# Fast smoothing using convolution
# -----------------------------------
def smooth_elev_np(elev_list: List[Optional[float]], window: int = 3) -> np.ndarray:
    """
    Moving average smoothing using numpy. Preserves NaNs by computing
    a weighted sum / count with nan-safe operations.
    """
    arr = np.array([np.nan if v is None else float(v) for v in elev_list], dtype=float)
    n = len(arr)
    k = 2 * window + 1
    # convolution kernel
    kernel = np.ones(k, dtype=float)

    # replace NaN with 0 for convolution, but track counts of valid entries
    arr_zero = np.nan_to_num(arr, nan=0.0)
    valid_mask = ~np.isnan(arr)
    counts = np.convolve(valid_mask.astype(float), kernel, mode="same")
    sums = np.convolve(arr_zero, kernel, mode="same")

    # avoid division by zero
    with np.errstate(invalid="ignore", divide="ignore"):
        smoothed = sums / counts
    # where counts == 0 -> keep NaN
    smoothed[counts == 0] = np.nan
    return smoothed


# -----------------------------------
# Vectorized chunked slope computation
# -----------------------------------
def compute_slopes_numpy(points: List[Dict[str, Any]],
                         smoothed_elev: np.ndarray,
                         min_segment_m: float = 20.0,
                         chunk_distance_m: float = 50.0):
    """
    Vectorized-ish slope computation.
    Returns: points_out (list of dicts with slope_pct), total_ascent, total_descent, max_slope, avg_slope
    """
    n = len(points)
    if n == 0:
        return [], 0.0, 0.0, 0.0, 0.0

    lats = np.array([p["lat"] for p in points], dtype=float)
    lons = np.array([p["lon"] for p in points], dtype=float)
    raw_elev = np.array([np.nan if p.get("elev_m") is None else float(p["elev_m"]) for p in points], dtype=float)

    # 1) distances between consecutive points (vectorized)
    segment_dist = haversine_vectorized(lats, lons)  # length n, first = 0
    # apply min_segment filter: tiny segments -> zero distance (ignored)
    segment_dist_masked = np.where(segment_dist >= min_segment_m, segment_dist, 0.0)

    # 2) cumulative distance
    cumdist = np.cumsum(segment_dist_masked)

    # prepare output points
    points_out = [dict(p) for p in points]
    for p in points_out:
        p["slope_pct"] = 0.0

    total_ascent = 0.0
    total_descent = 0.0

    # 3) create chunk boundaries using searchsorted (fewer iterations than per-point)
    # We will start chunk at idx=0, find end_idx where cumdist >= cumdist[start] + chunk_distance_m
    start_idx = 0
    # To avoid infinite loop if cumdist stationary, limit iterations
    max_iterations = max(1, int(np.ceil(cumdist[-1] / chunk_distance_m)) + 5)

    iterations = 0
    while start_idx < n - 1 and iterations < max_iterations:
        iterations += 1
        start_cum = cumdist[start_idx]
        target = start_cum + chunk_distance_m

        # find first index with cumdist >= target
        end_idx = np.searchsorted(cumdist, target, side="left")
        if end_idx <= start_idx:
            end_idx = start_idx + 1
        if end_idx >= n:
            end_idx = n - 1

        # find usable s,e with smoothed elevations present
        s = start_idx
        # move s forward if smoothed is nan
        while s < end_idx and np.isnan(smoothed_elev[s]):
            s += 1
        e = end_idx
        while e > s and np.isnan(smoothed_elev[e]):
            e -= 1

        if s >= e:
            # advance start to end to avoid small loops
            start_idx = end_idx
            continue

        horiz = cumdist[e] - cumdist[s]
        if horiz <= 0:
            start_idx = end_idx
            continue

        elev_start = smoothed_elev[s]
        elev_end = smoothed_elev[e]
        if np.isnan(elev_start) or np.isnan(elev_end):
            start_idx = end_idx
            continue

        slope_pct = (elev_end - elev_start) / horiz * 100.0

        # assign slope to points in this chunk
        # vectorized assignment using slice
        for k in range(s, e + 1):
            points_out[k]["slope_pct"] = float(slope_pct)

        # accumulate ascent/descent using raw elevations where available
        raw_s = raw_elev[s]
        raw_e = raw_elev[e]
        if not np.isnan(raw_s) and not np.isnan(raw_e):
            if raw_e > raw_s:
                total_ascent += float(raw_e - raw_s)
            else:
                total_descent += float(raw_s - raw_e)

        # advance
        start_idx = end_idx

    # handle any trailing points (if not covered) by setting slope to 0 (already default)

    # summary metrics
    slope_vals = np.array([abs(p["slope_pct"]) for p in points_out], dtype=float)
    max_slope = float(np.nanmax(slope_vals)) if slope_vals.size else 0.0
    avg_slope = float(np.nanmean(slope_vals)) if slope_vals.size else 0.0

    return points_out, total_ascent, total_descent, max_slope, avg_slope


# -----------------------------------
# MAIN API ENDPOINT (uses numpy)
# -----------------------------------
@app.get("/route-elevation")
async def route_elevation(poly: str):
    # --------------------------
    # 1. DECODE POLYLINE DIRECTLY
    # --------------------------
    try:
        coords = polyline.decode(poly)
    except Exception:
        raise HTTPException(400, "Invalid polyline")

    if not coords:
        raise HTTPException(400, "Polyline decode failed")

    # --------------------------
    # 2. GET ELEVATION POINTS
    # --------------------------
    locations = [{"latitude": lat, "longitude": lon} for lat, lon in coords]

    async with httpx.AsyncClient(timeout=30) as client:
        elev_r = await client.post(ELEVATION_URL, json={"locations": locations})

    if elev_r.status_code != 200:
        raise HTTPException(500, "Elevation API error")

    elevation_data = elev_r.json().get("results", [])
    if len(elevation_data) < len(coords):
        elevation_data.extend([{"elevation": None}] * (len(coords) - len(elevation_data)))

    # --------------------------
    # 3. BUILD BASE POINT LIST
    # --------------------------
    points = []
    for (lat, lon), ed in zip(coords, elevation_data):
        elev = ed.get("elevation")
        points.append({"lat": lat, "lon": lon, "elev_m": elev})

    # --------------------------
    # 4. SMOOTH ELEVATION (numpy)
    # --------------------------
    smoothed = smooth_elev_np([p["elev_m"] for p in points], window=3)

    # --------------------------
    # 5. COMPUTE FILTERED SLOPES (numpy)
    # --------------------------
    (
        points_final,
        total_ascent,
        total_descent,
        max_slope,
        avg_slope,
    ) = compute_slopes_numpy(points, smoothed, min_segment_m=20.0, chunk_distance_m=50.0)

    # --------------------------
    # 6. DIFFICULTY RATING
    # --------------------------
    uphill_slopes = [p["slope_pct"] for p in points_final if p["slope_pct"] > 0]
    max_uphill = max(uphill_slopes) if uphill_slopes else 0.0

    if total_ascent < 50 and max_uphill < 4:
        difficulty = "Easy"
    elif total_ascent < 150 and max_uphill < 7:
        difficulty = "Moderate"
    elif total_ascent < 300 and max_uphill < 10:
        difficulty = "Hard"
    else:
        difficulty = "Very Hard"

    # --------------------------
    # 7. RETURN
    # --------------------------
    return {
        "total_ascent_m": total_ascent,
        "total_descent_m": total_descent,
        "max_slope_pct": max_slope,
        "avg_slope_pct": avg_slope,
        "difficulty": difficulty,
        "points": points_final,
    }

