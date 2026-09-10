from pathlib import Path
from typing import Optional
import numpy as np
import xarray as xr
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

DATA_DIR=Path(__file__).resolve().parent.parent/"data"/"model"
app=FastAPI(title="SolvX Ocean Data API",description="API for retrieving ocean data from NetCDF files",version="2.0.0")
app.add_middleware(CORSMiddleware,allow_origins=["*"],allow_credentials=False,allow_methods=["GET","OPTIONS"],allow_headers=["*"])

def get_nc_files(): return sorted(DATA_DIR.glob("*.nc"))
def find_file(filename:str):
    filename=Path(filename).name;p=DATA_DIR/filename
    if not p.exists() or p.suffix.lower()!='.nc': raise HTTPException(404,detail=f"NetCDF file not found: {filename}")
    return p
def open_dataset(filename:str):
    try:return xr.open_dataset(find_file(filename))
    except HTTPException:raise
    except Exception as e:raise HTTPException(500,detail=f"Could not open NetCDF file: {e}")
def sanitize(v):
    if isinstance(v,np.ndarray):return [sanitize(x) for x in v.tolist()]
    if isinstance(v,np.generic):return sanitize(v.item())
    if isinstance(v,dict):return {str(k):sanitize(x) for k,x in v.items()}
    if isinstance(v,(list,tuple)):return [sanitize(x) for x in v]
    if isinstance(v,float):return v if np.isfinite(v) else None
    if hasattr(v,'isoformat'):return v.isoformat()
    return v
def coord_slice(data,dim,lo,hi):
    if dim not in data.dims or lo is None or hi is None:return data
    c=data[dim].values;return data.sel({dim:slice(lo,hi) if c[0]<=c[-1] else slice(hi,lo)})
def select(data,lat_min=None,lat_max=None,lon_min=None,lon_max=None,depth_min=None,depth_max=None,time_start=None,time_end=None):
    data=coord_slice(data,'latitude',lat_min,lat_max);data=coord_slice(data,'longitude',lon_min,lon_max);data=coord_slice(data,'depth',depth_min,depth_max);return coord_slice(data,'time',time_start,time_end)
def variable_catalog(ds):
    return [{"name":n,"dimensions":list(v.dims),"shape":list(v.shape),"dtype":str(v.dtype),"long_name":v.attrs.get('long_name'),"standard_name":v.attrs.get('standard_name'),"units":v.attrs.get('units')} for n,v in ds.data_vars.items()]

@app.get('/')
def root():return {"name":"SolvX Ocean Data API","status":"running","docs":"/docs"}
@app.get('/datasets')
def datasets():
    out=[]
    for f in get_nc_files():
        try:
            with xr.open_dataset(f) as ds:out.append({"file":f.name,"variables":variable_catalog(ds),"dimensions":{k:int(v) for k,v in ds.sizes.items()}})
        except Exception as e:out.append({"file":f.name,"error":str(e)})
    return {"count":len(out),"datasets":out}
@app.get('/variables/{filename}')
def variables(filename:str):
    with open_dataset(filename) as ds:return {"file":filename,"variables":variable_catalog(ds)}
@app.get('/metadata/{filename}')
def metadata(filename:str):
    with open_dataset(filename) as ds:
        coords={}
        for name,c in ds.coords.items():
            vals=c.values;step=max(1,vals.size//5000)
            coords[name]={"size":int(vals.size),"min":sanitize(vals.min()) if vals.size else None,"max":sanitize(vals.max()) if vals.size else None,"values":sanitize(vals.tolist() if name=='time' or vals.size<=5000 else vals[::step].tolist()),"units":c.attrs.get('units')}
        return {"file":filename,"variables":variable_catalog(ds),"coordinates":coords}
@app.get('/data/point')
def get_point(file:str,variable:str,latitude:Optional[float]=None,longitude:Optional[float]=None,depth:Optional[float]=None,time:Optional[str]=None):
    with open_dataset(file) as ds:
        if variable not in ds.data_vars:raise HTTPException(404,detail={"error":f"Variable '{variable}' not found","available_variables":list(ds.data_vars)})
        data=ds[variable]
        for dim,value in (("latitude",latitude),("longitude",longitude),("depth",depth),("time",time)):
            if value is not None and dim in data.dims:data=data.sel({dim:value},method='nearest')
        if data.ndim==0:return {"variable":variable,"value":sanitize(data.values),"coordinates":{k:sanitize(v.values) for k,v in data.coords.items()}}
        if data.size>10000:raise HTTPException(413,detail={"error":"Too much data requested","remaining_dimensions":dict(data.sizes)})
        frame=data.to_dataframe(name=variable).reset_index().replace({np.nan:None})
        return {"variable":variable,"dimensions":list(data.dims),"shape":list(data.shape),"data":frame.to_dict(orient='records')}
@app.get('/data/region')
def get_region(file:str,variable:str,lat_min:Optional[float]=None,lat_max:Optional[float]=None,lon_min:Optional[float]=None,lon_max:Optional[float]=None,depth_min:Optional[float]=None,depth_max:Optional[float]=None,time_start:Optional[str]=None,time_end:Optional[str]=None):
    with open_dataset(file) as ds:
        if variable not in ds.data_vars:raise HTTPException(404,detail={"error":f"Variable '{variable}' not found","available_variables":list(ds.data_vars)})
        data=select(ds[variable],lat_min,lat_max,lon_min,lon_max,depth_min,depth_max,time_start,time_end)
        if data.size>50000:raise HTTPException(413,detail={"error":"Region is too large","number_of_values":int(data.size),"dimensions":dict(data.sizes)})
        frame=data.to_dataframe(name=variable).reset_index().replace({np.nan:None})
        return {"file":file,"variable":variable,"dimensions":list(data.dims),"shape":list(data.shape),"data":frame.to_dict(orient='records')}
@app.get('/data/region/array')
def get_region_array(file:str,variable:str,lat_min:Optional[float]=None,lat_max:Optional[float]=None,lon_min:Optional[float]=None,lon_max:Optional[float]=None,depth_min:Optional[float]=None,depth_max:Optional[float]=None,time_start:Optional[str]=None,time_end:Optional[str]=None,stride:int=1):
    with open_dataset(file) as ds:
        if variable not in ds.data_vars:raise HTTPException(404,detail={"error":f"Variable '{variable}' not found","available_variables":list(ds.data_vars)})
        data=select(ds[variable],lat_min,lat_max,lon_min,lon_max,depth_min,depth_max,time_start,time_end);stride=max(1,min(stride,20))
        for dim in ('latitude','longitude'):
            if dim in data.dims and stride>1:data=data.isel({dim:slice(None,None,stride)})
        if data.size>500000:raise HTTPException(413,detail={"error":"Region is too large","number_of_values":int(data.size),"dimensions":dict(data.sizes)})
        values=np.asarray(data.values,dtype=np.float32)
        return {"file":file,"variable":variable,"dimensions":list(data.dims),"shape":list(values.shape),"dtype":str(values.dtype),"coordinates":{d:sanitize(data[d].values) for d in data.dims if d in data.coords},"data":sanitize(values)}
if __name__=='__main__':
    import uvicorn;uvicorn.run('backend.main:app',host='127.0.0.1',port=8000,reload=False)
