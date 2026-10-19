---
"openfilm": patch
---

Resize media contact-sheet thumbnails before embedding them, preventing "Invalid string length" on high-resolution, high-bit-depth clips. Single-frame output keeps its original resolution. A transparent WebM (VP9 or VP8) keeps its alpha in the sheet and in a single frame.
