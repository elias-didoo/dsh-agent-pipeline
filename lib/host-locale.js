/**
 * UI language resolution on the Host side.
 *
 * The locale plugin keeps the user's choice in the Host user-settings document
 * under the `locale` namespace, so the Host can read it without asking the
 * browser. When the user has never picked a language the field is absent and
 * DSH falls back to the browser setting, which is not visible here — English is
 * the safe default in that case.
 */

/** Settings namespace the locale plugin writes to. */
export const LOCALE_SETTINGS_NS = "locale"

/**
 * @param {object} ctx plugin context
 * @returns {"zh" | "en"}
 */
export function resolveUiLocale(ctx) {
  try {
    // Optional service: a profile without the settings plugin must still load
    // this one, so it is fetched rather than declared as a hard injection.
    const settings = ctx?.get?.("settings")
    if (!settings || typeof settings.describe !== "function") return "en"
    const described = settings.describe({ redactSecrets: true })
    const ns = described?.namespaces?.find?.((n) => n?.ns === LOCALE_SETTINGS_NS)
    const pref = ns?.value?.preference
    return typeof pref === "string" && pref.toLowerCase().startsWith("zh") ? "zh" : "en"
  } catch {
    return "en"
  }
}
