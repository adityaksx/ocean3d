from __future__ import annotations
import tempfile,zipfile
from pathlib import Path
import geopandas as gpd,numpy as np,xarray as xr
from shapely.geometry import Polygon,MultiPolygon,box
from shapely.ops import triangulate
try: from .config import *
except ImportError: from config import *

def find_zip(d,exact,contains):
 p=Path(d)/exact
 if p.exists():return p
 m=[x for x in Path(d).glob('*.zip') if contains.lower() in x.name.lower()]
 if len(m)==1:return m[0]
 raise FileNotFoundError(f'Could not uniquely find {exact}; candidates={[x.name for x in m]}')
def extract(zp,root):
 out=root/zp.stem;out.mkdir(parents=True,exist_ok=True)
 with zipfile.ZipFile(zp) as z:z.extractall(out)
 return out
def first(root,pat):
 m=list(root.rglob(pat))
 if not m:raise FileNotFoundError(f'Missing {pat} in {root}')
 return m[0]
def crop(g):
 if g.crs is None:raise ValueError('Vector dataset has no CRS')
 g=g.to_crs('EPSG:4326');b=box(WEST-PAD,SOUTH-PAD,EAST+PAD,NORTH+PAD);o=g[g.geometry.notna()].copy();o['geometry']=o.geometry.intersection(b);return o[~o.geometry.is_empty]
def xy(lon,lat):
 klat=111.32;klon=111.32*np.cos(np.deg2rad((SOUTH+NORTH)/2));return (np.asarray(lon)-(WEST+EAST)/2)*klon,(np.asarray(lat)-(SOUTH+NORTH)/2)*klat
def ring(r):return [[float(x),float(y)] for lon,lat,*_ in r.coords for x,y in [xy(lon,lat)]]
def polygons(gdf):
 out=[];count=0
 for geom in gdf.geometry:
  if geom is None or geom.is_empty:continue
  ps=[geom] if isinstance(geom,Polygon) else list(geom.geoms) if isinstance(geom,MultiPolygon) else []
  for p in ps:
   top=ring(p.exterior);verts=[];inds=[]
   for tri in triangulate(p):
    if count>=MAX_LAND_TRIANGLES:break
    if not p.covers(tri.representative_point()):continue
    base=len(verts)
    for lon,lat in list(tri.exterior.coords)[:3]:
     x,y=xy(lon,lat);verts.append([float(x),float(y)])
    inds.append([base,base+1,base+2]);count+=1
   out.append({'top':top,'vertices':verts,'triangles':inds})
   if count>=MAX_LAND_TRIANGLES:break
  if count>=MAX_LAND_TRIANGLES:break
 return out
def lines(gdf):
 out=[]
 for geom in gdf.geometry:
  if geom is None or geom.is_empty:continue
  gt=geom.geom_type;gs=[geom] if gt=='LineString' else list(geom.geoms) if gt=='MultiLineString' else [geom.exterior] if gt=='Polygon' else [p.exterior for p in geom.geoms] if gt=='MultiPolygon' else []
  for g in gs:
   pts=[]
   for lon,lat,*_ in g.coords:x,y=xy(lon,lat);pts.append([float(x),float(y)])
   if len(pts)>1:out.append(pts)
 return out
def beads(parts):
 out=[]
 for line in parts:
  for a,b in zip(line[:-1],line[1:]):
   dx,dy=b[0]-a[0],b[1]-a[1];dist=float(np.hypot(dx,dy));n=max(1,int(np.ceil(dist/EEZ_BEAD_SPACING_KM)))
   for j in range(n):
    if len(out)>=MAX_EEZ_BEADS:return out
    t=j/n;out.append([a[0]+dx*t,a[1]+dy*t])
 return out
def bathy(nc):
 ds=xr.open_dataset(nc)
 try:
  da=ds['elevation'].sortby('lat').sortby('lon').sel(lat=slice(SOUTH,NORTH),lon=slice(WEST,EAST));lat=da.lat.values;lon=da.lon.values;arr=da.values.astype(np.float32)
 finally:ds.close()
 if arr.size>MAX_GRID_POINTS:
  f=int(np.ceil(np.sqrt(arr.size/MAX_GRID_POINTS)));arr=arr[::f,::f];lat=lat[::f];lon=lon[::f]
 dep=np.where(arr<0,-arr/1000,np.nan).astype(np.float32)
 # JSON has no NaN literal. Build Python lists explicitly so invalid cells become null.
 dep_json=[[None if not np.isfinite(v) else float(v) for v in row] for row in dep]
 xx,yy=xy(lon,lat);return xx.tolist(),yy.tolist(),dep_json,float(np.nanmax(dep))
def prepare(data_dir):
 d=Path(data_dir);z={'coast':find_zip(d,'ne_10m_coastline.zip','coastline'),'land':find_zip(d,'ne_10m_land.zip','ne_10m_land'),'islands':find_zip(d,'ne_10m_minor_islands.zip','minor_islands'),'eez':find_zip(d,'World_EEZ_v12_20231025_LR.zip','World_EEZ'),'gebco':find_zip(d,'GEBCO_10_Sep_2026_c6ae0e7b7408.zip','GEBCO')}
 with tempfile.TemporaryDirectory(prefix='solvx3_') as t:
  r=Path(t);q={k:extract(v,r) for k,v in z.items()};land=crop(gpd.read_file(first(q['land'],'*.shp')));islands=crop(gpd.read_file(first(q['islands'],'*.shp')));coast=crop(gpd.read_file(first(q['coast'],'*.shp')));eez=crop(gpd.read_file(first(q['eez'],'*.shp')))
  if 'SOVEREIGN1' in eez.columns:
   x=eez[eez.SOVEREIGN1.isin({'India','Bangladesh','Myanmar'})]
   if not x.empty:eez=x
  x,y,raw,md=bathy(first(q['gebco'],'*.nc'));ep=lines(eez)
  return {'bounds':[WEST,EAST,SOUTH,NORTH],'terrain':{'x':x,'y':y,'rawDepthKm':raw,'maxDepthKm':md},'land':polygons(land),'islands':polygons(islands),'coast':lines(coast),'landBoundary':lines(land),'islandCoast':lines(islands),'eez':ep,'eezBeads':beads(ep),'landThickness':LAND_THICKNESS_KM,'baseExtra':BASE_EXTRA_KM}
