# Save old profile files before electron-builder invokes the old uninstaller.
!ifndef BUILD_UNINSTALLER
!macro customCheckAppRunning
  Call AudoraPreserveLegacyData
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
!macroend

!macro customInit
  # Assisted machine-wide installs can skip the normal process check.
  ${If} $installMode == "all"
    Call AudoraPreserveLegacyData
  ${EndIf}
!macroend

!macro customHeader
!include "getProcessInfo.nsh"
Var pid
Function AudoraPreserveLegacyData
  SetShellVarContext current
  ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R0 == ""
    ReadRegStr $R0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${EndIf}
  ${If} $R0 == ""
    Goto audora_backup_done
  ${EndIf}
  StrCpy $R0 "$R0\resources\backend\_internal\data"
  StrCpy $R1 "$APPDATA\Audora\legacy-install-backup"
  StrCpy $R2 "$R1.pending"
  IfFileExists "$APPDATA\Audora\backend\audora.db" 0 audora_check_legacy
  IfFileExists "$APPDATA\Audora\backend\settings.json" audora_backup_done
audora_check_legacy:
  IfFileExists "$R0\audora.db" audora_backup_required
  IfFileExists "$R0\settings.json" audora_backup_required audora_backup_done

audora_backup_required:
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R3
  ${If} $R3 == 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "Close Audora and run this installer again so your library can be saved." /SD IDOK
    Abort
  ${EndIf}
  CreateDirectory "$R2"
  Delete "$R2\audora.db"
  Delete "$R2\audora.db-wal"
  Delete "$R2\settings.json"
  IfFileExists "$R0\audora.db" 0 audora_backup_settings
  ClearErrors
  CopyFiles /SILENT "$R0\audora.db" "$R2"
  IfErrors audora_backup_failed
  IfFileExists "$R0\audora.db-wal" 0 audora_backup_settings
  ClearErrors
  CopyFiles /SILENT "$R0\audora.db-wal" "$R2"
  IfErrors audora_backup_failed
audora_backup_settings:
  IfFileExists "$R0\settings.json" 0 audora_backup_finalize
  ClearErrors
  CopyFiles /SILENT "$R0\settings.json" "$R2"
  IfErrors audora_backup_failed
audora_backup_finalize:
  # Keep the last complete copy until the new copy is visible to the backend.
  IfFileExists "$R1\*.*" 0 audora_backup_promote
  Delete "$R1.previous\audora.db"
  Delete "$R1.previous\audora.db-wal"
  Delete "$R1.previous\audora.db-shm"
  Delete "$R1.previous\settings.json"
  RMDir "$R1.previous"
  ClearErrors
  Rename "$R1" "$R1.previous"
  IfErrors audora_backup_failed
audora_backup_promote:
  ClearErrors
  Rename "$R2" "$R1"
  IfErrors audora_backup_failed audora_backup_done
audora_backup_failed:
  MessageBox MB_OK|MB_ICONSTOP "Audora could not save your library before upgrading. The installer will close." /SD IDOK
  Abort
audora_backup_done:
  ${If} $installMode == "all"
    SetShellVarContext all
  ${EndIf}
FunctionEnd
!macroend
!endif
