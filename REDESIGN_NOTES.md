# Aura source update

This revision applies the latest screenshot feedback directly to the Aura source files.

The hero now uses the exact branding line **AURA · BY AKSHAT ARORA** above the greeting. The unnecessary hero description and visualizer markup have been removed, the hero is rendered as a compact single-column classic panel, and the extra hero pseudo-label is disabled. The lower-left profile/listening-mode card has been removed so the sidebar keeps only the compact now-playing card and the three action controls.

The classic black-and-graphite interface remains intact. Natural song artwork is restored by removing grayscale filters from quick picks, song cards, album cards, artist cards, queue artwork, the mini player, and the player thumbnail. Artwork colors are preserved without recoloring the surrounding interface.

The earlier equalizer repair is retained: active-media helpers, the dedicated same-origin video element, single MediaElementSource binding, shared playback controls, and song/video routing remain in place. Asset cache keys were bumped so browsers load the latest CSS and JavaScript.

Validation completed with JavaScript syntax checks, Flask bytecode compilation, and source assertions confirming the branding, removed hero/profile regions, natural-color artwork rules, and equalizer helper are present.
