from pathlib import Path
from typing import Optional
import numpy as np
import pandas as pd
import xarray as xr
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "model"
app = FastAPI(title="SolvX Ocean Data API", description="API for interactive 3D ocean visualization", version="2.2.3")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False, allow_methods=["GET", "OPTIONS"], allow_headers=["*"])

def get_nc_files(): return sorted(DATA_DIR.glob("*.nc"))

def find_file(filename: str):
    path = DATA_DIR / Path(filename).name
    if not path.exists() or path.suffix.lower() != ".nc": raise HTTPException(404, detail=f"NetCDF file not found: {Path(filename).name}")
    return path

def open_dataset(filename: str):
    try: return xr.open_dataset(find_file(filename))
    except HTTPException: raise
    except Exception as e: raise HTTPException(500, detail=f"Could not open NetCDF file: {e}")

def sanitize(v):
    if isinstance(v, np.ndarray): return [sanitize(x) for x in v.tolist()]
    if isinstance(v, np.generic): return sanitize(v.item())
    if isinstance(v, dict): return {str(k): sanitize(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)): return [sanitize(x) for x in v]
    if isinstance(v, float): return v if np.isfinite(v) else None
    return v

def variable_catalog(ds):
    return [{"name": n, "dimensions": list(v.dims), "shape": list(v.shape), "dtype": str(v.dtype), "long_name": v.attrs.get("long_name"), "standard_name": v.attrs.get("standard_name"), "units": v.attrs.get("units")} for n, v in ds.data_vars.items()]

def normalize_time_coordinate(data):
    """Make time coordinates and API time strings comparable.

    Some NetCDF files expose time as strings while FastAPI receives ISO-8601
    timestamps. Pandas/xarray then sees a string index and a Timestamp query,
    which breaks nearest selection. Convert the dataset coordinate to a
    timezone-naive UTC datetime64 index once before time selection.
    """
    if "time" not in data.dims or "time" not in data.coords:
        return data
    try:
        values = pd.to_datetime(data["time"].values, utc=True)
        if isinstance(values, pd.DatetimeIndex):
            values = values.tz_localize(None)
        else:
            values = pd.DatetimeIndex(values).tz_localize(None)
        return data.assign_coords(time=("time", values.to_numpy(dtype="datetime64[ns]")))
    except Exception as e:
        raise HTTPException(422, detail=f"Could not normalize NetCDF time coordinate: {e}")

def normalize_time_value(value):
    if value is None: return None
    try:
        parsed = pd.to_datetime(value, utc=True)
        if isinstance(parsed, pd.DatetimeIndex):
            return parsed.tz_localize(None)
        if getattr(parsed, "tzinfo", None) is not None:
            parsed = parsed.tz_convert(None)
        return parsed
    except Exception as e:
        raise HTTPException(422, detail=f"Invalid time value '{value}': {e}")

def select_time(data, value, method="nearest"):
    if value is None or "time" not in data.dims:
        return data
    data = normalize_time_coordinate(data)
    return data.sel(time=normalize_time_value(value), method=method)

def coord_slice(data, dim, lo, hi):
    if dim not in data.dims or lo is None or hi is None: return data
    if dim == "time":
        data = normalize_time_coordinate(data)
        lo, hi = normalize_time_value(lo), normalize_time_value(hi)
    c = data[dim].values
    if not c.size: return data
    return data.sel({dim: slice(lo, hi) if c[0] <= c[-1] else slice(hi, lo)})

def select(data, lat_min=None, lat_max=None, lon_min=None, lon_max=None, depth_min=None, depth_max=None, time_start=None, time_end=None):
    data = coord_slice(data, "latitude", lat_min, lat_max)
    data = coord_slice(data, "longitude", lon_min, lon_max)
    data = coord_slice(data, "depth", depth_min, depth_max)
    return coord_slice(data, "time", time_start, time_end)

def aliases(file_name, var_name):
    text, var = f"{file_name} {var_name}".lower(), var_name.lower()
    if "temperature" in text and "anomaly" not in text and "anamoly" not in text: return "temperature"
    if "anamoly" in text or "anomaly" in text: return "temperature_anomaly"
    if "salinity" in text: return "salinity"
    if "current" in text or var in {"uo", "vo", "u", "v", "uoce", "voce"}: return "currents"
    if "sea level" in text or var in {"zos", "ssh", "sla"}: return "sea_level"
    if "chlorophyll" in text or var in {"chl", "chlor_a", "chlorophyll"}: return "chlorophyll"
    return None

def find_logical(logical):
    out = []
    for f in get_nc_files():
        try:
            with xr.open_dataset(f) as ds:
                for n, v in ds.data_vars.items():
                    if aliases(f.name, n) == logical: out.append((f, n, dict(v.attrs), list(v.dims), list(v.shape)))
        except Exception: pass
    return out

def find_current_components():
    matches = find_logical("currents")
    if not matches: return None, None, None
    f = matches[0][0]
    names = [m[1] for m in matches if m[0] == f]
    def attrs(name): return next((m[2] for m in matches if m[0] == f and m[1] == name), {})
    def pick(direction):
        for n in names:
            s, std = n.lower(), str(attrs(n).get("standard_name", "")).lower()
            if direction == "u" and (s in {"uo", "u"} or "eastward" in s or "eastward" in std): return n
            if direction == "v" and (s in {"vo", "v"} or "northward" in s or "northward" in std): return n
        return None
    return f, pick("u"), pick("v")

@app.get("/")
def root(): return {"name": "SolvX Ocean Data API", "status": "running", "docs": "/docs"}

@app.get("/datasets")
def datasets():
    out = []
    for f in get_nc_files():
        try:
            with xr.open_dataset(f) as ds: out.append({"file": f.name, "variables": variable_catalog(ds), "dimensions": {k: int(v) for k, v in ds.sizes.items()}})
        except Exception as e: out.append({"file": f.name, "error": str(e)})
    return {"count": len(out), "datasets": out}

@app.get("/variables/{filename}")
def variables(filename: str):
    with open_dataset(filename) as ds: return {"file": filename, "variables": variable_catalog(ds)}

@app.get("/metadata/{filename}")
def metadata(filename: str):
    with open_dataset(filename) as ds:
        coords = {}
        for name, c in ds.coords.items():
            vals = c.values; step = max(1, vals.size // 5000)
            coords[name] = {"size": int(vals.size), "min": sanitize(vals.min()) if vals.size else None, "max": sanitize(vals.max()) if vals.size else None, "values": sanitize(vals.tolist() if name == "time" or vals.size <= 5000 else vals[::step].tolist()), "units": c.attrs.get("units")}
        return {"file": filename, "variables": variable_catalog(ds), "coordinates": coords}

@app.get("/ocean/catalog")
def ocean_catalog():
    labels = [("temperature", "Temperature"), ("temperature_anomaly", "Sea surface temperature anomaly"), ("salinity", "Salinity"), ("currents", "Currents"), ("sea_level", "Sea level"), ("chlorophyll", "Chlorophyll")]
    out = []
    for logical, label in labels:
        matches = find_logical(logical)
        if not matches:
            out.append({"id": logical, "label": label, "available": False, "reason": "No matching NetCDF variable found"}); continue
        f, n, attrs, dims, shape = matches[0]
        out.append({"id": logical, "label": label, "available": True, "file": f.name, "variable": n, "units": attrs.get("units"), "long_name": attrs.get("long_name"), "standard_name": attrs.get("standard_name"), "dimensions": dims, "shape": shape, "matches": [{"file": x[0].name, "variable": x[1], "units": x[2].get("units"), "dimensions": x[3], "shape": x[4]} for x in matches]})
    return {"variables": out}

@app.get("/ocean/time")
def ocean_time():
    for f, n, *_ in find_logical("temperature"):
        with xr.open_dataset(f) as ds:
            if "time" in ds[n].dims and "time" in ds.coords: return {"file": f.name, "variable": n, "count": int(ds.time.size), "values": sanitize(ds.time.values.tolist())}
    for f in get_nc_files():
        try:
            with xr.open_dataset(f) as ds:
                if "time" in ds.coords: return {"file": f.name, "variable": None, "count": int(ds.time.size), "values": sanitize(ds.time.values.tolist())}
        except Exception: pass
    return {"file": None, "variable": None, "count": 0, "values": []}

@app.get("/ocean/current-grid")
def ocean_current_grid(time: Optional[str] = None, depth: Optional[float] = None, stride: int = 3):
    f, u_name, v_name = find_current_components()
    if not f or not u_name or not v_name: raise HTTPException(404, detail="Both eastward and northward current variables are required")
    stride = max(1, min(stride, 20))
    with xr.open_dataset(f) as ds:
        u, v = ds[u_name], ds[v_name]
        if time is not None:
            u = select_time(u, time)
            v = select_time(v, time)
        if depth is not None:
            if "depth" in u.dims: u = u.sel(depth=depth, method="nearest")
            if "depth" in v.dims: v = v.sel(depth=depth, method="nearest")
        ydim = "latitude" if "latitude" in u.dims else "lat" if "lat" in u.dims else None
        xdim = "longitude" if "longitude" in u.dims else "lon" if "lon" in u.dims else None
        if not ydim or not xdim: raise HTTPException(422, detail="Current dataset has no latitude/longitude dimensions")
        u = u.isel({ydim: slice(None, None, stride), xdim: slice(None, None, stride)}).squeeze()
        v = v.isel({ydim: slice(None, None, stride), xdim: slice(None, None, stride)}).squeeze()
        lat, lon = u.coords.get(ydim), u.coords.get(xdim)
        if lat is None or lon is None: raise HTTPException(422, detail="Current dataset has no latitude/longitude coordinates")
        return {"file": f.name, "u_variable": u_name, "v_variable": v_name, "latitude": sanitize(lat.values), "longitude": sanitize(lon.values), "u": sanitize(np.asarray(u.values, dtype=np.float32)), "v": sanitize(np.asarray(v.values, dtype=np.float32)), "units": u.attrs.get("units") or v.attrs.get("units")}

@app.get("/ocean/point")
def ocean_point(latitude: float, longitude: float, time: Optional[str] = None):
    result = []
    for logical, label in [("temperature", "Temperature"), ("temperature_anomaly", "SST anomaly"), ("salinity", "Salinity"), ("currents", "Currents"), ("sea_level", "Sea level"), ("chlorophyll", "Chlorophyll")]:
        matches = find_logical(logical)
        if not matches:
            result.append({"id": logical, "label": label, "available": False, "value": None}); continue
        f, n, attrs, dims, _ = matches[0]
        try:
            with xr.open_dataset(f) as ds:
                if logical == "currents":
                    values = {}
                    for mf, cn, *_ in matches:
                        if mf != f or cn not in ds.data_vars: continue
                        q = ds[cn]
                        for dim, val in (("latitude", latitude), ("longitude", longitude), ("lat", latitude), ("lon", longitude)):
                            if val is not None and dim in q.dims: q = q.sel({dim: val}, method="nearest")
                        if time is not None: q = select_time(q, time)
                        if q.ndim == 0: values[cn] = sanitize(q.values)
                    result.append({"id": logical, "label": label, "available": True, "units": attrs.get("units"), "value": values, "depth_dependent": "depth" in dims}); continue
                q = ds[n]
                for dim, val in (("latitude", latitude), ("longitude", longitude), ("lat", latitude), ("lon", longitude)):
                    if val is not None and dim in q.dims: q = q.sel({dim: val}, method="nearest")
                if time is not None: q = select_time(q, time)
                if q.ndim: q = q.isel({d: 0 for d in q.dims})
                result.append({"id": logical, "label": label, "available": True, "units": attrs.get("units"), "value": sanitize(q.values), "depth_dependent": "depth" in dims})
        except Exception as e: result.append({"id": logical, "label": label, "available": False, "value": None, "error": str(e)})
    return {"latitude": latitude, "longitude": longitude, "time": time, "values": result}

@app.get("/data/point")
def get_point(file: str, variable: str, latitude: Optional[float] = None, longitude: Optional[float] = None, depth: Optional[float] = None, time: Optional[str] = None):
    with open_dataset(file) as ds:
        if variable not in ds.data_vars: raise HTTPException(404, detail={"error": f"Variable '{variable}' not found", "available_variables": list(ds.data_vars)})
        data = ds[variable]
        for dim, value in (("latitude", latitude), ("longitude", longitude), ("depth", depth)):
            if value is not None and dim in data.dims: data = data.sel({dim: value}, method="nearest")
        if time is not None: data = select_time(data, time)
        if data.ndim == 0: return {"variable": variable, "value": sanitize(data.values), "coordinates": {k: sanitize(v.values) for k, v in data.coords.items()}}
        if data.size > 10000: raise HTTPException(413, detail={"error": "Too much data requested", "remaining_dimensions": dict(data.sizes)})
        frame = data.to_dataframe(name=variable).reset_index().replace({np.nan: None})
        return {"variable": variable, "dimensions": list(data.dims), "shape": list(data.shape), "data": frame.to_dict(orient="records")}

@app.get("/data/region")
def get_region(file: str, variable: str, lat_min: Optional[float] = None, lat_max: Optional[float] = None, lon_min: Optional[float] = None, lon_max: Optional[float] = None, depth_min: Optional[float] = None, depth_max: Optional[float] = None, time_start: Optional[str] = None, time_end: Optional[str] = None):
    with open_dataset(file) as ds:
        if variable not in ds.data_vars: raise HTTPException(404, detail={"error": f"Variable '{variable}' not found", "available_variables": list(ds.data_vars)})
        data = select(ds[variable], lat_min, lat_max, lon_min, lon_max, depth_min, depth_max, time_start, time_end)
        if data.size > 50000: raise HTTPException(413, detail={"error": "Region is too large", "number_of_values": int(data.size), "dimensions": dict(data.sizes)})
        frame = data.to_dataframe(name=variable).reset_index().replace({np.nan: None})
        return {"file": file, "variable": variable, "dimensions": list(data.dims), "shape": list(data.shape), "data": frame.to_dict(orient="records")}

@app.get("/data/region/array")
def get_region_array(file: str, variable: str, lat_min: Optional[float] = None, lat_max: Optional[float] = None, lon_min: Optional[float] = None, lon_max: Optional[float] = None, depth_min: Optional[float] = None, depth_max: Optional[float] = None, time_start: Optional[str] = None, time_end: Optional[str] = None, stride: int = 1):
    with open_dataset(file) as ds:
        if variable not in ds.data_vars: raise HTTPException(404, detail={"error": f"Variable '{variable}' not found", "available_variables": list(ds.data_vars)})
        data = select(ds[variable], lat_min, lat_max, lon_min, lon_max, depth_min, depth_max, time_start, time_end)
        stride = max(1, min(stride, 20))
        for dim in ("latitude", "longitude"):
            if dim in data.dims and stride > 1: data = data.isel({dim: slice(None, None, stride)})
        if data.size > 500000: raise HTTPException(413, detail={"error": "Region is too large", "number_of_values": int(data.size), "dimensions": dict(data.sizes)})
        values = np.asarray(data.values, dtype=np.float32)
        return {"file": file, "variable": variable, "dimensions": list(data.dims), "shape": list(values.shape), "dtype": str(values.dtype), "coordinates": {d: sanitize(data[d].values) for d in data.dims if d in data.coords}, "data": sanitize(values)}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.main:app", host="127.0.0.1", port=8000, reload=False)