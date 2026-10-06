// A small fengari Lua VM for tests: run chunks, read globals back as JS values.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

export function newLuaVM() {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code, chunkName = 'chunk') => {
    if (lauxlib.luaL_loadbuffer(L, to_luastring(code), null, to_luastring(chunkName)) !== lua.LUA_OK) {
      throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(L, -1)));
    }
    if (lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
  };
  // Convert the value on top of the stack to JS (tables: arrays when keys are 1..n).
  const toJS = (idx, depth = 0) => {
    const t = lua.lua_type(L, idx);
    if (t === lua.LUA_TNIL) return null;
    if (t === lua.LUA_TBOOLEAN) return lua.lua_toboolean(L, idx);
    if (t === lua.LUA_TNUMBER) return lua.lua_tonumber(L, idx);
    if (t === lua.LUA_TSTRING) return to_jsstring(lua.lua_tostring(L, idx));
    if (t === lua.LUA_TTABLE) {
      if (depth > 20) return '<deep>';
      const abs = lua.lua_absindex(L, idx);
      const entries = [];
      lua.lua_pushnil(L);
      while (lua.lua_next(L, abs) !== 0) {
        const k = toJS(-2, depth + 1);
        const v = toJS(-1, depth + 1);
        entries.push([k, v]);
        lua.lua_pop(L, 1);
      }
      const n = entries.length;
      const isArray = n > 0 && entries.every(([k]) => typeof k === 'number') && entries.map(([k]) => k).sort((a, b) => a - b).every((k, i) => k === i + 1);
      if (isArray) return entries.sort((a, b) => a[0] - b[0]).map(([, v]) => v);
      if (n === 0) return {};
      return Object.fromEntries(entries.map(([k, v]) => [String(k), v]));
    }
    return `<${to_jsstring(lua.lua_typename(L, t))}>`;
  };
  const global = (name) => {
    lua.lua_getglobal(L, to_luastring(name));
    const v = toJS(-1);
    lua.lua_pop(L, 1);
    return v;
  };
  const globalNames = () => {
    const names = [];
    lua.lua_pushglobaltable(L);
    lua.lua_pushnil(L);
    while (lua.lua_next(L, -2) !== 0) {
      if (lua.lua_type(L, -2) === lua.LUA_TSTRING) names.push(to_jsstring(lua.lua_tostring(L, -2)));
      lua.lua_pop(L, 1);
    }
    lua.lua_pop(L, 1);
    return names;
  };
  return { L, run, global, globalNames };
}
