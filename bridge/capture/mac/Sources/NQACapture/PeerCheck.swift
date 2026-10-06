import Foundation
import Security

// Who is at the other end of the capture socket, by its code signature: the peer's audit token
// (LOCAL_PEERTOKEN, never its pid: a pid can be reused) as a SecCode, held to a requirement. Two
// checks use it.
//
// The app's (every build; code health LS-03 / peer check): Node can't name a socket's peer, so the
// app runs this executable directly with --check-peer <requirement> and a connection its capture
// socket accepted as fd 3, before it reads a byte of that connection (main.swift; transport/capture.mjs
// checkPeer). The requirement is the app's: this helper's bundle id and the app's own Developer ID
// team. So a program of the player's that connects first, or in the 3 s before a relaunch, can't feed
// the bridge strip records or status lines. An app with no team (unsigned, ad hoc) asks nothing, as
// this helper's own check skips when it has none.
//
// The helper's own (NeverQuestAlone's build only, below).

/// nil when the peer of the socket on `fd` meets `requirement`; else why not, for one stderr line, which
/// names the peer `who` and says it isn't `wanted`.
func peerRefusal(fd: Int32, requirement text: String, who: String = "the socket's owner", wanted: String = "NeverQuestAlone") -> String? {
    var token = audit_token_t()
    var len = socklen_t(MemoryLayout<audit_token_t>.size)
    guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &len) == 0, Int(len) == MemoryLayout<audit_token_t>.size else {
        return "\(who) can't be named (errno \(errno))"
    }
    let guest = [kSecGuestAttributeAudit as String: withUnsafeBytes(of: &token) { Data($0) }] as CFDictionary
    var peer: SecCode?
    guard SecCodeCopyGuestWithAttributes(nil, guest, [], &peer) == errSecSuccess, let peer else {
        return "\(who) has no code to check"
    }
    var requirement: SecRequirement?
    guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess, let requirement else {
        return "the requirement doesn't compile"
    }
    let status = SecCodeCheckValidity(peer, [], requirement)
    return status == errSecSuccess ? nil : "\(who) isn't \(wanted) (\(status))"
}

#if NQA_PUBLIC_ID
// NeverQuestAlone's helper serves nothing but the NeverQuestAlone app (code health BR-01, the old
// audit LS-01). It holds the player's Screen Recording grant, so a process that launched it with a
// socket of its own would get pictures under that grant. main.swift asks right after connecting,
// before the lock, the capture or any permission call, and sends nothing to a socket that fails.
//
// What the socket's owner must be: signed as the app (its identifier, app/desktop/electron-builder.yml
// appId) by this helper's own Developer ID team, which this helper reads from its own signature once
// that signature holds for the code running (SecCodeCheckValidity on itself also compares the running
// code's hash with the file's, so a file swapped after launch can't make it read as teamless). The
// requirement is boot's rule for this helper (transport/capture.mjs buildRequirement), mirrored. A
// helper with no team (ad hoc, or a local identity's: never a build a player gets) has no team to ask
// for and skips the check; a Developer ID build never does.

/// The app's code signing identifier (app/desktop/electron-builder.yml appId). The bridge listens on
/// the socket in the app's main process (main.mjs imports boot.mjs); a bridge moved into one of the
/// app's helper processes would need that helper's identifier here.
let nqaAppIdentifier = "com.neverquestalone.app"

/// What the socket's owner must satisfy for a helper signed by `team`: the app's identifier and that
/// team's Developer ID, in the form transport/capture.mjs builds for the helper.
func peerRequirement(team: String) -> String {
    "identifier \"\(nqaAppIdentifier)\" and ((anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and "
        + "certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = \"\(team)\"))"
}

/// This helper's own team, from its signature: .team(id); .none with none (ad hoc or a local
/// identity); .unreadable(why) when the signature can't be read or doesn't hold for the code running.
enum OwnTeam {
    case team(String)
    case none
    case unreadable(String)
}

func ownTeam() -> OwnTeam {
    var me: SecCode?
    guard SecCodeCopySelf([], &me) == errSecSuccess, let me else { return .unreadable("this helper's own code can't be named") }
    let valid = SecCodeCheckValidity(me, [], nil)
    guard valid == errSecSuccess else { return .unreadable("this helper's own signature doesn't hold (\(valid))") }
    var disk: SecStaticCode?
    guard SecCodeCopyStaticCode(me, [], &disk) == errSecSuccess, let disk else { return .unreadable("this helper's own file can't be named") }
    var info: CFDictionary?
    guard SecCodeCopySigningInformation(disk, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
          let info = info as? [String: Any] else { return .unreadable("this helper's own signature can't be read") }
    guard let team = info[kSecCodeInfoTeamIdentifier as String] as? String, !team.isEmpty else { return .none }
    guard team.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil else { return .unreadable("this helper's team isn't a team ID") }
    return .team(team)
}

/// nil when the NeverQuestAlone app serves the socket on `fd`, or when this helper has no team to ask
/// for (ad hoc, a local identity); else why not.
func peerRefusal(fd: Int32) -> String? {
    switch ownTeam() {
    case .none: return nil
    case .unreadable(let why): return why
    case .team(let team): return peerRefusal(fd: fd, requirement: peerRequirement(team: team))
    }
}
#endif
