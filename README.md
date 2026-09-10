# SolvX — Interactive 3D Ocean

The original project used Python geospatial preprocessing plus a fullscreen Three.js/WebGL renderer. The integration branch adds the SolvX NetCDF API and turns the viewer into a live interactive ocean-data explorer.

## Run everything

From the repository root:

```bash
pip install -r requirements.txt
python run.py
```

The launcher prepares `frontend/geometry.json`, starts FastAPI on `http://127.0.0.1:8000`, starts the frontend on `http://127.0.0.1:5500`, and opens the browser.

## Interactive viewer

- Left panel: variables discovered directly from the NetCDF dataset.
- Color field: selected variable is rendered over the 3D ocean grid.
- Depth: depth-dependent variables are rendered as stacked horizontal layers; the depth control highlights a selected layer.
- Time: the bottom timeline is driven by the dataset `time` coordinate and can play through available timestamps.
- Hover: move over a colored ocean cell to see the selected variable and depth/range information.
- Views: 3D, top, profile and under-surface.
- Vertical exaggeration: preserves the existing bathymetry visualization while making ocean depth visible at screen scale.
- GEBCO, coastlines, land and EEZ geometry remain separate from the live ocean field so changing variable/time does not rebuild geographic geometry.

## API

- `GET /datasets`
- `GET /variables/{filename}`
- `GET /metadata/{filename}`
- `GET /data/point`
- `GET /data/region`
- `GET /data/region/array`

The API reads the existing `data/model/*.nc` files. The region-array endpoint supports a `stride` parameter to keep browser payloads manageable.
