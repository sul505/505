#!/usr/bin/env python3
"""Tidal harmonic analysis for Omani tide gauges -> maps/data/oman-tides.json

usage: tides.py <uhslc_dir> <ioc_dir>

uhslc_dir holds hourly CSVs (time,sea_level mm) from the UHSLC ERDDAP "global_hourly_fast" dataset:
  muscat.csv (#110), masirah.csv (#113), salalah.csv (#114)
ioc_dir holds 1-minute IOC Sea Level Monitoring Facility dumps: <code>.json = [[time, sensor, metres], ...]

Method: least-squares fit of tidal constituents with nodal corrections (f, u), Rayleigh-criterion
selection, and inference of unresolved constituents (P1, K2, nu2, ...) from the nearest long record.
The prediction code in maps/js/tides.js uses the same astronomical arguments, so phases are
self-consistent whatever convention offsets are used.
"""
import json, math, sys, datetime as dt
from pathlib import Path
import numpy as np

# name: (Doodson numbers for (tau, s, h, p, N', p1), phase offset in degrees, nodal group)
TABLE = {
    'Sa':   ((0, 0, 1, 0, 0, -1), 0, None),
    'Ssa':  ((0, 0, 2, 0, 0, 0), 0, None),
    'Mm':   ((0, 1, 0, -1, 0, 0), 0, 'Mm'),
    'MSf':  ((0, 2, -2, 0, 0, 0), 0, 'MSf'),
    'Mf':   ((0, 2, 0, 0, 0, 0), 0, 'Mf'),
    '2Q1':  ((1, -3, 0, 2, 0, 0), -90, 'O1'),
    'Q1':   ((1, -2, 0, 1, 0, 0), -90, 'O1'),
    'rho1': ((1, -2, 2, -1, 0, 0), -90, 'O1'),
    'O1':   ((1, -1, 0, 0, 0, 0), -90, 'O1'),
    'P1':   ((1, 1, -2, 0, 0, 0), -90, None),
    'S1':   ((1, 1, -1, 0, 0, 0), 0, None),
    'K1':   ((1, 1, 0, 0, 0, 0), 90, 'K1'),
    'J1':   ((1, 2, 0, -1, 0, 0), 90, 'J1'),
    'OO1':  ((1, 3, 0, 0, 0, 0), 90, 'OO1'),
    '2N2':  ((2, -2, 0, 2, 0, 0), 0, 'M2'),
    'mu2':  ((2, -2, 2, 0, 0, 0), 0, 'M2'),
    'N2':   ((2, -1, 0, 1, 0, 0), 0, 'M2'),
    'nu2':  ((2, -1, 2, -1, 0, 0), 0, 'M2'),
    'M2':   ((2, 0, 0, 0, 0, 0), 0, 'M2'),
    'lam2': ((2, 1, -2, 1, 0, 0), 180, 'M2'),
    'L2':   ((2, 1, 0, -1, 0, 0), 180, 'M2'),
    'T2':   ((2, 2, -3, 0, 0, 1), 0, None),
    'S2':   ((2, 2, -2, 0, 0, 0), 0, None),
    'R2':   ((2, 2, -1, 0, 0, -1), 180, None),
    'K2':   ((2, 2, 0, 0, 0, 0), 0, 'K2'),
    'MO3':  ((3, -1, 0, 0, 0, 0), -90, 'MO3'),
    'M3':   ((3, 0, 0, 0, 0, 0), 180, 'M3'),
    'MK3':  ((3, 1, 0, 0, 0, 0), 90, 'MK3'),
    'MN4':  ((4, -1, 0, 1, 0, 0), 0, 'M4'),
    'M4':   ((4, 0, 0, 0, 0, 0), 0, 'M4'),
    'MS4':  ((4, 2, -2, 0, 0, 0), 0, 'M2'),
    'S4':   ((4, 4, -4, 0, 0, 0), 0, None),
    'M6':   ((6, 0, 0, 0, 0, 0), 0, 'M6'),
    '2MS6': ((6, 2, -2, 0, 0, 0), 0, 'M4'),
    'M8':   ((8, 0, 0, 0, 0, 0), 0, 'M8'),
}
# Fitting priority (largest/most important first) for the Rayleigh selection.
PRIORITY = ['M2', 'S2', 'K1', 'O1', 'N2', 'P1', 'K2', 'Q1', 'nu2', 'mu2', '2N2', 'L2', 'M4', 'MS4', 'MN4',
            'T2', 'lam2', 'M6', '2MS6', 'M3', 'MK3', 'MO3', 'S4', 'M8', 'J1', 'OO1', '2Q1', 'rho1', 'R2',
            'Mf', 'MSf', 'Mm', 'Sa', 'Ssa', 'S1']
# Unresolved constituent -> constituent it is inferred from (ratio and phase lag from a reference record).
INFER = {'P1': 'K1', 'K2': 'S2', 'T2': 'S2', 'nu2': 'N2', '2N2': 'N2', 'mu2': 'N2', 'L2': 'M2', 'lam2': 'M2'}
RATES = np.array([14.4920521, 0.5490165, 0.0410686, 0.0046418, 0.0022064, 0.0000020])  # deg/hour


def speed(name):
    return float(np.dot(TABLE[name][0], RATES))


def julian(t):
    """numpy datetime64 array -> Julian date (UTC)."""
    return t.astype('datetime64[s]').astype(np.float64) / 86400.0 + 2440587.5


def angles(jd):
    T = (jd - 2451545.0) / 36525.0
    s = 218.3164591 + 481267.88134236 * T
    h = 280.4664567 + 36000.76982779 * T
    p = 83.3532430 + 4069.0137111 * T
    N = 125.0445550 - 1934.1361849 * T
    pp = 282.9373481 + 1.7195366 * T
    hours = ((jd + 0.5) % 1.0) * 24.0
    tau = 15.0 * hours + h - s
    return tau, s, h, p, N, pp


def nodal(N):
    n = np.radians(N)
    c1, c2, c3 = np.cos(n), np.cos(2 * n), np.cos(3 * n)
    s1, s2, s3 = np.sin(n), np.sin(2 * n), np.sin(3 * n)
    fM2, uM2 = 1.0004 - 0.0373 * c1 + 0.0002 * c2, -2.14 * s1
    fK1, uK1 = 1.0060 + 0.1150 * c1 - 0.0088 * c2 + 0.0006 * c3, -8.86 * s1 + 0.68 * s2 - 0.07 * s3
    fO1, uO1 = 1.0089 + 0.1871 * c1 - 0.0147 * c2 + 0.0014 * c3, 10.80 * s1 - 1.34 * s2 + 0.19 * s3
    fK2, uK2 = 1.0241 + 0.2863 * c1 + 0.0083 * c2 - 0.0015 * c3, -17.74 * s1 + 0.68 * s2 - 0.04 * s3
    fMf, uMf = 1.0429 + 0.4135 * c1 - 0.0040 * c2, -23.74 * s1 + 2.68 * s2 - 0.38 * s3
    fMm, uMm = 1.0000 - 0.1300 * c1 + 0.0013 * c2, 0.0 * s1
    fJ1, uJ1 = 1.0129 + 0.1676 * c1 - 0.0170 * c2 + 0.0016 * c3, -12.94 * s1 + 1.34 * s2 - 0.19 * s3
    fOO1, uOO1 = 1.1027 + 0.6504 * c1 + 0.0317 * c2 - 0.0014 * c3, -36.68 * s1 + 4.02 * s2 - 0.57 * s3
    one, zero = np.ones_like(n), np.zeros_like(n)
    return {
        None: (one, zero), 'M2': (fM2, uM2), 'K1': (fK1, uK1), 'O1': (fO1, uO1), 'K2': (fK2, uK2),
        'Mf': (fMf, uMf), 'Mm': (fMm, uMm), 'J1': (fJ1, uJ1), 'OO1': (fOO1, uOO1), 'MSf': (fM2, -uM2),
        'M3': (fM2 ** 1.5, 1.5 * uM2), 'M4': (fM2 ** 2, 2 * uM2), 'M6': (fM2 ** 3, 3 * uM2), 'M8': (fM2 ** 4, 4 * uM2),
        'MK3': (fM2 * fK1, uM2 + uK1), 'MO3': (fM2 * fO1, uM2 + uO1),
    }


def phases(t, names):
    """Return dict name -> (f, phi) where phi = V + u in radians."""
    jd = julian(t)
    tau, s, h, p, N, pp = angles(jd)
    args = np.vstack([tau, s, h, p, -N, pp])
    nod = nodal(N)
    out = {}
    for nm in names:
        d, off, grp = TABLE[nm]
        V = np.dot(d, args) + off
        f, u = nod[grp]
        out[nm] = (f, np.radians(V + u))
    return out


def predict(t, z0, cons):
    ph = phases(t, list(cons))
    y = np.full(len(t), z0, dtype=float)
    for nm, (amp, g) in cons.items():
        f, phi = ph[nm]
        y += f * amp * np.cos(phi - math.radians(g))
    return y


def select(days):
    """Rayleigh criterion on record length."""
    chosen = []
    hours = days * 24.0
    for nm in PRIORITY:
        w = speed(nm)
        if all(abs(w - speed(c)) * hours >= 360.0 for c in chosen):
            chosen.append(nm)
    return chosen


def fit(t, y, names, infer=None, fixed=None):
    """Least squares. infer: {name: (base, ratio, lag_deg)} folded into the base column.
    fixed: {name: (amp, phase)} subtracted before fitting."""
    infer = infer or {}
    fixed = fixed or {}
    if fixed:
        y = y - predict(t, 0.0, fixed)
    allnames = list(dict.fromkeys(names + list(infer)))
    ph = phases(t, allnames)
    cols = [np.ones(len(t))]
    for nm in names:
        f, phi = ph[nm]
        c, s = f * np.cos(phi), f * np.sin(phi)
        for inf, (base, ratio, lag) in infer.items():
            if base == nm:
                fi, phii = ph[inf]
                c = c + ratio * fi * np.cos(phii - math.radians(lag))
                s = s + ratio * fi * np.sin(phii - math.radians(lag))
        cols += [c, s]
    X = np.vstack(cols).T
    keep = np.isfinite(y)
    for _ in range(3):  # iterative outlier rejection
        coef, *_ = np.linalg.lstsq(X[keep], y[keep], rcond=None)
        res = y - X @ coef
        sd = np.nanstd(res[keep])
        new = keep & (np.abs(res) < 4.5 * sd)
        if new.sum() == keep.sum():
            break
        keep = new
    z0 = coef[0]
    cons = {}
    for i, nm in enumerate(names):
        a, b = coef[1 + 2 * i], coef[2 + 2 * i]
        cons[nm] = (float(math.hypot(a, b)), float(math.degrees(math.atan2(b, a)) % 360))
    for inf, (base, ratio, lag) in infer.items():
        amp, g = cons[base]
        cons[inf] = (amp * ratio, (g + lag) % 360)
    cons.update({k: (float(v[0]), float(v[1])) for k, v in fixed.items()})
    resid = y - X @ coef
    return float(z0), cons, float(np.nanstd(resid[keep])), int(keep.sum())


def extremes(t, y):
    """Local maxima/minima of a regularly sampled series, with parabolic refinement."""
    i = np.arange(1, len(y) - 1)
    hi = i[(y[i] > y[i - 1]) & (y[i] >= y[i + 1])]
    lo = i[(y[i] < y[i - 1]) & (y[i] <= y[i + 1])]
    step = (t[1] - t[0]).astype('timedelta64[s]').astype(float)
    out = []
    for kind, idx in (('H', hi), ('L', lo)):
        for k in idx:
            a, b, c = y[k - 1], y[k], y[k + 1]
            den = a - 2 * b + c
            off = 0.5 * (a - c) / den if den else 0.0
            out.append((t[k] + np.timedelta64(int(off * step), 's'), b - 0.25 * (a - c) * off, kind))
    out.sort(key=lambda e: e[0])
    return out


def regular(t, y):
    """Place hourly samples on a gap-aware regular grid (NaN where missing)."""
    grid = np.arange(t[0], t[-1] + np.timedelta64(1, 'h'), np.timedelta64(1, 'h'))
    out = np.full(len(grid), np.nan)
    out[((t - t[0]) / np.timedelta64(1, 'h')).astype(int)] = y
    return grid, out


def compare_extremes(t_obs, y_obs, z0, cons):
    """Match observed (smoothed) highs/lows with predicted ones -> time / height errors."""
    # smooth hourly observations with a 3-hour running mean to suppress noise before picking extremes;
    # NaNs (gaps) propagate so no extreme is picked next to a gap
    tg, yg = regular(t_obs, y_obs)
    ys = np.convolve(yg, np.ones(3) / 3, mode='same')
    tf = np.arange(t_obs[0], t_obs[-1], np.timedelta64(6, 'm'))
    obs_ext = extremes(tg, ys)
    pred_ext = extremes(tf, predict(tf, z0, cons))
    if not pred_ext:
        return None
    pt = np.array([e[0] for e in pred_ext]).astype('datetime64[s]').astype(np.int64)
    dts, dhs = [], []
    for (tm, h, kind) in obs_ext:
        k = int(np.argmin(np.abs(pt - np.datetime64(tm, 's').astype(np.int64))))
        if pred_ext[k][2] != kind:
            continue
        d = (pt[k] - np.datetime64(tm, 's').astype(np.int64)) / 60.0
        if abs(d) > 120:
            continue
        dts.append(d)
        dhs.append(pred_ext[k][1] - h)
    if not dts:
        return None
    dts, dhs = np.array(dts), np.array(dhs)
    return {'n': int(len(dts)), 'time_mae_min': round(float(np.mean(np.abs(dts))), 1),
            'time_p90_min': round(float(np.percentile(np.abs(dts), 90)), 1),
            'height_mae_cm': round(float(np.mean(np.abs(dhs - np.mean(dhs)))) * 100, 1)}


def load_uhslc(path):
    rows = Path(path).read_text().splitlines()[2:]
    t, y = [], []
    for r in rows:
        a, b = r.split(',')
        v = float(b)
        if not math.isfinite(v) or v == -32767:
            continue
        t.append(np.datetime64(a.replace('Z', ''), 's'))
        y.append(v / 1000.0)
    return np.array(t, dtype='datetime64[s]'), np.array(y)


def load_ioc(path, sensor=None):
    data = json.loads(Path(path).read_text())
    if sensor is None:
        counts = {}
        for _, s, _ in data:
            counts[s] = counts.get(s, 0) + 1
        sensor = max(counts, key=counts.get)
    pts = [(np.datetime64(tm.replace(' ', 'T'), 's'), v) for tm, s, v in data if s == sensor and v is not None]
    t = np.array([p[0] for p in pts], dtype='datetime64[s]')
    v = np.array([p[1] for p in pts], dtype=float)
    # 7.78 / 77.77 / 0 are radar fault codes in these feeds
    bad = (np.abs(v - 7.78) < 0.006) | (np.abs(v - 77.77) < 0.006) | (v <= 0) | (v > 60)
    t, v = t[~bad], v[~bad]
    # Until early Aug 2026 the Omani radar channels reported in a different, inconsistent scale
    # (daily medians ~10-20 instead of ~2 m). Keep only the data after the last such day.
    day = t.astype('datetime64[D]')
    udays, dinv = np.unique(day, return_inverse=True)
    dmed = np.array([np.median(v[dinv == i]) for i in range(len(udays))])
    if (dmed > 6).any():
        cut = udays[np.where(dmed > 6)[0][-1]] + np.timedelta64(1, 'D')
        keep = (t >= cut.astype('datetime64[s]')) & (v < 6)
        t, v = t[keep], v[keep]
    # despike against a running median (15 samples), then average into hourly bins centred on the hour
    from numpy.lib.stride_tricks import sliding_window_view
    if len(v) > 20:
        med = np.median(sliding_window_view(np.pad(v, 7, mode='edge'), 15), axis=1)
        good = np.abs(v - med) < 0.15
        t, v = t[good], v[good]
    hour = ((t + np.timedelta64(30, 'm')).astype('datetime64[h]'))
    uniq, inv, cnt = np.unique(hour, return_inverse=True, return_counts=True)
    sums = np.bincount(inv, weights=v)
    ok = cnt >= 30
    return uniq[ok].astype('datetime64[s]'), (sums / cnt)[ok], sensor


def lag_minutes(t, y, z0, cons):
    """Time shift (minutes) that best aligns observations with a model (positive: obs later)."""
    best = None
    for lag in range(-720, 721, 5):
        pred = predict(t - np.timedelta64(lag, 'm'), z0, cons)
        r = y - pred
        sd = np.std(r - r.mean())
        if best is None or sd < best[1]:
            best = (lag, sd)
    return best


def levels(z0, cons):
    t = np.arange(np.datetime64('2019-01-01'), np.datetime64('2038-01-01'), np.timedelta64(20, 'm'))
    y = predict(t, z0, cons)
    lat_, hat = float(y.min()), float(y.max())
    m2, s2 = cons.get('M2', (0, 0))[0], cons.get('S2', (0, 0))[0]
    k1, o1 = cons.get('K1', (0, 0))[0], cons.get('O1', (0, 0))[0]
    return {'lat': lat_, 'hat': hat, 'mhws': z0 + m2 + s2, 'mlws': z0 - m2 - s2,
            'form': (k1 + o1) / (m2 + s2) if (m2 + s2) else None}


def main():
    uh, ioc = Path(sys.argv[1]), Path(sys.argv[2])
    report = {}
    stations = []

    # ---------- long records (UHSLC): full constituent sets, hold-out validation ----------
    LONG = [
        ('muscat', 'مسقط (ميناء السلطان قابوس)', 'Muscat (Port Sultan Qaboos)', 23.6283, 58.565, 'muscat.csv', 'UHSLC #110'),
        ('masirah', 'جزيرة مصيرة', 'Masirah Island', 20.6867, 58.8717, 'masirah.csv', 'UHSLC #113'),
        ('salalah', 'صلالة (ميناء صلالة)', 'Salalah (Port of Salalah)', 16.935, 54.0067, 'salalah.csv', 'UHSLC #114'),
    ]
    refs = {}
    for sid, ar, en, la, lo, fn, src in LONG:
        t, y = load_uhslc(uh / fn)
        days = (t[-1] - t[0]).astype('timedelta64[D]').astype(int)
        names = select(days)
        cut = t[-1] - np.timedelta64(365, 'D')
        tr, te = t < cut, t >= cut
        z0v, consv, sdv, _ = fit(t[tr], y[tr], select((cut - t[0]).astype('timedelta64[D]').astype(int)))
        rms = float(np.std((y[te] - predict(t[te], z0v, consv))))
        ext = compare_extremes(t[te], y[te], z0v, consv)
        z0, cons, sd, n = fit(t, y, names)
        lv = levels(z0, cons)
        refs[sid] = (z0, cons, la, lo)
        st = {'id': sid, 'ar': ar, 'en': en, 'lat': la, 'lon': lo,
              'source': f'{src}: {str(t[0])[:10]} → {str(t[-1])[:10]}', 'days': int(days),
              'z0': z0 - lv['lat'], 'hat': lv['hat'] - lv['lat'], 'mhws': lv['mhws'] - lv['lat'], 'mlws': lv['mlws'] - lv['lat'],
              'form': lv['form'], 'cons': cons,
              'validation': {'test': f'{str(cut)[:10]} → {str(t[-1])[:10]} (held out)', 'rms_cm': round(rms * 100, 1), **(ext or {})}}
        stations.append(st)
        report[sid] = {'constituents': len(cons), 'fit_sd_cm': round(sd * 100, 1), **st['validation']}

    # Diagnostic only: IOC "masi2" (2026) differs from the UHSLC Masirah record by ~40° in the
    # semidiurnal phases but only ~6° in the diurnal ones (not a clock offset) and is noisy
    # (fit sd ~35 cm vs 10-13 cm elsewhere), so it is reported here and not used.
    if (ioc / 'masi2.json').exists():
        t2, y2, sens = load_ioc(ioc / 'masi2.json')
        z0m, consm = refs['masirah'][:2]
        lag = lag_minutes(t2, y2, z0m, consm)
        r = y2 - predict(t2, z0m, consm)
        report['masirah_2026_check'] = {'samples_h': int(len(t2)), 'best_lag_min': lag[0], 'rms_cm_at_lag0': round(float(np.std(r - r.mean())) * 100, 1),
                                        'rms_cm_at_best_lag': round(lag[1] * 100, 1), **(compare_extremes(t2, y2 - r.mean(), z0m, consm) or {})}
    if (ioc / 'sala.json').exists():
        t3, y3, sens = load_ioc(ioc / 'sala.json', 'prs')
        z0s, conss = refs['salalah'][:2]
        lag = lag_minutes(t3, y3, z0s, conss)
        report['salalah_ioc_clock'] = {'best_lag_min': lag[0]}

    # ---------- short records (IOC): Rayleigh selection + inference from nearest long record ----------
    SHORT = [
        ('qurayat', 'قريات', 'Qurayat', 23.26, 58.925, 'qura'),
        ('majis', 'مجيس (صحار)', 'Majis (Sohar)', 24.518, 56.606, 'maji'),
        ('wudam', 'خور ودام (المصنعة)', 'Khawr Wudam', 23.82, 57.52, 'wuda'),
        ('dibba', 'دبا (مسندم)', 'Dibba', 25.649, 56.269, 'diba'),
        ('ashkharah', 'الأشخرة', 'Al Ashkharah', 21.85, 59.57, 'ashk'),
        ('duqm', 'الدقم', 'Duqm', 19.66, 57.72, 'duqm'),
    ]
    for sid, ar, en, la, lo, code in SHORT:
        path = ioc / f'{code}.json'
        if not path.exists():
            continue
        t, y, sens = load_ioc(path)
        if len(t) < 24 * 16:
            report[sid] = 'too short'
            continue
        ref = min(refs.values(), key=lambda r: (r[2] - la) ** 2 + ((r[3] - lo) * math.cos(math.radians(la))) ** 2)
        rz0, rcons = ref[0], ref[1]
        # clock check against the nearest long record: tides here should be within ~1 h of it
        lag = lag_minutes(t, y, rz0, rcons)

        def build(days):
            # long-period terms on records under a year would mostly fit weather, so leave them out
            skip = {'Sa', 'Ssa', 'S1'} | ({'Mm', 'Mf', 'MSf'} if days < 365 else set())
            names = [n for n in select(days) if n not in skip]
            infer = {k: (b, rcons[k][0] / rcons[b][0], (rcons[k][1] - rcons[b][1]) % 360)
                     for k, b in INFER.items() if k not in names and k in rcons and b in names and rcons[b][0] > 0}
            fixed = {k: rcons[k] for k in ('Sa', 'Ssa') if k in rcons}
            return names, infer, fixed

        days = (t[-1] - t[0]).astype('timedelta64[D]').astype(int)
        ndays = len(np.unique(t.astype('datetime64[D]')))
        hold = int(max(7, min(30, ndays * 0.3)))
        cut = t[-1] - np.timedelta64(hold, 'D')
        tr, te = t < cut, t >= cut
        nv, iv, fv = build((cut - t[0]).astype('timedelta64[D]').astype(int))
        z0v, consv, _, _ = fit(t[tr], y[tr], nv, iv, fv)
        rv = y[te] - predict(t[te], z0v, consv)
        ext = compare_extremes(t[te], y[te], z0v, consv)
        names, infer, fixed = build(days)
        z0, cons, sd, n = fit(t, y, names, infer, fixed)
        lv = levels(z0, cons)
        st = {'id': sid, 'ar': ar, 'en': en, 'lat': la, 'lon': lo,
              'source': f'IOC SLSMF "{code}" ({sens}): {str(t[0])[:10]} → {str(t[-1])[:10]}', 'days': int(days),
              'z0': z0 - lv['lat'], 'hat': lv['hat'] - lv['lat'], 'mhws': lv['mhws'] - lv['lat'], 'mlws': lv['mlws'] - lv['lat'],
              'form': lv['form'], 'cons': cons, 'inferred': sorted(infer),
              'validation': {'test': f'{str(cut)[:10]} → {str(t[-1])[:10]} (held out)', 'rms_cm': round(float(np.std(rv - rv.mean())) * 100, 1), **(ext or {})}}
        stations.append(st)
        report[sid] = {'fitted': len(names), 'inferred': sorted(infer), 'clock_lag_vs_ref_min': lag[0], 'fit_sd_cm': round(sd * 100, 1), **st['validation']}

    for st in stations:
        st['cons'] = {k: [round(v[0], 4), round(v[1], 2)] for k, v in sorted(st['cons'].items(), key=lambda kv: -kv[1][0])}
        for k in ('z0', 'hat', 'mhws', 'mlws'):
            st[k] = round(st[k], 3)
        st['form'] = round(st['form'], 2) if st['form'] is not None else None
    out = {
        'v': 1,
        'generated': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%MZ'),
        'datum': 'LAT (lowest astronomical tide over 2019-2037), ≈ chart datum',
        'table': {k: [list(v[0]), v[1], v[2]] for k, v in TABLE.items()},
        'stations': stations,
    }
    dest = Path(__file__).resolve().parent.parent / 'data' / 'oman-tides.json'
    dest.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')))
    print(json.dumps(report, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
