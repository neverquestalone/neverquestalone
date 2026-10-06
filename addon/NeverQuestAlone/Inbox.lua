-- The reload-path inbox (docs/PROTOCOL.md §5). The bridge rewrites this file on
-- every publish with the same table as a slot file, assigned to NQA_Inbox;
-- the addon reads it at every login and /reload. This placeholder just has to
-- exist when the game launches.
NQA_Inbox = nil
