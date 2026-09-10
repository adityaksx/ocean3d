# SolvX — Three.js/WebGL

This is a replacement for the previous Plotly UI. Python performs geospatial preprocessing; Three.js/WebGL renders the application.

Install:
`pip install numpy xarray geopandas shapely netcdf4`

Build:
`python -m solvx_threejs.build --data-dir /mnt/data --output /mnt/data/solvx_bay_of_bengal.html`

The generated HTML is fullscreen-first: the 3D model owns the complete viewport and controls are a small overlay.

Modes:
1 = 3D overview
2 = top
3 = profile
4 = under-surface
F = browser fullscreen
R = reset

Mouse:
drag = orbit
right drag / shift drag = pan
wheel = zoom

Three.js is loaded from jsDelivr, so the generated page needs network access.
