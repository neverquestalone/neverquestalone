// The game's AddOns list, as Blizzard_AddOnList builds its rows (AddonList.lua,
// AddonList_Update, lines 440-535 at wow-ui-source bd2470a, build 1.60.1.70009),
// for tests/addon_list_test.mjs and the preview (tests/render_ui.js ADDONS=1).
//
// Each addon has a Group: its TOC's, or one the client sets (its own name, or,
// for addons named alike that depend on each other, the first one's: before
// 0.5.3 the slots showed under NeverQuestAlone's row). An addon whose Group is its own
// name starts a node, at the root or, with a Category, under that category's row
// (made once, folded while g_addonCategoriesCollapsed[category] is set); one
// whose Group names another joins that node (held until the node exists; a group
// that never gets one falls back to the root). Categories sort first, by name;
// addons by the client's order. A folded node hides everything under it
// (TreeListDataProvider). Category rows have no check box and no icon
// (AddonList.xml, AddonListCategoryTemplate).

// A TOC's "## Key: value" lines, as an object.
export const tocMeta = text => Object.fromEntries(String(text).split('\n')
  .map(l => l.match(/^## ([^:]+):\s*(.*)$/)).filter(Boolean).map(m => [m[1], m[2]]));

// addons: [{ name, title, group, category?, icon? }] in the client's order.
// folded: { [category]: true }. Returns the rows a player sees, top to bottom:
// { text, depth, checkbox, category, icon }.
export function addonListRows(addons, folded = {}) {
  const root = { nodes: [] };
  const categories = new Map(), groups = new Map(), pending = new Map();
  addons.forEach((a, index) => {
    const node = { addon: a, index, nodes: [] };
    if (groups.has(a.group)) { groups.get(a.group).nodes.push(node); return; }
    if (a.name !== a.group) {
      if (!pending.has(a.group)) pending.set(a.group, []);
      pending.get(a.group).push(node);
      return;
    }
    let parent = root;
    if (a.category) {
      if (!categories.has(a.category)) {
        const c = { category: a.category, collapsed: !!folded[a.category], nodes: [] };
        categories.set(a.category, c);
        root.nodes.push(c);
      }
      parent = categories.get(a.category);
    }
    parent.nodes.push(node);
    groups.set(a.group, node);
    node.nodes.push(...(pending.get(a.group) || []));
    pending.delete(a.group);
  });
  for (const children of pending.values()) root.nodes.push(...children);
  const order = (x, y) => (x.category && y.category ? x.category.localeCompare(y.category)
    : x.addon && y.addon ? x.index - y.index : x.category ? -1 : 1);
  const rows = [];
  (function walk(n, depth) {
    for (const c of [...n.nodes].sort(order)) {
      rows.push(c.category
        ? { text: c.category, depth, checkbox: false, category: true, folded: c.collapsed }
        : { text: c.addon.title, depth, checkbox: true, category: false, icon: c.addon.icon || null, status: c.addon.status || '' });
      if (!c.collapsed) walk(c, depth + 1);
    }
  })(root, 0);
  return rows;
}
