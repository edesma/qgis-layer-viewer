// ================================================================
// QGIS QLR Viewer  —  Point · Line · Polygon
// ================================================================

const MM_TO_PX = 3.78;
const SVG_BASE = "svg/";

// QGIS built-in background SVGs — generated inline to avoid server fetch + warning.
// Templates use the same param() placeholders as real QGIS SVG files so they
// pass through substituteParams() + injectSvgSize() unchanged.
const QGIS_BUILTIN_SVGS = {
    "backgrounds/background_circle.svg":
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><circle cx="40" cy="40" r="37" fill="param(fill) #000000" stroke="param(outline) #000000" stroke-width="param(outline-width) 1"/></svg>`,
    "backgrounds/background_square.svg":
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect x="2" y="2" width="76" height="76" fill="param(fill) #000000" stroke="param(outline) #000000" stroke-width="param(outline-width) 1"/></svg>`,
    "backgrounds/background_square_corners.svg":
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect x="2" y="2" width="76" height="76" rx="12" fill="param(fill) #000000" stroke="param(outline) #000000" stroke-width="param(outline-width) 1"/></svg>`,
    "backgrounds/background_diamond.svg":
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><polygon points="40,2 78,40 40,78 2,40" fill="param(fill) #000000" stroke="param(outline) #000000" stroke-width="param(outline-width) 1"/></svg>`,
    "backgrounds/background_shield.svg":
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><path d="M40,2 L78,16 L78,48 L40,78 L2,48 L2,16 Z" fill="param(fill) #000000" stroke="param(outline) #000000" stroke-width="param(outline-width) 1"/></svg>`,
};


// ────────────────────────────────────────────────────────────────
// Color utilities
// ────────────────────────────────────────────────────────────────
function parseQGISColorRGB(str) {
    if (!str) return [0, 0, 0, 1];
    const p = str.split(",");
    return [parseInt(p[0]), parseInt(p[1]), parseInt(p[2]), parseInt(p[3]) / 255];
}
function parseQGISColor(str) {
    const [r, g, b, a] = parseQGISColorRGB(str);
    return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}
function toHex(str) {
    const [r, g, b] = parseQGISColorRGB(str);
    return "#" + [r, g, b].map(v => v.toString(16).padStart(2, "0")).join("");
}


// ────────────────────────────────────────────────────────────────
// Font size unit conversion (QGIS → CSS pixels at 96 dpi)
// ────────────────────────────────────────────────────────────────
const SUPPORTED_FONT_UNITS = ["point", "pixel", "mm", "inch"];

function fontSizeToPx(size, unit) {
    switch ((unit || "Point").toLowerCase()) {
        case "point":  return size * (96 / 72);   // 1pt = 1.333px at 96dpi
        case "pixel":  return size;
        case "mm":     return size * 3.78;
        case "inch":   return size * 96;
        default:
            // Percentage, MetersAtScale, MapUnit — cannot map to a fixed px value
            console.warn(`[QGIS Layer Viewer] Unsupported font size unit: "${unit}" — defaulting to 10px`);
            return 10;
    }
}

// ────────────────────────────────────────────────────────────────
// SVG utilities
// ────────────────────────────────────────────────────────────────
function substituteParams(svg, props) {
    const fillHex = toHex(props.color), outlineHex = toHex(props.outline_color);
    const fillA = parseQGISColorRGB(props.color)[3].toFixed(3);
    const outA  = parseQGISColorRGB(props.outline_color)[3].toFixed(3);
    const outW  = (parseFloat(props.outline_width || 0) * MM_TO_PX).toFixed(1);
    return svg
        .replace(/param\(fill\)(\s+#[0-9a-fA-F]+)?/g,   fillHex)
        .replace(/param\(outline\)(\s+#[0-9a-fA-F]+)?/g, outlineHex)
        .replace(/param\(fill-opacity\)/g,                fillA)
        .replace(/param\(outline-opacity\)/g,             outA)
        .replace(/param\(outline-width\)(\s+[\d.]+)?/g,   outW);
}
function injectSvgSize(svg, px) {
    const r = Math.round(px);
    return svg.replace(/<svg(\b[^>]*)>/, (_, a) =>
        `<svg width="${r}" height="${r}"${a.replace(/\s+width="[^"]*"/, "").replace(/\s+height="[^"]*"/, "")}>`
    );
}

// ────────────────────────────────────────────────────────────────
// Canvas marker
// ────────────────────────────────────────────────────────────────
function makeCanvasMarker(size, fillColor, strokeColor, strokeWidth, drawFn) {
    const s = Math.round(size), pad = Math.ceil(strokeWidth / 2);
    const canvas = document.createElement("canvas");
    canvas.width = s + pad * 2; canvas.height = s + pad * 2;
    const ctx = canvas.getContext("2d");
    ctx.translate(pad, pad);
    ctx.fillStyle = fillColor; ctx.strokeStyle = strokeColor; ctx.lineWidth = strokeWidth;
    drawFn(ctx, s);
    return new ol.style.Icon({ img: canvas, size: [canvas.width, canvas.height] });
}

// ────────────────────────────────────────────────────────────────
// Glow helper — shared by lines and polygons
// ────────────────────────────────────────────────────────────────
function makeGlowStyles(glowConfig) {
    if (!glowConfig) return [];
    const [r, g, b] = parseQGISColorRGB(glowConfig.color);
    const halo  = (glowConfig.spread + glowConfig.blur) * MM_TO_PX;
    const STEPS = 5;
    const styles = [];
    for (let i = STEPS; i >= 1; i--) {
        const t = i / STEPS;
        styles.push(new ol.style.Style({
            stroke: new ol.style.Stroke({
                color: `rgba(${r},${g},${b},${(glowConfig.opacity * (1 - t)).toFixed(3)})`,
                width: halo * t * 2
            })
        }));
    }
    return styles;
}

// Parse outerGlow from an effectStack element
function parseGlowFromEffectStack(effectStackEl) {
    if (!effectStackEl) return null;
    // effectStack may have 'enabled' as XML attribute or as child Option
    if (effectStackEl.getAttribute("enabled") === "0") return null;

    // Find outerGlow child effect
    let glowEl = null;
    for (const child of effectStackEl.children) {
        if (child.getAttribute("type") === "outerGlow") { glowEl = child; break; }
    }
    if (!glowEl) return null;

    const gp = {};
    [...glowEl.getElementsByTagName("Option")].forEach(o => {
        if (o.getAttribute("name") && o.getAttribute("value"))
            gp[o.getAttribute("name")] = o.getAttribute("value");
    });
    if (gp["enabled"] !== "1") return null;

    return {
        color:   gp["single_color"],
        spread:  parseFloat(gp["spread"]     || 1),
        opacity: parseFloat(gp["opacity"]    || 0.5),
        blur:    parseFloat(gp["blur_level"] || 0.8)
    };
}

// ────────────────────────────────────────────────────────────────
// Label helper
// ────────────────────────────────────────────────────────────────
function makeLabelStyle(feature, cfg) {
    if (!cfg?.fieldName) return null;
    const txt = String(feature.get(cfg.fieldName) ?? "");
    if (!txt) return null;

    const fontPx = fontSizeToPx(cfg.fontSize, cfg.fontSizeUnit);
    let fontStr = `${Math.round(fontPx)}px "${cfg.fontFamily}"`;
    if (cfg.fontBold && cfg.fontItalic) fontStr = "bold italic " + fontStr;
    else if (cfg.fontBold)              fontStr = "bold "        + fontStr;
    else if (cfg.fontItalic)            fontStr = "italic "      + fontStr;

    return new ol.style.Style({
        text: new ol.style.Text({
            text:      txt,
            font:      fontStr,
            overflow:  true,
            // 'line' placement makes labels follow line direction instead of staying horizontal
            placement: cfg.geometryType === "Line" ? "line" : "point",
            fill:      new ol.style.Fill({ color: parseQGISColor(cfg.textColor) }),
            stroke:    cfg.bufferDraw ? new ol.style.Stroke({
                color: parseQGISColor(cfg.bufferColor),
                width: cfg.bufferSize * 2
            }) : undefined
        })
    });
}

// ────────────────────────────────────────────────────────────────
// Style builders
// ────────────────────────────────────────────────────────────────
async function buildPointImage(cls, props) {
    const size = parseFloat(props.size || 2) * MM_TO_PX;
    const fill = new ol.style.Fill({ color: parseQGISColor(props.color) });
    const sw   = parseFloat(props.outline_width || 0);
    const stroke = sw > 0 ? new ol.style.Stroke({ color: parseQGISColor(props.outline_color), width: sw * MM_TO_PX }) : undefined;

    if (cls === "SimpleMarker") {
        const shape = (props.name || "circle").toLowerCase();
        switch (shape) {
            case "circle":    return new ol.style.Circle({ radius: size/2, fill, stroke });
            case "square":
            case "rectangle": return new ol.style.RegularShape({ points:4, radius:size/2, angle:Math.PI/4, fill, stroke });
            case "diamond":   return new ol.style.RegularShape({ points:4, radius:size/2, angle:0, fill, stroke });
            case "triangle":  return new ol.style.RegularShape({ points:3, radius:size/2, angle:0, fill, stroke });
            case "pentagon":  return new ol.style.RegularShape({ points:5, radius:size/2, angle:0, fill, stroke });
            case "hexagon":   return new ol.style.RegularShape({ points:6, radius:size/2, angle:0, fill, stroke });
            case "star":      return new ol.style.RegularShape({ points:5, radius:size/2, radius2:size/4, angle:0, fill, stroke });
            case "cross_fill": {
                const arm = size*0.35, c = size/2;
                return makeCanvasMarker(size, parseQGISColor(props.color), parseQGISColor(props.outline_color), sw*MM_TO_PX,
                    (ctx,s) => { ctx.beginPath(); ctx.rect(c-arm/2,0,arm,s); ctx.rect(0,c-arm/2,s,arm); ctx.fill(); if(sw>0) ctx.stroke(); });
            }
            case "cross":  return makeCanvasMarker(size,"rgba(0,0,0,0)",parseQGISColor(props.outline_color||props.color),Math.max(sw,1)*MM_TO_PX,
                (ctx,s)=>{ctx.beginPath();ctx.moveTo(s/2,0);ctx.lineTo(s/2,s);ctx.moveTo(0,s/2);ctx.lineTo(s,s/2);ctx.stroke();});
            case "x":
            case "cross2": return makeCanvasMarker(size,"rgba(0,0,0,0)",parseQGISColor(props.outline_color||props.color),Math.max(sw,1)*MM_TO_PX,
                (ctx,s)=>{ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(s,s);ctx.moveTo(s,0);ctx.lineTo(0,s);ctx.stroke();});
            case "line": return makeCanvasMarker(size,"rgba(0,0,0,0)",parseQGISColor(props.outline_color||props.color),Math.max(sw,1)*MM_TO_PX,
                (ctx,s)=>{ctx.beginPath();ctx.moveTo(s/2,0);ctx.lineTo(s/2,s);ctx.stroke();});
            default:
                console.warn(`[QGIS Layer Viewer] Unknown shape "${shape}" — circle fallback`);
                return new ol.style.Circle({ radius:size/2, fill, stroke });
        }
    }
    if (cls === "SvgMarker") {
        const nameVal = props.name || "";
        if (nameVal.startsWith("base64:")) {
            const colored = injectSvgSize(substituteParams(atob(nameVal.slice(7)), props), size);
            return new ol.style.Icon({ src: "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(colored))) });
        }
        if (nameVal) {
            // Check for QGIS built-in background SVGs first (no server fetch needed)
            if (QGIS_BUILTIN_SVGS[nameVal]) {
                const colored = injectSvgSize(substituteParams(QGIS_BUILTIN_SVGS[nameVal], props), size);
                return new ol.style.Icon({ src: "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(colored))) });
            }
            try {
                const resp = await fetch(SVG_BASE + nameVal);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const colored = injectSvgSize(substituteParams(await resp.text(), props), size);
                return new ol.style.Icon({ src: "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(colored))) });
            } catch { console.warn(`[QGIS Layer Viewer] SVG not found: ${SVG_BASE + nameVal}`); }
        }
        return new ol.style.Circle({ radius:size/2, fill, stroke });
    }
    return new ol.style.Circle({ radius:size/2, fill, stroke });
}

function makeLineStyle(parts) {
    const glow = [], lines = [];
    parts.forEach(p => {
        glow.push(...makeGlowStyles(p.glow));
        let dash, lineCap;
        if (p.use_custom_dash==="1" && p.customdash) {
            dash = p.customdash.split(";").map(v => Number(v)*MM_TO_PX);
        } else if (p.style==="dot") {
            dash=[p.width*MM_TO_PX,p.width*MM_TO_PX*2]; lineCap="round";
        } else if (p.style==="dash") {
            dash=[p.width*MM_TO_PX*4,p.width*MM_TO_PX*2];
        } else if (p.style==="dash dot") {
            dash=[p.width*MM_TO_PX*4,p.width*MM_TO_PX*2,p.width*MM_TO_PX,p.width*MM_TO_PX*2]; lineCap="round";
        } else if (p.style==="dash dot dot") {
            dash=[p.width*MM_TO_PX*4,p.width*MM_TO_PX*2,p.width*MM_TO_PX,p.width*MM_TO_PX*2,p.width*MM_TO_PX,p.width*MM_TO_PX*2]; lineCap="round";
        }
        const opts = { color:parseQGISColor(p.color), width:p.width*MM_TO_PX, lineDash:dash };
        if (lineCap) opts.lineCap = lineCap;
        lines.push(new ol.style.Style({ stroke: new ol.style.Stroke(opts) }));
    });
    return [...glow, ...lines];
}

function makePolygonStyle(sym) {
    if (!sym) return new ol.style.Style();
    return new ol.style.Style({
        fill: new ol.style.Fill({ color: parseQGISColor(sym.fillColor) }),
        stroke: sym.outlineStyle==="no" ? undefined : new ol.style.Stroke({
            color: parseQGISColor(sym.outlineColor), width: sym.outlineWidth*MM_TO_PX
        })
    });
}


// ────────────────────────────────────────────────────────────────
// Legend helpers
// ────────────────────────────────────────────────────────────────

// Build a swatch descriptor from a symbol layer element + geometry type
function buildSwatch(cls, props, geometryType) {
    if (cls === "SimpleLine") {
        const w = parseFloat(props["line_width"] || 1);
        let dash = null;
        if (props["use_custom_dash"] === "1" && props["customdash"]) {
            dash = props["customdash"].split(";").map(v => (Number(v) * 1.5).toFixed(1)).join(",");
        } else if (props["line_style"] === "dot") {
            dash = `${(w*1.5).toFixed(1)},${(w*3).toFixed(1)}`;
        } else if (props["line_style"] === "dash") {
            dash = `${(w*6).toFixed(1)},${(w*3).toFixed(1)}`;
        } else if (props["line_style"] === "dash dot") {
            dash = `${(w*6).toFixed(1)},${(w*3).toFixed(1)},${(w*1.5).toFixed(1)},${(w*3).toFixed(1)}`;
        }
        if (geometryType === "Polygon") {
            // SimpleLine inside polygon = outline-only swatch
            return { type: "polygon", fillColor: "none",
                     outlineColor: parseQGISColor(props["line_color"] || "0,0,0,255"), outlineStyle: "solid" };
        }
        return { type: "line", color: parseQGISColor(props["line_color"] || "0,0,0,255"),
                 width: w, dash };
    }
    if (cls === "SimpleFill") {
        return { type: "polygon",
                 fillColor:    parseQGISColor(props["color"]         || "255,255,255,255"),
                 outlineColor: parseQGISColor(props["outline_color"] || "0,0,0,255"),
                 outlineStyle: props["outline_style"] || "solid" };
    }
    if (cls === "SimpleMarker" || cls === "SvgMarker") {
        return { type: "point",
                 shape:        cls === "SimpleMarker" ? (props["name"] || "circle") : "circle",
                 color:        parseQGISColor(props["color"]         || "200,100,100,255"),
                 outlineColor: parseQGISColor(props["outline_color"] || "0,0,0,255"),
                 size:         parseFloat(props["size"] || 2) };
    }
    return null;
}

// Build the full legend item list for one layer
function buildLegendItems(renderer, symbolsEl, rendererType, geometryType) {
    const items = [];

    function swatchForSymbol(symName) {
        const symEl = [...symbolsEl.children].find(s => s.getAttribute("name") === symName);
        if (!symEl) return null;
        const lyrEl = symEl.getElementsByTagName("layer")[0];
        if (!lyrEl) return null;
        const props = {};
        [...lyrEl.getElementsByTagName("Option")].forEach(o => {
            if (o.getAttribute("name") && o.getAttribute("value"))
                props[o.getAttribute("name")] = o.getAttribute("value");
        });
        return buildSwatch(lyrEl.getAttribute("class"), props, geometryType);
    }

    if (rendererType === "categorizedSymbol") {
        [...renderer.getElementsByTagName("category")].forEach(cat => {
            const symName = cat.getAttribute("symbol");
            const label   = cat.getAttribute("label") || cat.getAttribute("value") || "";
            const swatch  = swatchForSymbol(symName);
            if (swatch) items.push({ label, swatch, _symName: symName });
        });
    } else if (rendererType === "graduatedSymbol") {
        [...renderer.getElementsByTagName("range")].forEach(range => {
            const symName = range.getAttribute("symbol");
            const label   = range.getAttribute("label") || "";
            const swatch  = swatchForSymbol(symName);
            if (swatch) items.push({ label, swatch, _symName: symName });
        });
    } else { // singleSymbol
        const swatch = swatchForSymbol("0");
        if (swatch) items.push({ label: "", swatch, _symName: "0" });
    }

    return items;
}

// Generate inline SVG for a legend swatch
function buildSwatchSvg(swatch) {
    if (!swatch) return "";

    if (swatch.type === "line") {
        const sw  = Math.max(1, Math.min(swatch.width * 1.5, 5)).toFixed(1);
        const da  = swatch.dash ? `stroke-dasharray="${swatch.dash}"` : "";
        return `<svg width="30" height="14" style="flex-shrink:0">
            <line x1="2" y1="7" x2="28" y2="7"
                stroke="${swatch.color}" stroke-width="${sw}"
                stroke-linecap="round" ${da}/>
        </svg>`;
    }
    if (swatch.type === "polygon") {
        const fill   = swatch.fillColor || "none";
        const noLine = swatch.outlineStyle === "no";
        const stroke = noLine ? 'stroke="none"' : `stroke="${swatch.outlineColor}" stroke-width="1.5"`;
        return `<svg width="20" height="14" style="flex-shrink:0">
            <rect x="1" y="1" width="18" height="12" fill="${fill}" ${stroke}/>
        </svg>`;
    }
    if (swatch.type === "point") {
        if (swatch.canvasUrl) {
            // Real rendered symbol extracted from OL style cache
            return `<img src="${swatch.canvasUrl}"
                style="flex-shrink:0;width:16px;height:16px;object-fit:contain;vertical-align:middle;"
                alt="">`;
        }
        // Fallback: approximation circle (used if OL image not yet available)
        return `<svg width="16" height="16" style="flex-shrink:0">
            <circle cx="8" cy="8" r="5"
                fill="${swatch.color}" stroke="${swatch.outlineColor}" stroke-width="1"/>
        </svg>`;
    }
    return "";
}

// Render the legend panel (called after any layer change)
function renderLegend() {
    const body = document.getElementById("legend-body");
    if (!body) return;

    const visible = layers.filter(l => l.olLayer.getVisible() && l.legendItems?.length > 0);

    if (visible.length === 0) {
        body.innerHTML = `<div style="padding:6px 14px 10px;font-size:11px;color:#6c7086;font-style:italic">No visible layers</div>`;
        return;
    }

    body.innerHTML = visible.map(item => {
        const rows = item.legendItems.map(li => `
            <div class="legend-row">
                <div class="legend-swatch">${buildSwatchSvg(li.swatch)}</div>
                <span class="legend-label" title="${li.label}">${li.label || item.name}</span>
            </div>`).join("");
        return `<div class="legend-group">
            <div class="legend-group-name" title="${item.name}">${item.name}</div>
            ${rows}
        </div>`;
    }).join("");
}

function toggleLegend() {
    document.getElementById("legend-header").classList.toggle("collapsed");
    document.getElementById("legend-body").classList.toggle("hidden");
}

// ────────────────────────────────────────────────────────────────
// QLR Parser
// ────────────────────────────────────────────────────────────────
async function parseQLR(text) {
    text = text.replace(/<!DOCTYPE[^>]*>/g, "");
    const xml = new DOMParser().parseFromString(text, "text/xml");
    const parseErr = xml.querySelector("parsererror");
    if (parseErr) throw new Error("XML parse error: " + parseErr.textContent);

    const maplayer     = xml.getElementsByTagName("maplayer")[0];
    const geometryType = maplayer?.getAttribute("geometry") || "Point";
    const layerName    = xml.getElementsByTagName("layername")[0]?.textContent || "Layer";
    const layerOpacity = parseFloat(xml.getElementsByTagName("layerOpacity")[0]?.textContent ?? 1);
    const abstract     = xml.getElementsByTagName("abstract")[0]?.textContent?.trim() || "";
    // Strip GDAL virtual filesystem prefix QGIS adds for HTTP(S) sources
    // e.g. "/vsicurl/https://example.com/file.geojson|layername=..." → "https://..."
    const rawDatasource = xml.getElementsByTagName("datasource")[0]?.textContent?.trim() || "";
    const datasource    = rawDatasource
        .replace(/^\/vsicurl\//i, "")          // strip /vsicurl/ prefix
        .replace(/\|layername=[^|]*$/i, "")    // strip |layername=... suffix
        .trim();
    const mapTipEl    = xml.getElementsByTagName("mapTip")[0];
    const mapTipHtml  = mapTipEl?.textContent?.trim() || "";
    // Extract display field from previewExpression (strips surrounding quotes)
    const previewRaw  = xml.getElementsByTagName("previewExpression")[0]?.textContent || "";
    const previewField = (previewRaw.match(/"([^"]+)"/) || [])[1] || "";

    // ── Label config ──
    const labelingEl   = xml.getElementsByTagName("labeling")[0];
    const labelingType = labelingEl?.getAttribute("type");
    const hasLabeling  = labelingType === "simple";
    // labelsEnabled: check attribute OR assume true when type=simple
    const labelsEnabled = hasLabeling &&
        (labelingEl.getAttribute("labelsEnabled") !== "0");

    let labelConfig = null;
    if (hasLabeling) {
        const ts = labelingEl.getElementsByTagName("text-style")[0];
        const tb = labelingEl.getElementsByTagName("text-buffer")[0];
        if (ts) {
            labelConfig = {
                fieldName:    ts.getAttribute("fieldName")  || "",
                fontSize:     parseFloat(ts.getAttribute("fontSize")  || 10),
                fontSizeUnit: ts.getAttribute("fontSizeUnit") || "Point",
                fontFamily:   ts.getAttribute("fontFamily") || "sans-serif",
                fontBold:     ts.getAttribute("fontBold")   === "1",
                fontItalic:   ts.getAttribute("fontItalic") === "1",
                textColor:    ts.getAttribute("textColor")  || "0,0,0,255",
                bufferDraw:   tb?.getAttribute("bufferDraw") === "1",
                bufferSize:   parseFloat(tb?.getAttribute("bufferSize") || 1) * MM_TO_PX,
                bufferColor:  tb?.getAttribute("bufferColor") || "255,255,255,255",
                geometryType  // stored so makeLabelStyle can choose placement
            };
        }
    }

    // Mutable state object — style function holds reference, checkbox mutates it
    const labelState = { visible: false }; // off by default; user enables via checkbox

    // ── Renderer-level glow (polygon layers store it here, not in symbol layers) ──
    const rendererEffectStack = [...xml.getElementsByTagName("renderer-v2")]
        .flatMap(r => [...r.children])
        .find(c => c.tagName === "effect" && c.getAttribute("type") === "effectStack");
    const rendererGlow = parseGlowFromEffectStack(rendererEffectStack);
    const rendererGlowStyles = makeGlowStyles(rendererGlow);

    const renderer     = xml.getElementsByTagName("renderer-v2")[0];
    const rendererType = renderer.getAttribute("type");
    const attribute    = renderer.getAttribute("attr") || "";
    const symbolsEl    = renderer.getElementsByTagName("symbols")[0];
    const styleCache   = {};

    await Promise.all([...symbolsEl.children].map(async sym => {
        if (sym.tagName !== "symbol") return;
        const symName = sym.getAttribute("name");
        const layerEl = sym.getElementsByTagName("layer")[0];
        if (!layerEl) return;
        const props = {};
        [...layerEl.getElementsByTagName("Option")].forEach(o => {
            if (o.getAttribute("name") && o.getAttribute("value"))
                props[o.getAttribute("name")] = o.getAttribute("value");
        });

        if (geometryType === "Point") {
            // Collect direct <layer> children using getElementsByTagName + parent check.
            // QGIS XML stores symbol layers in top-to-bottom rendering order:
            // layer[0] = topmost (rendered last/on top by QGIS)
            // layer[n-1] = bottommost (rendered first/background by QGIS)
            // OL renders style arrays index-0-first, so we REVERSE to match QGIS.
            // XML order: layer[0] = bottom, layer[last] = top — same as OL.
            // OL renders styles in array order, last element drawn on top.
            // No reversal needed.
            const symLayerEls = [...sym.getElementsByTagName("layer")]
                .filter(lyr => lyr.parentNode === sym);
            const pointStyles = await Promise.all(
                symLayerEls.map(async lyr => {
                    const lp = {};
                    [...lyr.getElementsByTagName("Option")].forEach(o => {
                        if (o.getAttribute("name") && o.getAttribute("value"))
                            lp[o.getAttribute("name")] = o.getAttribute("value");
                    });
                    const img = await buildPointImage(lyr.getAttribute("class"), lp);
                    return img ? new ol.style.Style({ image: img }) : null;
                })
            );
            const filtered = pointStyles.filter(Boolean);
            styleCache[symName] = filtered;

        } else if (geometryType === "Line") {
            const parts = [];
            [...sym.getElementsByTagName("layer")].forEach(lyr => {
                if (lyr.parentElement.tagName !== "symbol") return;
                const lp = {};
                [...lyr.getElementsByTagName("Option")].forEach(o => {
                    if (o.getAttribute("name") && o.getAttribute("value")) lp[o.getAttribute("name")] = o.getAttribute("value");
                });
                // Symbol-layer level glow (e.g. bike lanes)
                let glow = null;
                const esEl = [...lyr.children].find(c => c.tagName === "effect" && c.getAttribute("type") === "effectStack");
                glow = parseGlowFromEffectStack(esEl);
                parts.push({ color:lp["line_color"], width:parseFloat(lp["line_width"]||1),
                    style:lp["line_style"]||"solid", customdash:lp["customdash"]||"",
                    use_custom_dash:lp["use_custom_dash"]||"0", glow });
            });
            styleCache[symName] = makeLineStyle(parts);

        } else if (geometryType === "Polygon") {
            const polyStyles = [];
            [...sym.getElementsByTagName("layer")].forEach(lyr => {
                if (lyr.parentElement.tagName !== "symbol") return;
                const cls = lyr.getAttribute("class");
                const p   = {};
                [...lyr.getElementsByTagName("Option")].forEach(o => {
                    if (o.getAttribute("name") && o.getAttribute("value"))
                        p[o.getAttribute("name")] = o.getAttribute("value");
                });
                if (cls === "SimpleFill") {
                    polyStyles.push(makePolygonStyle({
                        fillColor:    p["color"]         || "255,255,255,255",
                        outlineColor: p["outline_color"] || "0,0,0,255",
                        outlineWidth: parseFloat(p["outline_width"] || 0.26),
                        outlineStyle: p["outline_style"] || "solid"
                    }));
                } else if (cls === "SimpleLine") {
                    polyStyles.push(new ol.style.Style({
                        stroke: new ol.style.Stroke({
                            color: parseQGISColor(p["line_color"] || "0,0,0,255"),
                            width: parseFloat(p["line_width"] || 0.26) * MM_TO_PX
                        })
                    }));
                } else {
                    console.warn(`[QGIS Layer Viewer] Unhandled polygon layer class: "${cls}"`);
                }
            });
            styleCache[symName] = polyStyles.length === 1 ? polyStyles[0] : polyStyles;
        }
    }));

    // ── Base style function (without labels) ──
    const normalize = s => (s||"").trim().toLowerCase();
    let baseStyleFn;

    if (rendererType === "categorizedSymbol") {
        const categoryMap = {};
        [...renderer.getElementsByTagName("category")].forEach(cat => {
            const val = normalize(cat.getAttribute("value"));
            if (val) categoryMap[val] = cat.getAttribute("symbol");
        });
        const fallback = styleCache[Object.keys(styleCache).at(-1)];
        baseStyleFn = feature => styleCache[categoryMap[normalize(feature.get(attribute))]] || fallback;
    } else if (rendererType === "graduatedSymbol") {
        const ranges = [...renderer.getElementsByTagName("range")].map(r => ({
            lower:parseFloat(r.getAttribute("lower")), upper:parseFloat(r.getAttribute("upper")),
            symbol:r.getAttribute("symbol")
        }));
        baseStyleFn = feature => {
            const v = parseFloat(feature.get(attribute));
            const r = ranges.find(r => v >= r.lower && v <= r.upper);
            return r ? styleCache[r.symbol] : new ol.style.Style();
        };
    } else {
        const single = styleCache["0"];
        baseStyleFn = () => single;
    }

    // ── Final style function: glow + base + optional labels ──
    const styleFunction = feature => {
        const base = [baseStyleFn(feature)].flat().filter(Boolean);
        const all  = [...rendererGlowStyles, ...base];
        if (labelState.visible && labelConfig) {
            const ls = makeLabelStyle(feature, labelConfig);
            if (ls) all.push(ls);
        }
        return all;
    };

    // Build legend items (sync, uses already-parsed XML elements)
    const legendItems = buildLegendItems(renderer, symbolsEl, rendererType, geometryType);

    // For point layers: extract the actual rendered OL canvas/image from the styleCache
    // so the legend shows the real symbol instead of an approximation circle.
    // Falls back silently to the circle swatch if extraction fails.
    if (geometryType === "Point") {
        // Show the topmost layer (styles[0] after .reverse() = primary visible symbol).
        //
        // Two reliable synchronous paths — no waiting for async image loading:
        //   ol.style.Icon  → getSrc() returns the data URI immediately
        //   ol.style.Circle / RegularShape → getImage(1) returns a canvas immediately
        //
        // Avoid getImage(1) for Icons: it returns null until OL finishes its
        // internal async load, which may not have happened at legend-build time.
        legendItems.forEach(item => {
            try {
                const styles = styleCache[item._symName];
                if (!styles?.length) return;

                // styles[last] = topmost rendered layer (OL draws last = on top)
                const imgStyle = styles[styles.length - 1].getImage();
                if (!imgStyle) return;

                // ol.style.Icon: getSrc() is always synchronous — no load needed
                if (typeof imgStyle.getSrc === "function") {
                    const src = imgStyle.getSrc();
                    if (src) { item.swatch.canvasUrl = src; return; }
                }

                // ol.style.Circle / RegularShape: canvas rendered synchronously
                imgStyle.load();
                const canvas = imgStyle.getImage(1);
                if (canvas instanceof HTMLCanvasElement) {
                    item.swatch.canvasUrl = canvas.toDataURL();
                }
            } catch(e) { /* keep colored circle fallback */ }
            delete item._symName;
        });
    } else {
        legendItems.forEach(item => delete item._symName); // clean up
    }

    return { layerName, layerOpacity, geometryType, styleFunction,
             abstract, datasource, hasLabeling, labelsEnabled,
             labelConfig, labelState, mapTipHtml, previewField, legendItems };
}

// ────────────────────────────────────────────────────────────────
// App state
// ────────────────────────────────────────────────────────────────
const layers  = [];
const pending = new Map();
let layerIdCounter = 0;
let dropMode = "pair";
let map, combinedExtent;

// ────────────────────────────────────────────────────────────────
// Map Tips
// ────────────────────────────────────────────────────────────────
function buildTipContent(feature, item) {
    if (!item.tipsEnabled) return null;
    const props = feature.getProperties();

    // Priority 1: mapTip HTML template with [% "field" %] substitution
    if (item.mapTipHtml) {
        const html = item.mapTipHtml.replace(/\[%\s*"([^"]+)"\s*%\]/g, (_, field) =>
            props[field] ?? ""
        );
        return `<div class="tip-layer">${item.name}</div>${html}`;
    }

    // Priority 2: previewField single value
    if (item.previewField) {
        const val = props[item.previewField];
        if (val !== null && val !== undefined && val !== "") {
            return `<div class="tip-layer">${item.name}</div>
                    <div class="tip-value">${val}</div>`;
        }
    }

    // Priority 3: first 5 non-null non-geometry properties
    const entries = Object.entries(props)
        .filter(([k, v]) => k !== "geometry" && v !== null && v !== undefined && v !== "")
        .slice(0, 5);
    if (entries.length === 0) return null;

    const rows = entries.map(([k, v]) =>
        `<div class="tip-row"><span class="tip-key">${k}:</span> <span class="tip-val">${v}</span></div>`
    ).join("");
    return `<div class="tip-layer">${item.name}</div><hr class="tip-divider">${rows}`;
}

function showTip(tip, content, cx, cy) {
    tip.innerHTML = content;
    tip.style.display = "block";
    tip.style.left = "-9999px"; // measure off-screen first
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let tx = cx + 14, ty = cy - 10;
    if (tx + tw > window.innerWidth  - 8) tx = cx - tw - 14;
    if (ty + th > window.innerHeight - 8) ty = cy - th - 10;
    if (ty < 8) ty = cy + 14;
    tip.style.left = tx + "px";
    tip.style.top  = ty + "px";
}

function initMapTips() {
    const tip = document.getElementById("map-tip");

    map.on("pointermove", e => {
        if (e.dragging) { tip.style.display = "none"; return; }

        const cx = e.originalEvent.clientX;
        const cy = e.originalEvent.clientY;
        let found = false;

        // Iterate layers top-to-bottom (layers[last] = top of map)
        for (let i = layers.length - 1; i >= 0; i--) {
            const item = layers[i];
            if (!item.olLayer.getVisible()) continue;

            let hitFeature = null;

            if (item.geometryType === "Polygon") {
                // Geometry-based: works for transparent/no-fill polygons.
                // forEachFeatureAtPixel misses interior pixels when fill is transparent.
                const hits = item.olLayer.getSource().getFeaturesAtCoordinate(e.coordinate);
                if (hits.length > 0) hitFeature = hits[0];
            } else {
                // Pixel-based: needed for lines and points (geometry check too strict)
                map.forEachFeatureAtPixel(e.pixel, (feature, olLayer) => {
                    if (!hitFeature && olLayer === item.olLayer) hitFeature = feature;
                }, { hitTolerance: 4, layerFilter: l => l === item.olLayer });
            }

            if (!hitFeature) continue;
            const content = buildTipContent(hitFeature, item);
            if (!content) continue;

            showTip(tip, content, cx, cy);
            found = true;
            break;
        }

        if (!found) tip.style.display = "none";
        map.getTargetElement().style.cursor = found ? "pointer" : "";
    });

    map.getViewport().addEventListener("mouseleave", () => {
        tip.style.display = "none";
        map.getTargetElement().style.cursor = "";
    });
}

// ────────────────────────────────────────────────────────────────
// Basemap switcher
// ────────────────────────────────────────────────────────────────
const BASEMAPS = [
    {
        id: "osm",
        label: "OSM",
        preview: "https://tile.openstreetmap.org/2/1/1.png",
        createSource: () => new ol.source.OSM()
    },
    {
        id: "esri-topo",
        label: "Esri Topo",
        preview: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/2/1/1",
        createSource: () => new ol.source.XYZ({
            attributions: "Tiles &copy; Esri, HERE, Garmin, FAO, NOAA, USGS",
            url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}"
        })
    },
    {
        id: "esri-streets",
        label: "Esri Streets",
        preview: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/2/1/1",
        createSource: () => new ol.source.XYZ({
            attributions: "Tiles &copy; Esri, HERE, Garmin, USGS",
            url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}"
        })
    },
    {
        id: "esri-imagery",
        label: "Esri Imagery",
        preview: "https://server.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/tile/2/1/1",
        createSource: () => new ol.source.XYZ({
            attributions: "Tiles &copy; Esri, Earthstar Geographics",
            url: "https://server.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
        }),
        showRef: true   // enable the reference label overlay
    },
    {
        id: "natgeo",
        label: "NatGeo",
        preview: "https://server.arcgisonline.com/arcgis/rest/services/NatGeo_World_Map/MapServer/tile/2/1/1",
        createSource: () => new ol.source.XYZ({
            attributions: "Tiles &copy; Esri, National Geographic",
            url: "https://server.arcgisonline.com/arcgis/rest/services/NatGeo_World_Map/MapServer/tile/{z}/{y}/{x}"
        })
    },
    {
        id: "carto-voyager",
        label: "Carto Voyager",
        preview: "https://cartodb-basemaps-a.global.ssl.fastly.net/rastertiles/voyager/2/1/1.png",
        createSource: () => new ol.source.XYZ({
            attributions: "&copy; OpenStreetMap contributors &copy; CARTO",
            url: "https://cartodb-basemaps-a.global.ssl.fastly.net/rastertiles/voyager/{z}/{x}/{y}.png"
        })
    }
];

// Reference/labels overlay shown on top of Esri Imagery
const ESRI_REF_URL =
    "https://server.arcgisonline.com/arcgis/rest/services/Reference/" +
    "World_Boundaries_and_Places_Alternate/MapServer/tile/{z}/{y}/{x}";

let basemapTileLayer = null;   // the single base tile layer
let refTileLayer     = null;   // reference overlay (labels on imagery)
let currentBasemapId = "osm";

function initBasemapControl() {
    const grid = document.getElementById("basemap-grid");
    BASEMAPS.forEach(bm => {
        const item = document.createElement("div");
        item.className = "basemap-item" + (bm.id === currentBasemapId ? " active" : "");
        item.dataset.id = bm.id;
        item.title = bm.label;
        item.innerHTML = `<img src="${bm.preview}" alt="${bm.label}" loading="lazy">
                          <div class="basemap-item-label">${bm.label}</div>`;
        item.addEventListener("click", () => switchBasemap(bm.id));
        grid.appendChild(item);
    });

    // Close panel when clicking outside
    document.addEventListener("click", e => {
        const ctrl = document.getElementById("basemap-control");
        if (ctrl && !ctrl.contains(e.target)) toggleBasemapPanel(false);
    });
}

function toggleBasemapPanel(forceState) {
    const panel = document.getElementById("basemap-panel");
    const btn   = document.getElementById("basemap-btn");
    const open  = forceState !== undefined ? forceState : panel.classList.contains("hidden");
    panel.classList.toggle("hidden", !open);
    btn.classList.toggle("open", open);
}

function switchBasemap(id) {
    const bm = BASEMAPS.find(b => b.id === id);
    if (!bm || !basemapTileLayer) return;
    basemapTileLayer.setSource(bm.createSource());
    if (refTileLayer) refTileLayer.setVisible(bm.showRef === true);
    currentBasemapId = id;
    document.querySelectorAll(".basemap-item").forEach(el => {
        el.classList.toggle("active", el.dataset.id === id);
    });
    toggleBasemapPanel(false);
}

// ────────────────────────────────────────────────────────────────
// Map + layer management
// ────────────────────────────────────────────────────────────────
function initMap() {
    basemapTileLayer = new ol.layer.Tile({ source: new ol.source.OSM(), zIndex: 0 });
    refTileLayer     = new ol.layer.Tile({
        source: new ol.source.XYZ({ url: ESRI_REF_URL }),
        visible: false, zIndex: 1
    });
    map = new ol.Map({
        target: "map",
        layers: [basemapTileLayer, refTileLayer],
        view: new ol.View({ center: ol.proj.fromLonLat([0, 20]), zoom: 2 })
    });
}

function rebuildLayerOrder() {
    // Exclude highlight layer — it lives outside the data layers array
    map.getLayers().getArray()
        .filter(l => l instanceof ol.layer.Vector && l !== highlightLayer)
        .forEach(l => map.removeLayer(l));
    [...layers].reverse().forEach(({ olLayer }) => map.addLayer(olLayer));
    // Re-add highlight if it was swept up, keeping it on top
    if (highlightLayer && !map.getLayers().getArray().includes(highlightLayer)) {
        map.addLayer(highlightLayer);
    }
}

function getInsertIndex(geometryType) {
    if (geometryType === "Point") return 0;
    if (geometryType === "Line") {
        let i = 0;
        while (i < layers.length && layers[i].geometryType === "Point") i++;
        return i;
    }
    return layers.length;
}

function updateExtent(source) {
    const ext = source.getExtent();
    if (!ext || ol.extent.isEmpty(ext)) return;
    if (!combinedExtent || ol.extent.isEmpty(combinedExtent)) {
        combinedExtent = ext.slice();
    } else {
        ol.extent.extend(combinedExtent, ext);
    }
    map.getView().fit(combinedExtent, { padding:[40,40,40,320], duration:500 });
}

async function addLayer(geojsonText, qlrData, qlrText = "", silent = false) {
    const { layerName, layerOpacity, geometryType, styleFunction,
            abstract, hasLabeling, labelsEnabled, labelConfig, labelState,
            mapTipHtml, previewField, legendItems } = qlrData;
    const features = new ol.format.GeoJSON().readFeatures(geojsonText, { featureProjection:"EPSG:3857" });
    const source   = new ol.source.Vector({ features });
    const olLayer  = new ol.layer.Vector({ opacity:layerOpacity, source, style:styleFunction });
    const id       = ++layerIdCounter;

    layers.splice(getInsertIndex(geometryType), 0, {
        id, name:layerName, geometryType, olLayer,
        abstract, hasLabeling, labelConfig, labelState,
        mapTipHtml, previewField,
        currentOpacity: Math.round(layerOpacity * 100),
        currentLabels:  false,
        tipsEnabled:    false,
        legendItems,
        _qlrText:     qlrText,
        _geojsonText: geojsonText
    });

    rebuildLayerOrder();
    updateExtent(source);
    if (!silent) { renderLayerPanel(); renderLegend(); }
}

function removeLayer(id) {
    if (!confirm(`Remove layer "${layers.find(l=>l.id===id)?.name}"?\nThis cannot be undone.`)) return;
    const idx = layers.findIndex(l => l.id === id);
    if (idx === -1) return;
    map.removeLayer(layers[idx].olLayer);
    layers.splice(idx, 1);
    combinedExtent = ol.extent.createEmpty();
    layers.forEach(({ olLayer }) => {
        const ext = olLayer.getSource().getExtent();
        if (ext && !ol.extent.isEmpty(ext)) ol.extent.extend(combinedExtent, ext);
    });
    renderLayerPanel();
    renderLegend();
}

function toggleVisibility(id) {
    const item = layers.find(l => l.id === id);
    if (item) item.olLayer.setVisible(!item.olLayer.getVisible());
    renderLayerPanel();
    renderLegend();
}

function toggleExpand(id) {
    const el = document.querySelector(`.layer-item[data-id="${id}"]`);
    if (el) el.classList.toggle("expanded");
}

function setOpacity(id, value) {
    const item = layers.find(l => l.id === id);
    if (!item) return;
    item.currentOpacity = parseInt(value);
    item.olLayer.setOpacity(value / 100);
    const span = document.querySelector(`[data-id="${id}"] .opacity-val`);
    if (span) span.textContent = value + "%";
}

function setLabels(id, enabled) {
    const item = layers.find(l => l.id === id);
    if (!item?.labelState) return;
    item.currentLabels      = enabled;
    item.labelState.visible = enabled;
    item.olLayer.changed();
}

function setTips(id, enabled) {
    const item = layers.find(l => l.id === id);
    if (item) item.tipsEnabled = enabled;
}

// ────────────────────────────────────────────────────────────────
// Drag-to-reorder
// ────────────────────────────────────────────────────────────────
let draggedId = null;

function onDragStart(e, id) {
    draggedId = id;
    e.dataTransfer.effectAllowed = "move";
    setTimeout(() => {
        const el = document.querySelector(`.layer-item[data-id="${id}"]`);
        if (el) el.classList.add("dragging");
    }, 0);
}
function onDragOver(e, id) {
    e.preventDefault();
    if (id === draggedId) return;
    document.querySelectorAll(".layer-item").forEach(el => el.classList.remove("drag-over"));
    const el = document.querySelector(`.layer-item[data-id="${id}"]`);
    if (el) el.classList.add("drag-over");
}
function onDragLeave() {
    document.querySelectorAll(".layer-item").forEach(el => el.classList.remove("drag-over"));
}
function onDrop(e, targetId) {
    e.preventDefault();
    document.querySelectorAll(".layer-item").forEach(el => el.classList.remove("drag-over","dragging"));
    if (!draggedId || draggedId === targetId) { draggedId = null; return; }
    const fromIdx = layers.findIndex(l => l.id === draggedId);
    const toIdx   = layers.findIndex(l => l.id === targetId);
    if (fromIdx !== -1 && toIdx !== -1) {
        const [moved] = layers.splice(fromIdx, 1);
        layers.splice(toIdx, 0, moved);
        rebuildLayerOrder();
        renderLayerPanel();
    }
    draggedId = null;
}
function onDragEnd() {
    document.querySelectorAll(".layer-item").forEach(el => el.classList.remove("drag-over","dragging"));
    draggedId = null;
}

// Show a temporary status message in the drop zone hint
function setDropStatus(msg) {
    const hint = document.getElementById("drop-hint");
    if (!hint) return;
    if (msg) {
        hint.textContent = msg;
        hint.style.color = "#cba6f7";
    } else {
        // Restore default text based on current mode
        hint.style.color = "";
        setMode(dropMode); // resets the hint text
    }
}

// ────────────────────────────────────────────────────────────────
// Mode selector
// ────────────────────────────────────────────────────────────────
function setMode(mode) {
    dropMode = mode;
    document.getElementById("btn-pair").classList.toggle("active", mode==="pair");
    document.getElementById("btn-url").classList.toggle("active",  mode==="url");
    document.getElementById("drop-label").innerHTML = mode==="pair"
        ? `Drop a <strong>.geojson</strong> or <strong>.qlr</strong>`
        : `Drop a <strong>.qlr</strong> with a web data URL`;
    document.getElementById("drop-hint").textContent = mode==="pair"
        ? "Files are matched by name"
        : "The QLR's datasource must be a https:// URL";
}

// ────────────────────────────────────────────────────────────────
// File handling
// ────────────────────────────────────────────────────────────────
function getStem(fn) { return fn.replace(/\.(geojson|qlr|qview)$/i, ""); }
function getExt(fn)  { return (/\.(geojson|qlr|qview)$/i.exec(fn)||[])[1]?.toLowerCase(); }

function cancelPending(stem) { pending.delete(stem); renderPending(); }

async function handleFile(file) {
    const ext  = getExt(file.name);
    const stem = getStem(file.name);
    if (!ext) { alert(`Unrecognized file: ${file.name}\nPlease use .geojson, .qlr, or .qview`); return; }

    // ── .qview import ──
    if (ext === "qview") {
        try {
            const data = JSON.parse(await file.text());
            if (!data.version || !Array.isArray(data.layers)) {
                alert("Invalid .qview file."); return;
            }
            const importedItems = [];
            for (const ld of data.layers) {
                const qlrData = await parseQLR(ld.qlr);
                const beforeIds = new Set(layers.map(l => l.id));
                await addLayer(ld.geojson, qlrData, ld.qlr, true); // silent
                const newItem = layers.find(l => !beforeIds.has(l.id));
                if (!newItem) continue;
                // Restore all saved state
                newItem.name            = ld.name;
                newItem.currentOpacity  = ld.opacity ?? 100;
                newItem.currentLabels   = ld.labelsEnabled ?? false;
                newItem.tipsEnabled     = ld.tipsEnabled   ?? false;
                newItem.olLayer.setOpacity(newItem.currentOpacity / 100);
                newItem.olLayer.setVisible(ld.visible ?? true);
                newItem.labelState.visible = newItem.currentLabels;
                if (newItem.labelConfig && ld.labelFontSize != null) {
                    newItem.labelConfig.fontSize     = ld.labelFontSize;
                    newItem.labelConfig.fontSizeUnit = ld.labelFontSizeUnit || "Pixel";
                }
                if (newItem.currentLabels) newItem.olLayer.changed();
                importedItems.push(newItem);
            }
            // Restore saved stack order (may differ from default insert order)
            layers.sort((a, b) => {
                const ia = importedItems.indexOf(a);
                const ib = importedItems.indexOf(b);
                if (ia === -1 && ib === -1) return 0;
                if (ia === -1) return 1;
                if (ib === -1) return -1;
                return ia - ib;
            });
            // Recompute combined extent
            combinedExtent = ol.extent.createEmpty();
            layers.forEach(({ olLayer }) => {
                const ext = olLayer.getSource().getExtent();
                if (ext && !ol.extent.isEmpty(ext)) ol.extent.extend(combinedExtent, ext);
            });
            if (!ol.extent.isEmpty(combinedExtent))
                map.getView().fit(combinedExtent, { padding:[40,40,40,320], duration:500 });
            rebuildLayerOrder();
            renderLayerPanel();
            renderLegend();
        } catch (err) {
            console.error(err);
            alert(`Error importing .qview:\n${err.message}`);
        }
        return;
    }

    if (dropMode === "url") {
        if (ext !== "qlr") { alert("In QLR + web URL mode only .qlr files are accepted."); return; }
        try {
            const qlrText   = await file.text();
            const qlrData   = await parseQLR(qlrText);
            const { datasource } = qlrData;
            const urlMatch  = datasource.match(/url='([^']+)'/);
            const rawUrl    = urlMatch ? urlMatch[1] : datasource;
            if (!rawUrl.startsWith("http://") && !rawUrl.startsWith("https://")) {
                alert(`The datasource in this QLR is a local path:\n"${datasource}"\n\nOnly https:// URLs are supported in web URL mode.\nSwitch to GeoJSON + QLR mode instead.`);
                return;
            }
            const sqlMatch  = datasource.match(/\bsql=(.+)$/s);
            const sqlFilter = sqlMatch ? sqlMatch[1].trim() : "";
            let fetchUrl = rawUrl;
            if (/\/FeatureServer\/\d+\/?$/.test(rawUrl)) {
                const base  = rawUrl.replace(/\/$/, "");
                const where = sqlFilter ? encodeURIComponent(sqlFilter) : "1%3D1";
                fetchUrl    = `${base}/query?where=${where}&outFields=*&f=geojson`;
            }
            // Use paginated fetch for ArcGIS FeatureServer; single fetch otherwise
            let geojsonText;
            if (/\/FeatureServer\/\d+\/query/.test(fetchUrl)) {
                const base  = fetchUrl.split("/query")[0];
                const where = new URL(fetchUrl).searchParams.get("where") || "1=1";
                setDropStatus(`Fetching features…`);
                geojsonText = await fetchArcGISPaged(base, encodeURIComponent(where),
                    (count, more) => setDropStatus(
                        `Fetching… ${count.toLocaleString()} features${more ? " (more pages…)" : ""}`
                    )
                );
                setDropStatus(null);
            } else {
                const resp = await fetch(fetchUrl);
                if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${fetchUrl}`);
                geojsonText = await resp.text();
            }
            await addLayer(geojsonText, qlrData, qlrText);
        } catch (err) { console.error(err); alert(`Error: ${err.message}`); }
        return;
    }

    if (!pending.has(stem)) pending.set(stem, { geojson:null, qlr:null });
    pending.get(stem)[ext] = file;
    renderPending();

    const pair = pending.get(stem);
    if (pair.geojson && pair.qlr) {
        pending.delete(stem);
        renderPending();
        try {
            const [geojsonText, qlrText] = await Promise.all([pair.geojson.text(), pair.qlr.text()]);
            await addLayer(geojsonText, await parseQLR(qlrText), qlrText);
        } catch (err) { console.error(err); alert(`Error loading "${stem}":\n${err.message}`); }
    }
}

// ────────────────────────────────────────────────────────────────
// UI rendering
// ────────────────────────────────────────────────────────────────
const eyeOn  = `<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
const eyeOff = `<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
const xIcon  = `<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

function renderPending() {
    const el = document.getElementById("pending-list");
    el.innerHTML = "";
    pending.forEach((pair, stem) => {
        const waiting = pair.geojson ? "waiting for .qlr" : "waiting for .geojson";
        el.innerHTML += `
            <div class="pending-item">
                <span title="${stem} — ${waiting}">⏳ <strong>${stem}</strong> — ${waiting}</span>
                <button class="pending-cancel" title="Cancel" onclick="cancelPending('${stem}')">${xIcon}</button>
            </div>`;
    });
}

function renderLayerPanel() {
    const el = document.getElementById("layer-list");
    const expanded = new Set(
        [...el.querySelectorAll(".layer-item.expanded")].map(e => parseInt(e.dataset.id))
    );
    el.innerHTML = "";

    layers.forEach(({ id, name, geometryType, olLayer, abstract,
                      hasLabeling, labelConfig, currentOpacity, currentLabels,
                      previewField, mapTipHtml, tipsEnabled }) => {
        const visible    = olLayer.getVisible();
        const isExpanded = expanded.has(id);
        const labelDisabled = !hasLabeling || !labelConfig?.fieldName;

        const div = document.createElement("div");
        div.className = `layer-item ${geometryType.toLowerCase()}${isExpanded?" expanded":""}`;
        div.dataset.id = id;
        div.draggable  = true;
        div.addEventListener("dragstart", e => onDragStart(e, id));
        div.addEventListener("dragover",  e => onDragOver(e, id));
        div.addEventListener("dragleave", onDragLeave);
        div.addEventListener("drop",      e => onDrop(e, id));
        div.addEventListener("dragend",   onDragEnd);

        div.innerHTML = `
            <div class="layer-header" onclick="toggleExpand(${id})">
                <span class="drag-handle" title="Drag to reorder">⠿</span>
                <span class="layer-type-badge">${geometryType}</span>
                <span class="layer-name" title="${name}">${name}</span>
                <span class="expand-chevron">▾</span>
                <button class="layer-btn" title="View attribute table"
                    onclick="event.stopPropagation();openTableModal(${id})"><svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/></svg></button>
                <button class="layer-btn" title="Edit layer name / font size"
                    onclick="event.stopPropagation();openEditModal(${id})"><svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
                <button class="layer-btn ${visible?"":"hidden-btn"}" title="Toggle visibility"
                    onclick="event.stopPropagation();toggleVisibility(${id})">${visible?eyeOn:eyeOff}</button>
                <button class="layer-btn" title="Remove layer"
                    onclick="event.stopPropagation();removeLayer(${id})">${xIcon}</button>
            </div>
            <div class="layer-details">
                <div class="layer-details-inner">
                    <label class="ctrl-row">
                        <span class="ctrl-label">Opacity</span>
                        <input type="range" min="0" max="100" value="${currentOpacity}"
                            oninput="setOpacity(${id},this.value)">
                        <span class="opacity-val">${currentOpacity}%</span>
                    </label>
                    <div style="display:flex;gap:12px">
                    <label class="ctrl-row${labelDisabled?" disabled":""}" style="flex:1;margin-bottom:0"
                        title="${labelDisabled?"No label configuration in QLR":"Toggle labels"}">
                        <span class="ctrl-label">Labels</span>
                        <input type="checkbox" ${currentLabels?"checked":""} ${labelDisabled?"disabled":""}
                            onchange="setLabels(${id},this.checked)">
                        ${labelDisabled?`<span style="font-size:10px;color:#45475a;font-style:italic">n/a</span>`:""}
                    </label>
                    <label class="ctrl-row${!(previewField||mapTipHtml)?" disabled":""}" style="flex:1;margin-bottom:0"
                        title="${!(previewField||mapTipHtml)?"No tip data in QLR":"Toggle map tips"}">
                        <span class="ctrl-label">Tips</span>
                        <input type="checkbox" ${tipsEnabled?"checked":""} ${!(previewField||mapTipHtml)?"disabled":""}
                            onchange="setTips(${id},this.checked)">
                        ${!(previewField||mapTipHtml)?`<span style="font-size:10px;color:#45475a;font-style:italic">n/a</span>`:""}
                    </label>
                    </div>
                    ${abstract?`<p class="layer-abstract">${abstract}</p>`:""}
                </div>
            </div>`;
        el.appendChild(div);
    });
}

// ────────────────────────────────────────────────────────────────
// Edit modal
// ────────────────────────────────────────────────────────────────
let editingLayerId = null;

function openEditModal(id) {
    editingLayerId = id;
    const item = layers.find(l => l.id === id);
    if (!item) return;

    document.getElementById("edit-name-input").value = item.name;

    const fsRow = document.getElementById("edit-fontsize-row");
    if (item.labelConfig?.fieldName) {
        const unit = item.labelConfig.fontSizeUnit || "Point";
        const pxVal = Math.round(fontSizeToPx(item.labelConfig.fontSize || 10, unit));
        document.getElementById("edit-fontsize-range").value = pxVal;
        document.getElementById("edit-fontsize-val").textContent = pxVal + "px";

        const unitLabel = document.getElementById("edit-fontsize-unit");
        const supported = SUPPORTED_FONT_UNITS.includes(unit.toLowerCase());
        if (supported) {
            unitLabel.textContent = `Label font size (${unit})`;
            unitLabel.style.color = "";
        } else {
            unitLabel.textContent = `Label font size — ⚠ "${unit}" not supported, using 10px`;
            unitLabel.style.color = "#f9e2af";
        }
        fsRow.style.display = "flex";
    } else {
        fsRow.style.display = "none";
    }

    document.getElementById("edit-modal-overlay").classList.remove("hidden");
    document.getElementById("edit-name-input").focus();
    document.getElementById("edit-name-input").select();
}

function closeEditModal() {
    editingLayerId = null;
    document.getElementById("edit-modal-overlay").classList.add("hidden");
}

function handleOverlayClick(e) {
    if (e.target === e.currentTarget) closeEditModal();
}

function acceptEdit() {
    const item = layers.find(l => l.id === editingLayerId);
    if (item) {
        const newName = document.getElementById("edit-name-input").value.trim();
        if (newName) item.name = newName;

        if (item.labelConfig?.fieldName) {
            const newSize = parseInt(document.getElementById("edit-fontsize-range").value);
            if (!isNaN(newSize)) {
                item.labelConfig.fontSize     = newSize;
                item.labelConfig.fontSizeUnit = "Pixel"; // edited value is always px
                if (item.labelState?.visible) item.olLayer.changed();
            }
        }

        renderLayerPanel();
        renderLegend();
    }
    closeEditModal();
}

// Close modal on Escape
document.addEventListener("keydown", e => {
    if (e.key === "Escape") { closeEditModal(); closeTableModal(); }
});

// ────────────────────────────────────────────────────────────────
// ArcGIS FeatureServer — OID-keyset paginated GeoJSON fetch
// More reliable than resultOffset: uses WHERE oidField > lastOID
// so pagination works regardless of server resultOffset support.
// ────────────────────────────────────────────────────────────────
async function fetchArcGISPaged(baseUrl, userWhere, onProgress) {
    // 1. Fetch layer metadata to get OID field name and max page size
    const infoResp = await fetch(`${baseUrl}?f=json`);
    if (!infoResp.ok) throw new Error(`HTTP ${infoResp.status} fetching layer info`);
    const info = await infoResp.json();
    if (info.error) throw new Error(`ArcGIS error ${info.error.code}: ${info.error.message}`);

    const oidField   = (info.fields || []).find(f => f.type === "esriFieldTypeOID")?.name || "OBJECTID";
    const pageSize   = info.maxRecordCount || 1000;
    const baseWhere  = decodeURIComponent(userWhere);   // the QLR SQL filter (or "1=1")

    let features = [];
    let lastOID  = -1;

    // 2. Page using WHERE oidField > lastOID (keyset pagination)
    while (true) {
        // Combine OID cursor with any existing layer filter
        const oidClause  = `${oidField} > ${lastOID}`;
        const whereClause = (baseWhere && baseWhere !== "1=1")
            ? `(${oidClause}) AND (${baseWhere})`
            : oidClause;

        const url = `${baseUrl}/query?` +
            `where=${encodeURIComponent(whereClause)}` +
            `&outFields=*` +
            `&orderByFields=${encodeURIComponent(`${oidField} ASC`)}` +
            `&resultRecordCount=${pageSize}` +
            `&f=geojson`;

        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status} at OID > ${lastOID}`);
        const data = await resp.json();
        if (data.error) throw new Error(`ArcGIS error ${data.error.code}: ${data.error.message}`);

        const page = data.features || [];
        if (page.length === 0) break;   // no more records

        features = features.concat(page);
        lastOID  = page[page.length - 1].properties[oidField];
        if (onProgress) onProgress(features.length, page.length === pageSize);
    }

    return JSON.stringify({ type: "FeatureCollection", features });
}

// ────────────────────────────────────────────────────────────────
// Feature highlight layer
// ────────────────────────────────────────────────────────────────
let highlightLayer   = null;
let highlightTimeout = null;

function initHighlightLayer() {
    // Double-stroke: white halo behind bright cyan — visible on any basemap
    const hlWhite = new ol.style.Style({
        stroke: new ol.style.Stroke({ color: "white", width: 10 }),
        image:  new ol.style.Circle({
            radius: 13,
            stroke: new ol.style.Stroke({ color: "white", width: 5 })
        })
    });
    const hlColor = new ol.style.Style({
        stroke: new ol.style.Stroke({ color: "#00d4ff", width: 5 }),
        fill:   new ol.style.Fill({ color: "rgba(0,212,255,.20)" }),
        image:  new ol.style.Circle({
            radius: 10,
            fill:   new ol.style.Fill({ color: "rgba(0,212,255,.45)" }),
            stroke: new ol.style.Stroke({ color: "#00d4ff", width: 3 })
        })
    });
    highlightLayer = new ol.layer.Vector({
        source: new ol.source.Vector(),
        style:  [hlWhite, hlColor],
        zIndex: 999
    });
    map.addLayer(highlightLayer);
}

function highlightFeature(feature) {
    clearTimeout(highlightTimeout);
    highlightLayer.getSource().clear();
    highlightLayer.getSource().addFeature(feature.clone());

    const geom = feature.getGeometry();
    if (geom) {
        const isPoint = ["Point","MultiPoint"].includes(geom.getType());
        map.getView().fit(geom.getExtent(), {
            padding:  [60, 60, 220, 360], // extra bottom padding for table drawer
            duration: 500,
            maxZoom:  isPoint ? 15 : undefined
        });
    }
    highlightTimeout = setTimeout(clearHighlight, 2000);
}

function clearHighlight() {
    clearTimeout(highlightTimeout);
    if (highlightLayer) highlightLayer.getSource().clear();
    document.querySelectorAll("#table-tbody tr.active").forEach(tr => tr.classList.remove("active"));
}

// ────────────────────────────────────────────────────────────────
// Table viewer
// ────────────────────────────────────────────────────────────────
let tableLayerId     = null;
let tableSortCol     = null;
let tableSortAsc     = true;
let tableFilter      = "";
let tableColumns     = [];
let tableFeatureData = []; // [{ fidx, values }]

function openTableModal(id) {
    const item = layers.find(l => l.id === id);
    if (!item) return;
    const features = item.olLayer.getSource().getFeatures();
    if (features.length === 0) { alert("Layer has no features."); return; }

    tableLayerId     = id;
    tableSortCol     = null;
    tableSortAsc     = true;
    tableFilter      = "";
    tableColumns     = Object.keys(features[0].getProperties()).filter(k => k !== "geometry");
    tableFeatureData = features.map((f, fidx) => ({
        fidx,
        values: Object.fromEntries(tableColumns.map(col => [col, f.get(col)]))
    }));

    document.getElementById("table-search").value = "";
    document.getElementById("table-modal-title").textContent = item.name;
    document.getElementById("table-modal").classList.remove("hidden");
    renderTable();
}

function closeTableModal() {
    tableLayerId = null;
    document.getElementById("table-modal").classList.add("hidden");
    clearHighlight();
}

function sortTable(col) {
    if (tableSortCol === col) {
        tableSortAsc = !tableSortAsc;   // same column: toggle direction
    } else {
        tableSortCol = col;             // new column: start ascending
        tableSortAsc = true;
    }
    renderTable();
}

function filterTable(val) {
    tableFilter = val.toLowerCase();
    renderTable();
}

function renderTable() {
    const thead = document.getElementById("table-thead");
    const tbody = document.getElementById("table-tbody");
    const count = document.getElementById("table-count");

    // Header
    thead.innerHTML = "<tr>" + tableColumns.map(col => {
        const arrow = tableSortCol === col ? (tableSortAsc ? " ▲" : " ▼") : "";
        return `<th onclick="sortTable('${col}')" title="Sort by ${col}">${col}${arrow}</th>`;
    }).join("") + "</tr>";

    // Filter
    let rows = tableFeatureData;
    if (tableFilter) {
        rows = rows.filter(row =>
            tableColumns.some(col => {
                const v = row.values[col];
                return v != null && String(v).toLowerCase().includes(tableFilter);
            })
        );
    }

    // Sort
    if (tableSortCol) {
        rows = [...rows].sort((a, b) => {
            const va = a.values[tableSortCol], vb = b.values[tableSortCol];
            if (va == null && vb == null) return 0;
            if (va == null) return 1;
            if (vb == null) return -1;
            const na = Number(va), nb = Number(vb);
            const cmp = (!isNaN(na) && !isNaN(nb))
                ? na - nb
                : String(va).localeCompare(String(vb));
            return tableSortAsc ? cmp : -cmp;
        });
    }

    // Count
    const total = tableFeatureData.length;
    count.textContent = tableFilter
        ? `${rows.length} / ${total} features`
        : `${total} features`;

    // Body
    tbody.innerHTML = rows.map(row => {
        const cells = tableColumns.map(col => {
            const v  = row.values[col];
            const isNull = v == null;
            const display = isNull ? "—" : String(v);
            const isNum   = !isNull && !isNaN(Number(v)) && typeof v !== "boolean" && v !== "";
            const cls     = isNull ? "null-val" : (isNum ? "num" : "");
            return `<td class="${cls}" title="${isNull ? "" : display}">${display}</td>`;
        }).join("");
        return `<tr data-fidx="${row.fidx}" onclick="selectTableRow(${row.fidx})">${cells}</tr>`;
    }).join("");
}

function exportTableCSV() {
    if (!tableColumns.length) return;
    const item = layers.find(l => l.id === tableLayerId);

    // Re-apply current filter + sort to get the exact visible rows
    let rows = tableFeatureData;
    if (tableFilter) {
        rows = rows.filter(row =>
            tableColumns.some(col => {
                const v = row.values[col];
                return v != null && String(v).toLowerCase().includes(tableFilter);
            })
        );
    }
    if (tableSortCol) {
        rows = [...rows].sort((a, b) => {
            const va = a.values[tableSortCol], vb = b.values[tableSortCol];
            if (va == null && vb == null) return 0;
            if (va == null) return 1;
            if (vb == null) return -1;
            const na = Number(va), nb = Number(vb);
            const cmp = (!isNaN(na) && !isNaN(nb))
                ? na - nb : String(va).localeCompare(String(vb));
            return tableSortAsc ? cmp : -cmp;
        });
    }

    // CSV escaping: wrap in quotes if value contains comma, quote, or newline
    const esc = v => {
        const str = v == null ? "" : String(v);
        const needsQuotes = str.includes(",") || str.includes('"')
                         || str.indexOf("\n") !== -1 || str.indexOf("\r") !== -1;
        return needsQuotes ? `"${str.replace(/"/g, '""')}"` : str;
    };

    const lines = [
        tableColumns.map(esc).join(","),
        ...rows.map(row => tableColumns.map(col => esc(row.values[col])).join(","))
    ];

    const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `${item?.name || "layer"}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function selectTableRow(fidx) {
    if (tableLayerId === null) return;
    const item = layers.find(l => l.id === tableLayerId);
    if (!item) return;
    const feature = item.olLayer.getSource().getFeatures()[fidx];
    if (!feature) return;

    // Highlight active row
    document.querySelectorAll("#table-tbody tr").forEach(tr => tr.classList.remove("active"));
    const row = document.querySelector(`#table-tbody tr[data-fidx="${fidx}"]`);
    if (row) { row.classList.add("active"); row.scrollIntoView({ block: "nearest" }); }

    highlightFeature(feature);
}

// ────────────────────────────────────────────────────────────────
// Export / Import (.qview)
// ────────────────────────────────────────────────────────────────
function exportQview() {
    if (layers.length === 0) { alert("No layers to export."); return; }

    const data = {
        version:  1,
        exported: new Date().toISOString(),
        layers:   layers.map(item => ({
            name:             item.name,
            geometryType:     item.geometryType,
            visible:          item.olLayer.getVisible(),
            opacity:          item.currentOpacity,
            labelsEnabled:    item.currentLabels,
            tipsEnabled:      item.tipsEnabled,
            labelFontSize:    item.labelConfig?.fontSize     ?? null,
            labelFontSizeUnit:item.labelConfig?.fontSizeUnit ?? null,
            qlr:              item._qlrText,
            geojson:          item._geojsonText
        }))
    };

    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = "map.qview";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ────────────────────────────────────────────────────────────────
// Panel resize
// ────────────────────────────────────────────────────────────────
function initPanelResize() {
    const handle = document.getElementById("panel-resize");
    const panel  = document.getElementById("panel");
    let startX, startW;
    handle.addEventListener("mousedown", e => {
        startX = e.clientX; startW = panel.offsetWidth;
        handle.classList.add("dragging");
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup",   onUp);
    });
    function onMove(e) {
        const w = Math.max(220, Math.min(520, startW + e.clientX - startX));
        panel.style.width = panel.style.minWidth = w + "px";
    }
    function onUp() {
        handle.classList.remove("dragging");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup",   onUp);
    }
}

// ────────────────────────────────────────────────────────────────
// Drop zone
// ────────────────────────────────────────────────────────────────
function initDropZone() {
    const zone  = document.getElementById("drop-zone");
    const input = document.getElementById("file-input");
    zone.addEventListener("click",     () => input.click());
    zone.addEventListener("dragover",  e => { e.preventDefault(); zone.classList.add("drag-over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
    zone.addEventListener("drop", e => {
        e.preventDefault(); zone.classList.remove("drag-over");
        [...e.dataTransfer.files].forEach(handleFile);
    });
    input.addEventListener("change", () => { [...input.files].forEach(handleFile); input.value = ""; });
}

// ────────────────────────────────────────────────────────────────
// Init
// ────────────────────────────────────────────────────────────────
initMap();
initHighlightLayer();
initBasemapControl();
initDropZone();
initPanelResize();
initMapTips();