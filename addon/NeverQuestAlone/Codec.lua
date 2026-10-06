-- NeverQuestAlone pixel codec. Pure Lua, no WoW APIs, so it can be tested outside the game.
-- Forked from upstream wow-ai's Codec.lua; only the magic changed (docs/PROTOCOL.md §2.1).
--
-- A frame is a byte stream:
--   [0xC7 0x2C] [frame hi, lo] [len hi, lo] [payload: len bytes] [fletcher s1, s2]
-- The checksum covers frame..payload. The bytes are packed MSB-first into 3-bit
-- cells; each cell is drawn as one square whose R, G and B channels are each fully
-- on or off (bit 2 = R, bit 1 = G, bit 0 = B). Pure primaries survive any
-- gamma/contrast setting, unlike intermediate levels. NeverQuestAlone Capture decodes it.
-- Upstream's magic is 0xC7 0x1A (protocol v1), so neither side reads the other.

NQA_Codec = {}
local C = NQA_Codec

C.MAGIC1, C.MAGIC2 = 0xC7, 0x2C
C.BITS = 3
C.MAX_PAYLOAD = 3200

function C.Fletcher16(bytes, from, to)
	local s1, s2 = 0, 0
	for i = from, to do
		s1 = (s1 + bytes[i]) % 255
		s2 = (s2 + s1) % 255
	end
	return s1, s2
end

-- The frame's bytes, kept between calls: only the first 8 + len are read each time.
local scratch = {}

-- Returns an array of cell values (0..7) and the number of bytes encoded.
-- [code health AD-03] into: a table to fill and return instead of a new one (the
-- strip passes the same one for every frame, so a frame makes no garbage); the
-- cells past this frame's are cleared, so #cells is this frame's count either way.
function C.Encode(id, payload, into)
	local len = #payload
	local bytes = scratch
	bytes[1], bytes[2] = C.MAGIC1, C.MAGIC2
	bytes[3], bytes[4] = math.floor(id / 256) % 256, id % 256
	bytes[5], bytes[6] = math.floor(len / 256) % 256, len % 256
	for i = 1, len do
		bytes[6 + i] = payload:byte(i)
	end
	local s1, s2 = C.Fletcher16(bytes, 3, 6 + len)
	local nb = 8 + len
	bytes[nb - 1], bytes[nb] = s1, s2

	local BITS = C.BITS
	local base = 2 ^ BITS
	local cells = into or {}
	local old, n = #cells, 0
	local acc, nbits = 0, 0
	for i = 1, nb do
		acc = acc * 256 + bytes[i]
		nbits = nbits + 8
		while nbits >= BITS do
			local shift = nbits - BITS
			n = n + 1
			cells[n] = math.floor(acc / 2 ^ shift) % base
			nbits = shift
			acc = acc % 2 ^ nbits
		end
	end
	if nbits > 0 then
		n = n + 1
		cells[n] = (acc * 2 ^ (BITS - nbits)) % base
	end
	for i = n + 1, old do cells[i] = nil end
	return cells, nb
end

-- Color for a cell value: each channel fully on or off.
function C.CellColor(v)
	local r = math.floor(v / 4) % 2
	local g = math.floor(v / 2) % 2
	local b = v % 2
	return r, g, b
end
