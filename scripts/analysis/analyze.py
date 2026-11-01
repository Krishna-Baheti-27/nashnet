"""Statistical analysis and figures for NashNet.

Reads data/*.csv (produced by scripts/run-experiments.js) and writes
  results/figures/*.pdf    figures
  results/tables/*.tex     LaTeX tables
  data/summary.json        every number quoted in the text

Usage:  python3 scripts/analysis/analyze.py
"""
import json
import math
import os

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy import integrate, stats

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA = os.path.join(ROOT, "data")
FIG = os.path.join(ROOT, "results", "figures")
TAB = os.path.join(ROOT, "results", "tables")
os.makedirs(FIG, exist_ok=True)
os.makedirs(TAB, exist_ok=True)

RULES = ["none", "memory", "rep", "quota", "pricing", "audit", "repaudit", "all"]
LABEL = {
    "none": "No rules", "memory": "Memory only", "rep": "Memory + reputation",
    "quota": "Commons quotas", "pricing": "Congestion pricing", "audit": "Random audits",
    "repaudit": "Reputation + audits", "all": "All mechanisms",
}
SUPPLY = ["abundant", "normal", "shortage"]
SUPPLY_LABEL = {"abundant": "Abundant", "normal": "Normal", "shortage": "Shortage"}
STRATS = ["TFT", "ALLC", "TRADER", "REP", "ALLD", "AGGR"]

# categorical slots (validated, light surface) + text and grid tokens
C1, C2, C3, C4 = "#2a78d6", "#eb6834", "#1baf7a", "#eda100"
INK, INK2, GRID = "#0b0b0b", "#52514e", "#e2e1dc"

plt.rcParams.update({
    "font.family": "serif", "font.serif": ["STIXGeneral", "DejaVu Serif"], "mathtext.fontset": "stix",
    "font.size": 8, "axes.titlesize": 8, "axes.labelsize": 8, "xtick.labelsize": 7, "ytick.labelsize": 7,
    "legend.fontsize": 7, "axes.edgecolor": INK2, "axes.labelcolor": INK, "xtick.color": INK2, "ytick.color": INK2,
    "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.6, "axes.axisbelow": True,
    "axes.spines.top": False, "axes.spines.right": False, "lines.linewidth": 1.4,
    "pdf.fonttype": 42, "ps.fonttype": 42, "savefig.bbox": "tight", "savefig.pad_inches": 0.02,
})
COL = 3.45   # single-column figure width (in)
DBL = 7.0    # double-column figure width (in)


def tci(x, conf=0.95):
    """Mean and half-width of the two-sided t confidence interval."""
    x = np.asarray(x, dtype=float)
    n = len(x)
    m = float(np.mean(x))
    if n < 2:
        return m, 0.0
    s = float(np.std(x, ddof=1))
    h = float(stats.t.ppf(0.5 + conf / 2, n - 1) * s / math.sqrt(n))
    return m, h


def texminus(line):
    """Typeset negative numbers with a proper minus sign in LaTeX tables."""
    import re
    return re.sub(r"(^|[\s(&])-(?=\d)", lambda m: m.group(1) + "$-$", line)


def save(fig, name):
    fig.savefig(os.path.join(FIG, name))
    plt.close(fig)


S = {}  # summary numbers

# --------------------------------------------------------------------------- E1
e1 = pd.read_csv(os.path.join(DATA, "e1_main.csv"))
n_seeds = int(e1.seed.max())
S["n_seeds"] = n_seeds
S["n_runs_e1"] = int(len(e1))
e1["survival_pct"] = 100 * e1.survival
e1["served_pct"] = 100 * e1.served
e1["cheat_pct"] = 100 * e1.cheat_adv
e1["coop_pct"] = 100 * e1.coop_rate
e1["reserve_pct"] = 100 * e1.reserve

METRICS = [("survival_pct", "{:.1f}"), ("served_pct", "{:.1f}"), ("cheat_pct", "{:+.1f}"),
           ("coop_pct", "{:.1f}"), ("gini", "{:.3f}"), ("reserve_pct", "{:.1f}")]
S["e1"] = {}
for sup in SUPPLY:
    S["e1"][sup] = {}
    for r in RULES:
        d = e1[(e1.supply == sup) & (e1.ruleset == r)].sort_values("seed")
        row = {}
        for m, _ in METRICS + [("w_hat", ""), ("selfish_offline", ""), ("coop_offline", ""), ("audits", ""), ("gifts", ""), ("encounters", "")]:
            mu, h = tci(d[m])
            row[m] = [mu, h]
        S["e1"][sup][r] = row

# best value per column (shortage) for bolding
def e1_table(sup, fname, caption_label):
    best = {}
    for m, _ in METRICS:
        vals = {r: S["e1"][sup][r][m][0] for r in RULES}
        if m in ("cheat_pct", "gini"):
            best[m] = min(vals, key=vals.get)
        else:
            best[m] = max(vals, key=vals.get)
    lines = []
    for r in RULES:
        cells = [LABEL[r]]
        for m, f in METRICS:
            mu, h = S["e1"][sup][r][m]
            hf = f.replace("+", "")
            txt = f.format(mu) + r"\,$\pm$\," + hf.format(h)
            if best[m] == r:
                txt = r"\textbf{" + txt + "}"
            cells.append(txt)
        lines.append(" & ".join(cells) + r" \\")
    with open(os.path.join(TAB, fname), "w") as fh:
        fh.write("\n".join(texminus(l) for l in lines) + "\n")


e1_table("shortage", "e1_shortage.tex", "shortage")
e1_table("normal", "e1_normal.tex", "normal")
e1_table("abundant", "e1_abundant.tex", "abundant")

# survival across supply (compact)
lines = []
for r in RULES:
    cells = [LABEL[r]]
    for sup in SUPPLY:
        mu, h = S["e1"][sup][r]["survival_pct"]
        cells.append("{:.1f}".format(mu) + r"\,$\pm$\," + "{:.1f}".format(h))
    for sup in SUPPLY:
        mu, h = S["e1"][sup][r]["cheat_pct"]
        cells.append("{:+.1f}".format(mu))
    lines.append(" & ".join(cells) + r" \\")
with open(os.path.join(TAB, "e1_supply.tex"), "w") as fh:
    fh.write("\n".join(texminus(l) for l in lines) + "\n")

# paired comparisons vs. "none" (shortage) with Holm correction
pc = []
base = e1[(e1.supply == "shortage") & (e1.ruleset == "none")].sort_values("seed")
for r in RULES[1:]:
    d = e1[(e1.supply == "shortage") & (e1.ruleset == r)].sort_values("seed")
    for metric in ("survival_pct", "cheat_pct"):
        diff = d[metric].values - base[metric].values
        mu, h = tci(diff)
        sd = float(np.std(diff, ddof=1))
        t_stat = mu / (sd / math.sqrt(len(diff))) if sd > 0 else float("inf")
        p_t = float(2 * stats.t.sf(abs(t_stat), len(diff) - 1))
        try:
            p_w = float(stats.wilcoxon(diff, zero_method="wilcox").pvalue)
        except ValueError:
            p_w = 1.0
        rho = float(np.corrcoef(d[metric].values, base[metric].values)[0, 1])
        pc.append(dict(rule=r, metric=metric, diff=mu, ci=h, t=t_stat, p_t=p_t, p_w=p_w,
                       dz=mu / sd if sd > 0 else float("nan"), rho=rho,
                       var_ratio=float(np.var(diff, ddof=1) / (np.var(d[metric], ddof=1) + np.var(base[metric], ddof=1)))))
pc = pd.DataFrame(pc)
for metric in ("survival_pct", "cheat_pct"):
    sub = pc[pc.metric == metric].sort_values("p_t")
    m = len(sub)
    adj, running = [], 0.0
    for i, p in enumerate(sub.p_t.values):
        running = max(running, min(1.0, (m - i) * p))
        adj.append(running)
    pc.loc[sub.index, "p_holm"] = adj
S["paired"] = pc.to_dict(orient="records")


def pfmt(p):
    if p < 1e-4:
        return r"$<10^{-4}$"
    return "{:.4f}".format(p)


lines = []
for r in RULES[1:]:
    a = pc[(pc.rule == r) & (pc.metric == "survival_pct")].iloc[0]
    b = pc[(pc.rule == r) & (pc.metric == "cheat_pct")].iloc[0]
    lines.append(" & ".join([
        LABEL[r],
        "{:+.1f}".format(a["diff"]) + r"\,$\pm$\," + "{:.1f}".format(a.ci), "{:.2f}".format(a.t), pfmt(a.p_holm), "{:.2f}".format(a.dz),
        "{:+.1f}".format(b["diff"]) + r"\,$\pm$\," + "{:.1f}".format(b.ci), pfmt(b.p_holm),
    ]) + r" \\")
with open(os.path.join(TAB, "paired.tex"), "w") as fh:
    fh.write("\n".join(texminus(l) for l in lines) + "\n")

# head-to-head comparisons with Random audits (paired, every supply level)
vs = []
for sup in SUPPLY:
    ref = e1[(e1.supply == sup) & (e1.ruleset == "audit")].sort_values("seed")
    for r in ["all", "repaudit", "pricing", "quota"]:
        d = e1[(e1.supply == sup) & (e1.ruleset == r)].sort_values("seed")
        row = dict(supply=sup, rule=r)
        for metric, scale in (("survival_pct", 1.0), ("cheat_pct", 1.0), ("gini", 1.0), ("selfish_offline", 1.0)):
            diff = scale * (d[metric].values - ref[metric].values)
            mu, h = tci(diff)
            row[metric] = [mu, h, float(stats.ttest_rel(d[metric].values, ref[metric].values).pvalue)]
        vs.append(row)
S["vs_audit"] = vs
lines = []
for sup in SUPPLY:
    for row in [v for v in vs if v["supply"] == sup]:
        a, b, g, so = row["survival_pct"], row["cheat_pct"], row["gini"], row["selfish_offline"]
        lines.append(" & ".join([
            SUPPLY_LABEL[sup] if row["rule"] == "all" else "", LABEL[row["rule"]],
            "{:+.1f}".format(a[0]) + r"\,$\pm$\," + "{:.1f}".format(a[1]), pfmt(a[2]),
            "{:+.1f}".format(b[0]), pfmt(b[2]),
            "{:+.3f}".format(g[0]), pfmt(g[2]),
            "{:+.2f}".format(so[0]),
        ]) + r" \\")
    if sup != SUPPLY[-1]:
        lines.append(r"\midrule")
with open(os.path.join(TAB, "vs_audit.tex"), "w") as fh:
    fh.write("\n".join(texminus(l) for l in lines) + "\n")

# Figure: survival by rule set and supply (grouped bars with 95% CI)
fig, ax = plt.subplots(figsize=(DBL, 2.3))
x = np.arange(len(RULES))
w = 0.26
for i, (sup, c) in enumerate(zip(SUPPLY, [C1, C3, C2])):
    mus = [S["e1"][sup][r]["survival_pct"][0] for r in RULES]
    hs = [S["e1"][sup][r]["survival_pct"][1] for r in RULES]
    ax.bar(x + (i - 1) * w, mus, width=w * 0.92, color=c, label=SUPPLY_LABEL[sup] + " supply", zorder=2)
    ax.errorbar(x + (i - 1) * w, mus, yerr=hs, fmt="none", ecolor=INK, elinewidth=0.8, capsize=1.8, zorder=3)
ax.set_xticks(x)
ax.set_xticklabels([LABEL[r].replace(" + ", "\n+ ").replace("Commons ", "Commons\n").replace("Congestion ", "Congestion\n").replace("Random ", "Random\n").replace("All ", "All\n").replace("Memory only", "Memory\nonly").replace("No rules", "No\nrules") for r in RULES])
ax.set_ylabel("Tenants online at $t=150$ (%)")
ax.set_ylim(50, 100)
ax.legend(ncol=3, loc="upper left", frameon=False, bbox_to_anchor=(0, 1.13))
ax.grid(axis="x", visible=False)
save(fig, "fig_survival.pdf")

# Figure: paired forest plot (shortage)
fig, axes = plt.subplots(1, 2, figsize=(DBL, 1.95), sharey=True)
order = RULES[1:]
yy = np.arange(len(order))[::-1]
for ax, metric, xlabel in [(axes[0], "survival_pct", r"$\Delta$ survival vs. no rules (pp)"),
                           (axes[1], "cheat_pct", r"$\Delta$ cheater advantage vs. no rules (pp)")]:
    sub = pc[pc.metric == metric].set_index("rule").loc[order]
    ax.axvline(0, color=INK2, lw=0.8)
    ax.errorbar(sub["diff"], yy, xerr=sub.ci, fmt="o", color=C1, ecolor=C1, elinewidth=1.2, capsize=2,
                markersize=4, markeredgecolor="white", markeredgewidth=0.8)
    ax.set_xlabel(xlabel)
    ax.grid(axis="y", visible=False)
axes[0].set_yticks(yy)
axes[0].set_yticklabels([LABEL[r] for r in order])
save(fig, "fig_paired.pdf")

# --------------------------------------------------------------------------- E2
e2 = pd.read_csv(os.path.join(DATA, "e2_audit_sweep.csv"))
grid = sorted(e2.audit_prob.unique())
sw = []
for p in grid:
    d = e2[e2.audit_prob == p]
    sw.append(dict(p=p, cheat=tci(100 * d.cheat_adv), surv=tci(100 * d.survival), served=tci(100 * d.served)))
S["e2"] = [{"p": s["p"], "cheat": s["cheat"], "surv": s["surv"], "served": s["served"]} for s in sw]
cm = np.array([s["cheat"][0] for s in sw])
p_cross = None
for i in range(len(grid) - 1):
    if cm[i] > 0 >= cm[i + 1]:
        p_cross = grid[i] + (grid[i + 1] - grid[i]) * cm[i] / (cm[i] - cm[i + 1])
        break
S["e2_p_cross"] = p_cross

# deterrence threshold p*(lambda) = c*lambda / (rho*lambda + F)
c_cost, rho_r, F = 1.0, 2.0, 4.0
lam_max = 2.0 / 0.3
S["lambda_max"] = lam_max
S["p_star_lam_max"] = c_cost * lam_max / (rho_r * lam_max + F)
S["p_star_limit"] = c_cost / rho_r

fig, axes = plt.subplots(1, 2, figsize=(DBL, 2.0))
fig.subplots_adjust(wspace=0.28)
P = np.array(grid)
for ax, key, ylabel in [(axes[0], "cheat", "Cheater advantage $A$ (%)"), (axes[1], "surv", "Tenants online (%)")]:
    mu = np.array([s[key][0] for s in sw])
    h = np.array([s[key][1] for s in sw])
    ax.axvspan(0, S["p_star_lam_max"], color=C4, alpha=0.13, lw=0)
    ax.fill_between(P, mu - h, mu + h, color=C1, alpha=0.18, lw=0)
    ax.plot(P, mu, color=C1, marker="o", markersize=3.2, markeredgecolor="white", markeredgewidth=0.6)
    ax.axvline(0.4, color=INK2, lw=0.8, ls=":")
    ax.set_xlabel("Audit probability $p$")
    ax.set_ylabel(ylabel)
    ax.set_xlim(0, 1)
axes[0].axhline(0, color=INK2, lw=0.8)
if p_cross is not None:
    axes[0].plot([p_cross], [0], marker="D", color=C2, markersize=4.5, markeredgecolor="white", markeredgewidth=0.7, zorder=5)
    axes[0].annotate(r"$\hat p = %.2f$" % p_cross, xy=(p_cross, 0), xytext=(p_cross + 0.07, 22), fontsize=7, color=INK,
                     arrowprops=dict(arrowstyle="-", color=INK2, lw=0.6))
axes[0].text(0.012, -175, r"band of $p^*(\lambda)$, $\lambda\in[0,\lambda_{\max}]$", fontsize=6.5, color=INK2)
axes[0].text(0.415, -105, "default\n$p=0.4$", fontsize=6.5, color=INK2)
axes[1].text(0.415, 67, "default $p=0.4$", fontsize=6.5, color=INK2)
save(fig, "fig_audit_sweep.pdf")

# --------------------------------------------------------------------------- E3
e3 = pd.read_csv(os.path.join(DATA, "e3_timeseries.csv"))
fig, axes = plt.subplots(1, 3, figsize=(DBL, 1.95))
fig.subplots_adjust(wspace=0.42)
cols = {"none": INK2, "rep": C1, "quota": C4, "audit": C3}
for r in ["none", "rep", "quota", "audit"]:
    d = e3[e3.ruleset == r]
    axes[0].plot(d.tick, d.online, color=cols[r], label=LABEL[r])
    axes[1].plot(d.tick, 100 * d.reserve, color=cols[r], label=LABEL[r])
    adv = 100 * (d.credits_selfish_team / d.credits_coop_team - 1)
    axes[2].plot(d.tick, adv, color=cols[r], label=LABEL[r])
axes[0].set_ylabel("Tenants online")
axes[1].set_ylabel("Mean zone fill $\\bar u$ (%)")
axes[1].axhline(40, color=INK2, lw=0.8, ls=":")
axes[1].text(148, 41.5, "reserve $u_{\\mathrm{res}}$", fontsize=6.5, color=INK2, ha="right")
axes[2].set_ylabel("Cheater advantage $A_t$ (%)")
axes[2].axhline(0, color=INK2, lw=0.8)
for ax in axes:
    ax.set_xlabel("Tick $t$")
    ax.set_xlim(0, 150)
axes[0].legend(frameon=False, loc="lower left")
save(fig, "fig_timeseries.pdf")
S["e3_final"] = {r: {"online": float(e3[(e3.ruleset == r) & (e3.tick == 150)].online.iloc[0]),
                     "reserve": float(e3[(e3.ruleset == r) & (e3.tick == 150)].reserve.iloc[0]),
                     "reserve_min": float(e3[e3.ruleset == r].reserve.min())} for r in ["none", "rep", "quota", "audit"]}

# --------------------------------------------------------------------------- E4
e4 = pd.read_csv(os.path.join(DATA, "e4_replicator.csv"))
fig, axes = plt.subplots(1, 4, figsize=(DBL, 1.75), sharey=True)
S["e4"] = {}
for ax, r in zip(axes, ["none", "rep", "quota", "audit"]):
    d = e4[e4.ruleset == r]
    pivot = d.pivot(index="generation", columns="strategy", values="share")[STRATS]
    coop = pivot[["TFT", "ALLC", "TRADER", "REP"]].sum(axis=1)
    selfish = pivot[["ALLD", "AGGR"]].sum(axis=1)
    ax.fill_between(pivot.index, 0, coop, color=C1, alpha=0.85, lw=0, label="Cooperative strategies")
    ax.fill_between(pivot.index, coop, coop + selfish, color=C2, alpha=0.85, lw=0, label="Selfish strategies")
    ax.set_title(LABEL[r])
    ax.set_xlabel("Generation $g$")
    ax.set_xlim(0, pivot.index.max())
    ax.set_ylim(0, 1)
    ax.grid(False)
    final = pivot.iloc[-1]
    S["e4"][r] = {k: float(final[k]) for k in STRATS}
    S["e4"][r]["selfish_final"] = float(selfish.iloc[-1])
    first_half = selfish[selfish >= 0.5]
    S["e4"][r]["gen_selfish_majority"] = int(first_half.index.min()) if len(first_half) else None
axes[0].set_ylabel("Population share $x$")
axes[0].legend(frameon=False, loc="lower left", fontsize=6.5)
save(fig, "fig_replicator.pdf")

# --------------------------------------------------------------------------- E5
e5 = pd.read_csv(os.path.join(DATA, "e5_robustness.csv"))
S["e5"] = {}
lines = []
for param, vals in [("noise", [0, 0.03, 0.1]), ("radius", [2, 3, 4])]:
    for v in vals:
        cells = [("$\\varepsilon=" if param == "noise" else "$R=") + ("{:g}".format(v)) + "$"]
        for r in ["none", "memory", "rep", "quota", "audit"]:
            d = e5[(e5.param == param) & (e5.value == v) & (e5.ruleset == r)]
            mu, h = tci(100 * d.survival)
            ca, _ = tci(100 * d.cheat_adv)
            S["e5"]["{}={}|{}".format(param, v, r)] = [mu, h, ca]
            cells.append("{:.1f} ({:+.0f})".format(mu, ca))
        lines.append(" & ".join(cells) + r" \\")
with open(os.path.join(TAB, "robustness.tex"), "w") as fh:
    fh.write("\n".join(texminus(l) for l in lines) + "\n")

# --------------------------------------------------------------------------- analytic quantities
alpha, beta, kappa = 0.12, 3.5, 0.3
S["msy_factor"] = alpha + beta / 4
S["g_ratio_reserve"] = (alpha + beta * 0.4 * 0.6) / (alpha + beta / 4)
S["g_ratio_empty"] = alpha / (alpha + beta / 4)
SC = {"abundant": (14, 0.7), "normal": (10, 0.45), "shortage": (8, 0.3)}
S["capacity"] = {}
for sup, (Mz, rr) in SC.items():
    msy_zone = rr * (alpha + beta / 4)
    per_type = 8 * msy_zone
    # recovery time from empty to the reserve (continuous approximation), in ticks
    T, _ = integrate.quad(lambda u: Mz / (rr * (alpha + beta * u * (1 - u))), 0, 0.4)
    S["capacity"][sup] = {
        "M": Mz, "r": rr, "msy_zone": msy_zone, "supply_per_type": per_type,
        "N_max_gpu": per_type / kappa,
        "N_max_power_static": per_type / (kappa + 0.05),
        "recovery_ticks": T,
    }
# Gordon-Schaefer static commons game, N = 10
N = 10
S["gs"] = {"N": N, "effort_ratio": 2 * N / (N + 1), "poa": (N + 1) ** 2 / (4 * N)}
# empirical repeat-encounter probability
S["w_hat"] = {sup: {r: S["e1"][sup][r]["w_hat"] for r in RULES} for sup in SUPPLY}

with open(os.path.join(DATA, "summary.json"), "w") as fh:
    json.dump(S, fh, indent=1, default=float)
print("analysis complete:", len(os.listdir(FIG)), "figures,", len(os.listdir(TAB)), "tables")
