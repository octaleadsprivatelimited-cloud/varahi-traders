# Design QA — Homepage mobile hero

- Source reference: `C:\Users\OCTALE~1\AppData\Local\Temp\codex-clipboard-1b6cf867-d1c6-472c-a8ba-4f991f6d49a4.png`
- Implementation screenshot: `C:\Users\octaleads\Documents\Codex\2026-08-31\op\work\home-hero-mobile-final.png`
- Desktop implementation screenshot: `C:\Users\octaleads\Documents\Codex\2026-08-31\op\work\home-hero-desktop-final.png`
- Labelled desktop implementation screenshot: `C:\Users\octaleads\Documents\Codex\2026-08-31\op\work\home-hero-desktop-labelled.png`
- Auto-scrolling trust strip screenshot: `C:\Users\octaleads\Documents\Codex\2026-08-31\op\work\trust-strip-desktop.png`
- Full-scene desktop hero screenshot: `C:\Users\octaleads\Documents\Codex\2026-08-31\op\work\home-hero-desktop-v3.png`
- Side-by-side comparison: `C:\Users\octaleads\Documents\Codex\2026-08-31\op\work\hero-comparison-final.png`
- QA viewport: 486 × 756 CSS pixels. The 1032 × 1536 source was proportionally normalized to 486 px wide for the comparison.

## Comparison history

1. Initial pass exposed an older mobile rule that constrained the hero artwork to a short rounded card.
2. Replaced that constraint with a full-height, edge-to-edge photographic layer behind semantic HTML content.
3. Adjusted the image scale and text measure so the jars remain to the right and the copy stays readable in the cream negative space.
4. Tuned headline size, body width, CTA width, vertical spacing, and fixed-navigation clearance against the combined reference/implementation comparison.
5. Extended the generated photography to desktop, removed the legacy split-panel background, and widened the copy measure so “Pure spices for” remains one deliberate line at 1264 px.
6. Restored perspective-correct Sri Varahi Traders labels to both bottles and verified the duplicate trust-stat track changes position continuously without a blank loop.
7. Replaced the desktop portrait crop with a landscape companion that retains the complete mobile product scene while keeping the original portrait asset below 800 px.

## Final findings

- Information hierarchy, cream/forest/orange palette, editorial typography, right-weighted product composition, primary CTA, and fixed mobile navigation match the reference direction.
- Content remains live HTML with an accessible H1, descriptive image alternative, and a working `/shop` CTA.
- The generated photography and header now use the Sri Varahi Traders identity.
- No visible overflow, rounded-card regression, or collision with the fixed mobile navigation remains at the QA viewport.
- Desktop verification at 1264 × 710 shows the same full-bleed photograph, editorial hierarchy, readable negative space, and working CTA without headline/product collision.
- Bottle labels are readable and correctly identify Turmeric Powder and Red Chilli Powder.
- The trust strip auto-scrolls continuously, pauses on pointer hover, and has no page-level horizontal overflow.
- Desktop verification at 1280 × 720 confirms both labelled jars, plant, bowls, turmeric root, seeds, cardamom, peppercorns, and dried chillies remain visible without cropping the mobile composition's key content.

Final result: passed
