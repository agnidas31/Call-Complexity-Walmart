"""
Bundle index.html + sample_contacts.js + portable-data.js + dashboard.js into
one fully self-contained HTML file with zero local file dependencies (only
the Tailwind/Chart.js CDN scripts still need internet -- everything else,
including the sample dataset, is inlined).

Run: python3 build_standalone.py
Writes: call-complexity-scorecard-demo.html
"""
from pathlib import Path

ROOT = Path(__file__).parent
html = (ROOT / "index.html").read_text()

replacements = {
    '<script>window.__TABLE_REF__ = "sample-data";</script>\n'
    '  <script src="sample_contacts.js"></script>\n'
    '  <script src="portable-data.js"></script>\n'
    '  <script src="dashboard.js?v=12"></script>':
        "<script>window.__TABLE_REF__ = \"sample-data\";</script>\n"
        f"  <script>\n{(ROOT / 'sample_contacts.js').read_text()}\n</script>\n"
        f"  <script>\n{(ROOT / 'portable-data.js').read_text()}\n</script>\n"
        f"  <script>\n{(ROOT / 'dashboard.js').read_text()}\n</script>",
}

for old, new in replacements.items():
    if old not in html:
        raise SystemExit("Could not find script-tag block to replace -- did index.html change?")
    html = html.replace(old, new)

out_path = ROOT / "call-complexity-scorecard-demo.html"
out_path.write_text(html)
print(f"Wrote {out_path} ({out_path.stat().st_size / 1_000_000:.1f} MB)")
