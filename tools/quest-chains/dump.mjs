// tools/quest-chains/dump.mjs: reads tables out of the cmangos classic-db SQL dump
// (and the CSVs wago.tools serves). Only extract.mjs uses it, by hand; the tests
// never read the dump. The tuple reader is tools/qol-quests/extract.mjs's.

import fs from "node:fs";
import zlib from "node:zlib";

/** The dump's text: a .sql file, or the .sql.gz the classic-db repo ships. */
export function readDump(file) {
	const raw = fs.readFileSync(file);
	return (file.endsWith(".gz") ? zlib.gunzipSync(raw) : raw).toString("utf8");
}

/** A reader over one dump: columns(table) and rows(table, keep). */
export function tables(sql) {
	function columns(table) {
		const m = sql.match(new RegExp("CREATE TABLE `" + table + "` \\(([\\s\\S]*?)\\n\\)"));
		if (!m) throw new Error(`no table ${table}`);
		return [...m[1].matchAll(/^\s*`(\w+)`/gm)].map((c) => c[1]);
	}
	// One INSERT's tuples, as arrays of strings (null for NULL).
	function tuples(body) {
		const out = [];
		let i = 0;
		while (i < body.length) {
			if (body[i] !== "(") { i++; continue; }
			i++;
			const row = [];
			for (;;) {
				if (body[i] === "'") {
					let s = "";
					i++;
					for (;;) {
						const ch = body[i];
						if (ch === "\\") { s += body[i + 1]; i += 2; continue; }
						if (ch === "'") {
							if (body[i + 1] === "'") { s += "'"; i += 2; continue; }
							i++;
							break;
						}
						s += ch;
						i++;
					}
					row.push(s);
				} else {
					let j = i;
					while (body[j] !== "," && body[j] !== ")") j++;
					const v = body.slice(i, j).trim();
					row.push(v === "NULL" ? null : v);
					i = j;
				}
				if (body[i] === ",") { i++; continue; }
				if (body[i] === ")") { i++; break; }
				throw new Error(`bad tuple near ${body.slice(i - 20, i + 20)}`);
			}
			out.push(row);
		}
		return out;
	}
	function rows(table, keep) {
		const cols = columns(table);
		const idx = keep.map((k) => {
			const n = cols.indexOf(k);
			if (n < 0) throw new Error(`${table} has no ${k}`);
			return n;
		});
		const out = [];
		const re = new RegExp("INSERT INTO `" + table + "` VALUES (.*?);\\n", "gs");
		for (const m of sql.matchAll(re)) {
			for (const t of tuples(m[1])) {
				const r = {};
				keep.forEach((k, n) => { r[k] = t[idx[n]]; });
				out.push(r);
			}
		}
		return out;
	}
	return { columns, rows };
}

/** A wago.tools CSV as objects keyed by its header (quoted fields, "" for a quote). */
export function csv(file) {
	const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
	const head = lines.shift().split(",");
	return lines.map((l) => {
		const v = [];
		let cur = "";
		let quoted = false;
		for (let i = 0; i < l.length; i++) {
			const ch = l[i];
			if (quoted) {
				if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
			} else if (ch === '"') quoted = true;
			else if (ch === ",") { v.push(cur); cur = ""; } else cur += ch;
		}
		v.push(cur);
		return Object.fromEntries(head.map((h, n) => [h, v[n]]));
	});
}
