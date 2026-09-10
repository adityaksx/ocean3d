from pathlib import Path
import argparse
from .data import prepare
from .html_template import render

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--data-dir",type=Path,default=Path("/mnt/data"))
    p.add_argument("--output",type=Path,default=Path("/mnt/data/solvx_bay_of_bengal.html"))
    a=p.parse_args()
    d=prepare(a.data_dir)
    a.output.write_text(render(d),encoding="utf-8")
    print(f"Created {a.output}")
    print(f"Terrain: {len(d['terrain']['x'])} x {len(d['terrain']['y'])}")
    print(f"EEZ beads: {len(d['eezBeads'])}")

if __name__=="__main__":main()
