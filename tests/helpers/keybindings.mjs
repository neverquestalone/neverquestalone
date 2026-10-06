// The game's Keybindings page (Options > Keybindings), as Blizzard_SettingsDefinitions_Frame builds
// it on Forever (Keybindings.lua:216-265 and Mainline/KeybindingsOverrides.lua:7-36 at wow-ui-source
// bd2470a, build 1.60.1.70009), for tests/ui_v2_test.js and the preview (tests/render_ui.js
// KEYBINDINGS=1).
//
// - Sections: the game's own first, in its fixed order (AddBindingCategory), then one for each other
//   category, in the order the bindings first name it. A binding's category names its section through
//   GetBindingCategoryName: _G[category] when that's a string, else the category as written. So
//   category="ADDONS" is the game's shared "AddOns" section, and category="BINDING_HEADER_NQA" a
//   section of its own named after that global, as Blizzard_PingUI's and Blizzard_Commentator's
//   bindings get.
// - A section is drawn only when something is in it. A Binding's header="X" is an entry of its own,
//   HEADER_X, drawn as a blank 25-unit row (KeybindingSpacer, Keybindings.xml:5-7): its words show
//   nowhere, and search leaves it out (Keybindings.lua:194).
// - Every section opens collapsed, 25 tall (Plunderstorm's aside); open, 45 plus 25 a key.
// - Settings.OpenToCategory(id, name) scrolls to the element whose own data.name is name
//   (ScrollToElementByName, Blizzard_SettingsList.lua:152-158): a section's name, never a header's or
//   a key's. With none, the page opens at its top.

// The game's words for its sections and the page (English, from GlobalStrings: wago.tools'
// GlobalStrings table, 2026-09-27; Forever's client may word one differently).
export const GAME_STRINGS = {
  ADDONS: 'AddOns',
  BINDING_HEADER_MOVEMENT: 'Movement Keys',
  BINDING_HEADER_INTERFACE: 'Interface Panel',
  BINDING_HEADER_ACTIONBAR: 'Action Bar',
  BINDING_HEADER_MULTIACTIONBAR: 'Extra Action Bars',
  BINDING_HEADER_CHAT: 'Chat',
  BINDING_HEADER_TARGETING: 'Targeting',
  BINDING_HEADER_RAID_TARGET: 'Target Markers',
  BINDING_HEADER_VEHICLE: 'Vehicle Controls',
  BINDING_HEADER_CAMERA: 'Camera',
  BINDING_HEADER_MISC: 'Miscellaneous',
  BINDING_HEADER_OTHER: 'Other',
  SETTINGS_KEYBINDINGS_LABEL: 'Keybindings',
  CHARACTER_SPECIFIC_KEYBINDINGS: 'Character Specific Keybindings',
  CLICK_BIND_MODE: 'Click Casting',
  SETTINGS_QUICK_KEYBIND_BUTTON: 'Quick Keybind Mode',
  NOT_BOUND: 'Not Bound',
};

// The game's own sections on Forever, in order (Mainline/KeybindingsOverrides.lua:14-35): Action Bar 2
// to 8 show only while those bars are on in Options, Housing is off on Forever
// (Camelot/KeybindingsOverrides.lua), and Ping System's keys come from Blizzard_PingUI, which loads only
// in the mainline game (its TOC), so none of those are here.
export const GAME_SECTIONS = ['BINDING_HEADER_MOVEMENT', 'BINDING_HEADER_INTERFACE', 'BINDING_HEADER_ACTIONBAR',
  'BINDING_HEADER_MULTIACTIONBAR', 'BINDING_HEADER_CHAT', 'BINDING_HEADER_TARGETING', 'BINDING_HEADER_RAID_TARGET',
  'BINDING_HEADER_VEHICLE', 'BINDING_HEADER_CAMERA', 'BINDING_HEADER_MISC', 'BINDING_HEADER_OTHER'];

// A Bindings.xml's <Binding> elements, in order: { name, category, header }, each attribute as written
// (undefined when it's missing).
export function bindingsXml(text) {
  return [...String(text).replace(/<!--[\s\S]*?-->/g, '').matchAll(/<Binding\b([^>]*)>/g)].map(m => {
    const a = Object.fromEntries([...m[1].matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)].map(x => [x[1], x[2]]));
    return { name: a.name, category: a.category, header: a.header };
  });
}

// bindings: [{ name, category, header }] in the client's order (the game's own come before any addon's).
// G(name): a global's value, or undefined. Returns the sections drawn, top to bottom:
// [{ name, entries: [{ spacer: true } | { action }] }]. The game's own are empty here unless bindings
// name them; `game: true` draws them anyway, as the page does with the game's keys in them.
export function keybindingSections(bindings, G, { game = false } = {}) {
  const sections = new Map();
  const add = name => { if (!sections.has(name)) sections.set(name, { name, entries: [], game: false }); return sections.get(name); };
  for (const key of GAME_SECTIONS) add(G(key) ?? key).game = true;
  for (const b of bindings) {
    const loc = b.category === undefined ? undefined : G(b.category);
    const section = add(b.category === undefined ? (G('BINDING_HEADER_OTHER') ?? 'Other') : typeof loc === 'string' ? loc : b.category);
    if (b.header !== undefined) section.entries.push({ spacer: true });
    section.entries.push({ action: b.name });
  }
  return [...sections.values()].filter(s => s.entries.length > 0 || (game && s.game));
}

// Where Settings.OpenToCategory(Settings.KEYBINDINGS_CATEGORY_ID, name) lands: the index of the section
// named name, or -1 (the page's top).
export const scrollTarget = (sections, name) => sections.findIndex(s => s.name === name);
