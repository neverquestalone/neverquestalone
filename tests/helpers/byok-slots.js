'use strict';
// Slots for the addon's BYOK tests and previews (tests/byok/addon_byok_test.js,
// tests/byok/render_byok_ui.js): one with none of the new caps (a provider part
// that failed, or an app from before them) and the app's own (caps provider,
// usage, ekind, model; bridge.provider, bridge.usage, rt), as the build plan's
// "Contract: what the addon reads" has them.
const { lstr } = require('./nqa-vm');

function ring(vm) {
  const bell = vm.pushBell = vm.pushBell === 'push_a' ? 'push_b' : 'push_a';
  vm.signal('ctl', `bell_${bell}`, false);
  vm.run('NS.Transport.Poll()');
  vm.signal('ctl', `bell_${bell}`, true);
  vm.run('NS.Transport.Poll()');
  return vm;
}
// A slot with none of the new caps.
function oldSlot({ push = 0, nonce = null, records = [], caps = '"state", "evt", "think", "z", "ctx"', gw = '{ state = "ready", ver = "2026.9.6", proto = 4, queued = 0 }' } = {}) {
  return `{ v = 2, ts = "2026-09-26T18:04:00Z", now = time(), token = NQADB.token, bridge = { ver = "1.3.0", push = ${push}, nonce = ${nonce ? `"${nonce}"` : 'nil'}, acked = {}, caps = { ${caps} }, think = "medium" }, gw = ${gw}, agents = { { id = "main", name = "NeverQuestAlone" } }, chats = {}, records = { ${records.join(', ')} } }`;
}
const CAPS = '"state", "evt", "think", "z", "ctx", "provider", "usage", "ekind", "model"';
function provider(o = {}) {
  const p = { id: 'anthropic', name: 'Anthropic', model: 'claude-haiku-4-5', modelName: 'Haiku 4.5', effort: 'low', effortSupported: true, auth: 'key', keyState: 'ok', privacy: 'cloud-no-train', product: 'NeverQuestAlone', companion: 'NeverQuestAlone', ...o };
  return '{ ' + Object.entries(p).filter(([, v]) => v !== null).map(([k, v]) => `${k} = ${typeof v === 'string' ? lstr(v) : v}`).join(', ') + ' }';
}
// bridge.usage as the public build sends it: no limits of its own (no capMicros
// unless the player set a daily spend limit; capTurns and autoLeft are gone),
// turns (typed today) and auto (automatic today). capped(): the same with the player's $1.00 limit.
function usage(o = {}) {
  const u = { day: '2026-09-26', spentMicros: 180000, turns: 23, auto: 4, exact: true, ...o };
  return '{ ' + Object.entries(u).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k} = ${typeof v === 'string' ? lstr(v) : v}`).join(', ') + ' }';
}
const PLAYER_CAP = 1000000;
const capped = (o = {}) => usage({ capMicros: PLAYER_CAP, ...o });
// A BYOK bridge's slot: the new caps, bridge.provider, bridge.usage and rt, and
// bridge.backend "byok" (the core names the public build in every slot).
function byokSlot({ caps = CAPS, p = provider(), u = usage(), rt = '{ state = "ready" }', records = [], nonce = null, push = 0, companion = 'NeverQuestAlone' } = {}) {
  return `{ v = 2, ts = "2026-09-26T18:04:00Z", now = time(), token = NQADB.token, bridge = { ver = "1.4.0", push = ${push}, nonce = ${nonce ? `"${nonce}"` : 'nil'}, acked = {}, caps = { ${caps} }, think = "medium", backend = "byok", provider = ${p}, usage = ${u} }, gw = { state = "ready", ver = "byok-1", queued = 0 }, rt = ${rt}, agents = { { id = "main", name = ${lstr(companion)} } }, chats = {}, records = { ${records.join(', ')} } }`;
}
// A copy of the addon an earlier desktop app installed (the consolidation plan's
// R3): its TOC says ## X-Backend: byok. The addon doesn't read it since the
// retired build went (one build), and the app doesn't stamp it now. Lua for
// newVM's extra.
const PUBLIC = `do
	local get = C_AddOns.GetAddOnMetadata
	C_AddOns.GetAddOnMetadata = function(name, field)
		if field == "X-Backend" then return "byok" end
		return get(name, field)
	end
end
`;
function confirmHello(vm) {
  vm.advance(3.1);
  vm.slot(oldSlot({ nonce: vm.evaluate('NS.R.nonce'), push: 0 }));
  ring(vm);
  vm.run('STUB.onLoadAddOn = nil');
  vm.advance(0.3);
  return vm;
}
const apply = (vm, slot) => vm.run(`NS.Transport.HandleSlotData(${slot}, "slot")`);
function replyRec(seq, chat, text, extra = '') {
  return `{ seq = ${seq}, t = "reply", chat = "${chat}", mid = "m-${seq}", agent = "main", text = ${lstr(text)}, summary = "", more = 0${extra} }`;
}
function errorRec(seq, chat, kind, action, text) {
  return `{ seq = ${seq}, t = "error", chat = "${chat}", kind = "${kind}"${action ? `, action = "${action}"` : ''}, text = ${lstr(text)} }`;
}

module.exports = { PUBLIC, ring, oldSlot, CAPS, provider, usage, capped, PLAYER_CAP, byokSlot, confirmHello, apply, replyRec, errorRec };
