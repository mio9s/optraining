import json, sys
from opticalglass.opticalmedium import ConstantIndex
from rayoptics.optical.opticalmodel import OpticalModel
from rayoptics.raytr.opticalspec import PupilSpec, FieldSpec, WvlSpec
from rayoptics.raytr import raytrace as rt
import numpy as np

def build(surfs, obj_dist, wvl_nm, indices):
    opm = OpticalModel()
    sm = opm['seq_model']; osp = opm['optical_spec']
    osp['pupil'] = PupilSpec(osp, key=['object', 'pupil'], value=10)
    osp['fov'] = FieldSpec(osp, key=['object', 'height'], value=1, flds=[0.0])
    osp['wvls'] = WvlSpec([(wvl_nm, 1.0)], ref_wl=0)
    opm.radius_mode = True
    sm.gaps[0].thi = obj_dist
    for r, t, mat in surfs:
        sm.add_surface([r, t])
    for i, n in enumerate(indices):
        sm.gaps[i].medium = ConstantIndex(n, f'n{i}')
    opm.update_model()
    return opm

spec = json.load(open(sys.argv[1]))
ours = {c['name']: c for c in json.load(open(sys.argv[3]))}
out = []
for case in spec:
    opm = build([(s['r'] if s['r'] is not None else 0.0, s['t'], s.get('mat')) for s in case['surfs']], case['obj'], case['wvl'] * 1000, ours[case['name']]['indices'])
    sm = opm['seq_model']
    wl = case['wvl'] * 1000
    res = []
    for p0, d0 in case['rays']:
        ray, opl, wvl = rt.trace(sm, np.array(p0, float), np.array(d0, float), wl)
        pts = [list(map(float, r[0])) for r in ray]
        res.append({'last': pts[-1], 'opl': float(opl), 'seg': [float(r[2]) for r in ray]})
    out.append({'name': case['name'], 'rays': res, 'indices': [float(g.medium.rindex(wl)) for g in sm.gaps]})
json.dump(out, open(sys.argv[2], 'w'), indent=1)
print('ok', len(out))
