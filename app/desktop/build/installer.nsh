; NeverQuestAlone's additions to electron-builder's NSIS uninstaller (BYOK PRD
; §16.3 "Uninstall": "The Windows uninstaller does the same"; OB-3, B3.5).
;
; electron-builder already removes the install folder and, with
; deleteAppDataOnUninstall, the app data folder under %APPDATA%. This removes
; what lives elsewhere, so an uninstall from Settings > Apps leaves nothing
; behind even when the in-app Uninstall wasn't used:
;   - the login item: the HKCU Run value main.mjs writes through
;     setLoginItemSettings (named after the app id, src/login-item.mjs), and
;     Explorer's enabled/disabled flag for it;
;   - the saved provider keys in Credential Manager: service "NeverQuestAlone",
;     account "<provider>" (bridge/byok/security/keystore.mjs), which
;     @napi-rs/keyring stores as the generic credential
;     "<provider>.NeverQuestAlone";
;   - electron-updater's download cache, %LOCALAPPDATA%\neverquestalone-updater;
;   - the addon, its slot folders and the chats the game keeps for it (audit
;     CV-07), from every World of Warcraft folder the app installed the addon
;     into: the app lists them in %APPDATA%\NeverQuestAlone\uninstall.ini
;     (bridge/byok/wow.mjs recordAddonFolder; UTF-16 with a byte-order mark,
;     which ReadINIStr reads as Unicode), read here before electron-builder
;     removes that folder. From each: Interface\AddOns\NeverQuestAlone, NQA_Data
;     and NQA_S000 to NQA_S999 (wow.mjs isAddonFolder), and
;     WTF\Account\<account>\SavedVariables\NeverQuestAlone.lua and NeverQuestAlone.lua.bak.
;     Nothing else there is touched. A game still running writes that file
;     again when it logs out.
; None of it runs when the uninstaller is part of an update (isUpdated),
; so an update keeps the keys, the login item and the addon.
;
; The provider list matches PROVIDER_IDS in ipc.mjs, which the manifests
; give (a test checks).

!macro nqaDeleteKey PROVIDER
  System::Call 'advapi32::CredDeleteW(w "${PROVIDER}.NeverQuestAlone", i 1, i 0)'
!macroend

!ifdef BUILD_UNINSTALLER
  Var nqaFlavor

  ; One WoW flavor folder ($nqaFlavor, "" for none): the addon's folders and its saved chats.
  Function un.bonesCleanFlavor
    Push $R0
    Push $R1
    Push $R2
    Push $R3
    StrCmp $nqaFlavor "" done
    RMDir /r "$nqaFlavor\Interface\AddOns\NeverQuestAlone"
    RMDir /r "$nqaFlavor\Interface\AddOns\NQA_Data"
    StrCpy $R0 0
    slot:
      IntFmt $R1 "%03d" $R0
      RMDir /r "$nqaFlavor\Interface\AddOns\NQA_S$R1"
      IntOp $R0 $R0 + 1
      IntCmp $R0 1000 0 slot 0
    FindFirst $R2 $R3 "$nqaFlavor\WTF\Account\*"
    account:
      StrCmp $R3 "" accountsDone
      StrCmp $R3 "." nextAccount
      StrCmp $R3 ".." nextAccount
      Delete "$nqaFlavor\WTF\Account\$R3\SavedVariables\NeverQuestAlone.lua"
      Delete "$nqaFlavor\WTF\Account\$R3\SavedVariables\NeverQuestAlone.lua.bak"
    nextAccount:
      FindNext $R2 $R3
      Goto account
    accountsDone:
    FindClose $R2
    done:
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
  FunctionEnd

  ; Every folder uninstall.ini lists (folder1 to folder8, wow.mjs UNINSTALL_RECORD_MAX).
  Function un.bonesCleanWow
    Push $R4
    StrCpy $R4 1
    folder:
      ClearErrors
      ReadINIStr $nqaFlavor "$APPDATA\NeverQuestAlone\uninstall.ini" "addon" "folder$R4"
      Call un.bonesCleanFlavor
      IntOp $R4 $R4 + 1
      IntCmp $R4 8 folder folder 0
    ClearErrors
    Pop $R4
  FunctionEnd
!endif

!macro customUnInstall
  ${ifNot} ${isUpdated}
    Call un.bonesCleanWow
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.neverquestalone.app"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.neverquestalone.app"
    !insertmacro nqaDeleteKey anthropic
    !insertmacro nqaDeleteKey openai
    !insertmacro nqaDeleteKey xai
    !insertmacro nqaDeleteKey google
    !insertmacro nqaDeleteKey custom
    ; An OpenRouter key saved before Other (custom) replaced OpenRouter's card (boot moves it to custom).
    !insertmacro nqaDeleteKey openrouter
    RMDir /r "$LOCALAPPDATA\neverquestalone-updater"
  ${endIf}
!macroend
