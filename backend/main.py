from pathlib import Path
from typing import Optional

import numpy as np
import xarray as xr
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "model"

app = FastAPI(
    title="SolvX Ocean Data API",
    description="API for retrieving ocean data from NetCDF files",
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["*"],
)


def get_nc_files():
    return sorted(DATA_DIR.glob("*.nc"))


def find_file(filename: str):
    filename = Path(filename).name
    file_path = DATA_DIR / filename
    if not file_path.exists() or file_path.suffix.lower() != ".nc":
        raise HTTPException(status_code=404, detail=f"NetCDF file not found: {filename}")
    return file_path


def open_dataset(filename: str):
    try:
        return xr.open_dataset(find_file(filename))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not open NetCDF file: {exc}")


def sanitize(value):
    if isinstance(value, np.ndarray):
        return [sanitize(v) for v in value.tolist()]
    if isinstance(value, np.generic):
        return sanitize(value.item())
    if isinstance(value, dict):
        return {str(k): sanitize(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [sanitize(v) for v in value]
    if isinstance(value, float) and not np.isfinite(value):
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value


def coord_slice(data, dim, lo, hi):
    if dim not in data.dims or lo is None or hi is None:
        return data
    c = data[dim].values
    return data.sel({dim: slice(lo, hi) if c[0] <= c[-1] else slice(hi, lo)})


def select(data, lat_min=None, lat_max=None, lon_min=None, lon_max=None,
           depth_min=None, depth_max=None, time_start=None, time_end=None):
    data = coord_slice(data, "latitude", lat_min, lat_max)
    data = coord_slice(data, "longitude", lon_min, lon_max)
    data = coord_slice(data, "depth", depth_min, depth_max)
    data = coord_slice(data, "time", time_start, time_end)
    return data


def variable_catalog(ds):
    result = []
    for name, da in ds.data_vars.items():
        result.append({
            "name": name,
            "dimensions": list(da.dims),
            "shape": list(da.shape),
            "units": da.attrs.get("units"),
            "long_name": da.attrs.get("long_name"),
            "standard_name": da.attrs.get("standard_name"),
        })
    return result


@app.get("/")
def root():
    return {"name": "SolvX Ocean Data API", "status": "running", "docs": "/docs"}


@app.get("/datasets")
def datasets():
    out = []
    for file in get_nc_files():
        try:
            with xr.open_dataset(file) as ds:
                out.append({"file": file.name, "variables": variable_catalog(ds),
                            "dimensions": {k: int(v) for k, v in ds.sizes.items()}})
        except Exception as exc:
            out.append({"file": file.name, "error": str(exc)})
    return {"count": len(out), "datasets": out}


@app.get("/variables/{filename}")
def variables(filename: str):
    with open_dataset(filename) as ds:
        return {"file": filename, "variables": variable_catalog(ds)}


@app.get("/metadata/{filename}")
def metadata(filename: str):
    with open_dataset(filename) as ds:
        coords = {}
        for name, coord in ds.coords.items():
            vals = coord.values
            coords[name] = {
                "size": int(vals.size),
                "min": sanitize(vals.min()) if vals.size else None,
                "max": sanitize(vals.max()) if vals.size else None,
                "values": sanitize(vals.tolist()) if vals.size <= 250 else sanitize(vals[::max(1, vals.size // 250)].tolist()),
                "units": coord.attrs.get("units"),
            }
        return {"file": filename, "variables": variable_catalog(ds), "coordinates": coords}


@app.get("/data/point")
def get_point(file: str, variable: str, latitude: Optional[float] = None,
              longitude: Optional[float] = None, depth: Optional[float] = None,
              time: Optional[str] = None):
    with open_dataset(file) as ds:
        if variable not in ds.data_vars:
            raise HTTPException(status_code=404, detail={"error": f"Variable '{variable}' not found",
                                                         "available_variables": list(ds.data_vars)})
        data = ds[variable]
        for dim, value in (("latitude", latitude), ("longitude", longitude),
                           ("depth", depth), ("time", time)):
            if value is not None and dim in data.dims:
                data = data.sel({dim: value}, method="nearest")
        if data.ndim == 0:
            return {"variable": variable, "value": sanitize(data.values),
                    "coordinates": {k: sanitize(v.values) for k, v in data.coords.items()}}
        if data.size > 10000:
            raise HTTPException(status_code=413, detail={"error": "Too much data requested",
                                                         "remaining_dimensions": dict(data.sizes)})
        frame = data.to_dataframe(name=variable).reset_index().replace({np.nan: None})
        return {"variable": variable, "dimensions": list(data.dims), "shape": list(data.shape),
                "data": frame.to_dict(orient="records")}


@app.get("/data/region")
def get_region(file: str, variable: str, lat_min: Optional[float] = None,
               lat_max: Optional[float] = None, lon_min: Optional[float] = None,
               lon_max: Optional[float] = None, depth_min: Optional[float] = None,
               depth_max: Optional[float] = None, time_start: Optional[str] = None,
               time_end: Optional[str] = None):
    with open_dataset(file) as ds:
        if variable not in ds.data_vars:
            raise HTTPException(status_code=404, detail={"error": f"Variable '{variable}' not found",
                                                         "available_variables": list(ds.data_vars)})
        data = select(ds[variable], lat_min, lat_max, lon_min, lon_max,
                      depth_min, depth_max, time_start, time_end)
        if data.size > 50000:
            raise HTTPException(status_code=413, detail={"error": "Region is too large",
                                                         "number_of_values": int(data.size),
                                                         "dimensions": dict(data.sizes)})
        frame = data.to_dataframe(name=variable).reset_index().replace({np.nan: None})
        return {"file": file, "variable": variable, "dimensions": list(data.dims),
                "shape": list(data.shape), "data": frame.to_dict(orient="records")}


@app.get("/data/region/array")
def get_region_array(file: str, variable: str, lat_min: Optional[float] = None,
                     lat_max: Optional[float] = None, lon_min: Optional[float] = None,
                     lon_max: Optional[float] = None, depth_min: Optional[float] = None,
                     depth_max: Optional[float] = None, time_start: Optional[str] = None,
                     time_end: Optional[str] = None, stride: int = 1):
    stride = max(1, min(stride, 20))
    with open_dataset(file) as ds:
        if variable not in ds.data_vars:
            raise HTTPException(status_code=404, detail={"error": f"Variable '{variable}' not found",
                                                         "available_variables": list(ds.data_vars)})
        data = select(ds[variable], lat_min, lat_max, lon_min, lon_max,
                      depth_min, depth_max, time_start, time_end)
        for dim in ("latitude", "longitude"):
            if dim in data.dims and stride > 1:
                data = data.isel({dim: slice(None, None, stride)})
        if data.size > 500000:
            raise HTTPException(status_code=413, detail={"error": "Region is too large",
                                                         "number_of_values": int(data.size),
                                                         "dimensions": dict(data.sizes)})
        values = np.asarray(data.values, dtype=np.float32)
        coords = {dim: sanitize(data[dim].values) for dim in data.dims if dim in data.coords}
        return {"file": file, "variable": variable, "dimensions": list(data.dims),
                "shape": list(values.shape), "dtype": str(values.dtype),
                "coordinates": coords, "data": sanitize(values)}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.main:app", host="127.0.0.1", port=8000, reload=False)
