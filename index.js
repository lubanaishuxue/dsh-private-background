/**
 * Host half of the custom-background bundle.
 *
 * The feature is entirely a browser-side surface: it paints a wallpaper behind the
 * shell columns and renders its control panel into `shell.overlay`. Nothing here
 * reaches the model, the session log, or any host service, so `apply` is empty.
 */
export function apply() {}
