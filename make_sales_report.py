import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import os

months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
apple_sales = [5200, 4800, 6100, 5500, 5800, 6400, 5900, 6200, 7000, 6800, 7500, 8200]
samsung_sales = [6100, 5700, 6500, 6000, 6300, 6900, 6400, 6600, 7200, 7000, 7600, 8000]
x = np.arange(len(months))
width = 0.38
fig, ax = plt.subplots(figsize=(11, 6.5), dpi=150)
bars1 = ax.bar(x - width/2, apple_sales, width, label="Apple", color="#a3a3a3", edgecolor="black")
bars2 = ax.bar(x + width/2, samsung_sales, width, label="Samsung", color="#1428a0", edgecolor="black")
ax.set_xlabel("Month", fontsize=12)
ax.set_ylabel("Sales (thousands of units)", fontsize=12)
ax.set_title("Monthly Sales of Apple vs Samsung - 2025", fontsize=15, fontweight="bold")
ax.set_xticks(x)
ax.set_xticklabels(months)
ax.legend(fontsize=11)
ax.grid(axis="y", linestyle="--", alpha=0.4)
ax.set_axisbelow(True)
for bar in list(bars1) + list(bars2):
    h = bar.get_height()
    ax.text(bar.get_x() + bar.get_width()/2, h + 80, f"{int(h):,}", ha="center", va="bottom", fontsize=7.5)
ax.set_ylim(0, 9000)
fig.tight_layout()
os.makedirs("output", exist_ok=True)
out_path = os.path.join("output", "sales_report.pdf")
fig.savefig(out_path, format="pdf")
print("SAVED:", os.path.abspath(out_path))
