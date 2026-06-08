"""
╔══════════════════════════════════════════════════════════════╗
║         QGIS Layer Viewer — .qview Importer  v1.2           ║
║                                                              ║
║  Loads a .qview bundle into QGIS as a layer group,          ║
║  restoring symbology, layer names, opacity, visibility,      ║
║  and stack order from the exported viewer session.           ║
║                                                              ║
║  HOW TO USE                                                  ║
║  1. In QGIS: Plugins > Python Console                        ║
║  2. Click the "Show Editor" button (script icon)             ║
║  3. Paste this entire script into the editor                 ║
║  4. Click Run (▶)                                            ║
║  5. Select your .qview file in the dialog                    ║
║                                                              ║
║  Requires: QGIS 3.x                                         ║
╚══════════════════════════════════════════════════════════════╝
"""

import json
import os
import tempfile

from qgis.core import (
    QgsProject,
    QgsVectorLayer,
    QgsLayerTreeLayer,
    QgsRectangle,
    QgsFeatureRenderer,
    QgsAbstractVectorLayerLabeling,
    QgsReadWriteContext,
)
from qgis.PyQt.QtXml import QDomDocument
from qgis.PyQt.QtWidgets import QFileDialog, QMessageBox


# ── 1. Select .qview file ──────────────────────────────────────────────────────
qview_path, _ = QFileDialog.getOpenFileName(
    None,
    "Open .qview file",
    "",
    "QGIS Layer Viewer bundle (*.qview);;All files (*)"
)

if not qview_path:
    print("[qview] No file selected — cancelled.")
    raise SystemExit

print(f"[qview] Loading: {qview_path}")


# ── 2. Parse and validate the bundle ──────────────────────────────────────────
with open(qview_path, encoding="utf-8") as f:
    bundle = json.load(f)

if bundle.get("version") != 1 or not isinstance(bundle.get("layers"), list):
    QMessageBox.critical(None, "QView Import",
        "Invalid or unsupported .qview file.\n"
        "Expected version 1 produced by QGIS Layer Viewer.")
    raise SystemExit

layer_defs = bundle["layers"]

if not layer_defs:
    QMessageBox.information(None, "QView Import",
        "The .qview file contains no layers.")
    raise SystemExit

file_label = os.path.splitext(os.path.basename(qview_path))[0]
print(f"[qview] Found {len(layer_defs)} layer(s) — exported: {bundle.get('exported','?')}")


# ── 3. Helper: apply QGIS renderer from QLR XML ───────────────────────────────
#
#  WHY THIS APPROACH:
#    importNamedStyle() expects a <qgis> root element (QML format).
#    A .qlr file has <qlr> > <maplayers> > <maplayer> structure — so
#    importNamedStyle silently finds nothing and uses the default style.
#
#    QgsFeatureRenderer.load() works directly on the <renderer-v2> element
#    regardless of where it lives in the document — no root element required.
#    Same for QgsAbstractVectorLayerLabeling.create() on <labeling>.
#
def apply_qlr_style(layer, qlr_str):
    """
    Parse the QLR XML and apply renderer + labeling directly to the layer.
    Returns (renderer_ok, labeling_ok).
    """
    doc = QDomDocument()
    parse_ok, err_msg, err_line, _ = doc.setContent(qlr_str)
    if not parse_ok:
        print(f"  [warn] QLR XML parse error at line {err_line}: {err_msg}")
        return False, False

    context = QgsReadWriteContext()
    renderer_ok  = False
    labeling_ok  = False

    # ── Renderer ──────────────────────────────────────────────────────────────
    renderer_nodes = doc.elementsByTagName("renderer-v2")
    if renderer_nodes.count() > 0:
        renderer_el = renderer_nodes.at(0).toElement()
        renderer = QgsFeatureRenderer.load(renderer_el, context)
        if renderer:
            layer.setRenderer(renderer)
            renderer_ok = True
        else:
            print(f"  [warn] QgsFeatureRenderer.load() returned None")
    else:
        print(f"  [warn] No <renderer-v2> element found in QLR")

    # ── Labeling ──────────────────────────────────────────────────────────────
    labeling_nodes = doc.elementsByTagName("labeling")
    if labeling_nodes.count() > 0:
        labeling_el = labeling_nodes.at(0).toElement()
        # Only apply if labeling type is "simple" or "rule-based"
        labeling_type = labeling_el.attribute("type")
        if labeling_type in ("simple", "rule-based"):
            labeling = QgsAbstractVectorLayerLabeling.create(labeling_el, context)
            if labeling:
                layer.setLabeling(labeling)
                # Labels are off by default in the viewer — honour saved state
                labeling_ok = True

    return renderer_ok, labeling_ok


# ── 4. Create layer group ──────────────────────────────────────────────────────
project = QgsProject.instance()
root    = project.layerTreeRoot()
group   = root.insertGroup(0, f"QView: {file_label}")
print(f"[qview] Created group: '{group.name()}'")


# ── 5. Load each layer ─────────────────────────────────────────────────────────
tmpdir = tempfile.mkdtemp(prefix="qview_import_")
print(f"[qview] Temp directory: {tmpdir}")

loaded_layers = []

for i, ld in enumerate(layer_defs):
    layer_name = ld.get("name", f"Layer {i + 1}")
    print(f"[qview] [{i+1}/{len(layer_defs)}] '{layer_name}'")

    try:
        geojson_str    = ld.get("geojson", "")
        qlr_str        = ld.get("qlr", "")
        opacity        = ld.get("opacity", 100) / 100.0
        visible        = ld.get("visible", True)
        labels_enabled = ld.get("labelsEnabled", False)

        if not geojson_str:
            print(f"  [skip] No GeoJSON data.")
            continue

        # Write GeoJSON to temp file
        geojson_path = os.path.join(tmpdir, f"layer_{i:02d}.geojson")
        with open(geojson_path, "w", encoding="utf-8") as gf:
            gf.write(geojson_str)

        # Load GeoJSON as vector layer
        layer = QgsVectorLayer(geojson_path, layer_name, "ogr")
        if not layer.isValid():
            print(f"  [error] GeoJSON layer is not valid — skipping.")
            continue

        feat_count = layer.featureCount()
        print(f"  [ok] {feat_count} features loaded.")

        # Apply renderer + labeling from QLR
        if qlr_str:
            r_ok, l_ok = apply_qlr_style(layer, qlr_str)
            status = []
            if r_ok: status.append("renderer")
            if l_ok: status.append("labeling")
            if status:
                print(f"  [ok] Style applied: {', '.join(status)}.")
            else:
                print(f"  [warn] No style elements applied — check QLR content.")
        else:
            print(f"  [warn] No QLR data — default styling.")

        # Apply saved state
        layer.setName(layer_name)
        layer.setOpacity(opacity)
        layer.setLabelsEnabled(labels_enabled)

        # Add to project and group
        project.addMapLayer(layer, False)
        tree_node = QgsLayerTreeLayer(layer)
        group.addChildNode(tree_node)
        tree_node.setItemVisibilityChecked(visible)

        loaded_layers.append(layer)
        print(f"  ✓  opacity:{int(opacity*100)}%  visible:{visible}  labels:{labels_enabled}")

    except Exception as err:
        import traceback
        print(f"  [error] {err}")
        traceback.print_exc()
        continue


# ── 6. Zoom to combined extent ─────────────────────────────────────────────────
if loaded_layers:
    try:
        combined = QgsRectangle()
        for lyr in loaded_layers:
            ext = lyr.extent()
            if not ext.isEmpty():
                combined.combineExtentWith(ext)
        if not combined.isEmpty():
            iface.mapCanvas().setExtent(combined)
            iface.mapCanvas().refresh()
    except Exception as zoom_err:
        print(f"[qview] Could not zoom to extent: {zoom_err}")


# ── 7. Final report ────────────────────────────────────────────────────────────
n_loaded = len(loaded_layers)

if n_loaded == 0:
    root.removeChildNode(group)
    QMessageBox.warning(None, "QView Import",
        "No layers could be loaded from this .qview file.\n"
        "Check the Python Console for details.")
    print("[qview] ✗ Import failed — no layers loaded.")
else:
    summary = (
        f"Loaded {n_loaded} of {len(layer_defs)} layer(s)\n"
        f"into group '{group.name()}'.\n\n"
        f"Temp GeoJSON files are in:\n{tmpdir}"
    )
    print(f"\n[qview] ✓ Done — {n_loaded}/{len(layer_defs)} layers loaded.")
    QMessageBox.information(None, "QView Import — Done", summary)
