# QGIS Layer Viewer

A serverless, browser-based viewer for QGIS Layer Definition files (`.qlr`) built with OpenLayers 9.2.4.

No server, no framework, no build step — just open the HTML file in a browser.

## 🔗 Live Demo

👉 [geo.edesma.org/qgisviewer](https://geo.edesma.org/qgisviewer/index.html)

## ✨ Features

- Load QGIS Layer Definition files (`.qlr`) directly in the browser
- Load and save `.qview` files — a self-contained JSON bundle of layers and settings
- Multi-layer point symbol rendering from QGIS XML symbology
- Legend panel with canvas-extracted symbols
- Basemap switcher with tile previews
- Attribute table with sort, search, CSV export, and zoom to feature
- Map tips with hybrid hit detection (points, lines, polygons)
- ArcGIS FeatureServer support with OID-keyset pagination
- Edit Layer modal for adjusting layer properties
- Companion QGIS Python console script (`qview_importer.py`) for importing `.qview` files back into QGIS

## 🚀 How to Use

1. Download or clone this repository
2. Open `index.html` in any modern browser
3. Use the **Load Layer** button to open a `.qlr` file or a `.qview` bundle
4. No installation or server required

## 📋 Requirements

- A modern browser (Chrome, Firefox, Edge)
- No internet connection required after loading (except for basemap tiles)

## 📖 Documentation

A full walkthrough of the user interface, with screenshots, is available on the project blog:  
👉 [geo.edesma.org — QGIS Layer Viewer](https://geo.edesma.org/blog/?p=93&lang=en)

## 📄
