; Make Video Small — Windows installer.
;
; Built by scripts\package.ps1, which passes:
;   /DVERSION=3.0.0   the version shown in "Installed apps"
;   /DSRC=<folder>    the folder to install (the program and its engine folder)
;   /DOUT=<file>      where to write the installer
;
; Installs for the current person only, so it never asks for an administrator.

Unicode true
SetCompressor /SOLID lzma
RequestExecutionLevel user

!include "MUI2.nsh"

!define APP "Make Video Small"
!define EXE "make-video-small.exe"
!define REG "Software\Microsoft\Windows\CurrentVersion\Uninstall\MakeVideoSmall"

Name "${APP}"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\Programs\${APP}"
InstallDirRegKey HKCU "${REG}" "InstallLocation"
BrandingText "${APP} ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APP}"
VIAddVersionKey "FileDescription" "${APP} installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Sahiljeet Singh Kalsi (GhostofWeb)"

!define MUI_ICON "..\app\assets\logo.ico"
!define MUI_UNICON "..\app\assets\logo.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Open ${APP}"

!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "${SRC}\*.*"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  CreateShortcut "$SMPROGRAMS\${APP}.lnk" "$INSTDIR\${EXE}"
  CreateShortcut "$DESKTOP\${APP}.lnk" "$INSTDIR\${EXE}"

  WriteRegStr HKCU "${REG}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${REG}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${REG}" "Publisher" "Sahiljeet Singh Kalsi (GhostofWeb)"
  WriteRegStr HKCU "${REG}" "DisplayIcon" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "${REG}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${REG}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "${REG}" "NoModify" 1
  WriteRegDWORD HKCU "${REG}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\${APP}.lnk"
  Delete "$DESKTOP\${APP}.lnk"

  ; Only what the installer put there. The folder itself goes only if nothing
  ; else is left in it, so a folder someone chose by hand is never emptied.
  Delete "$INSTDIR\${EXE}"
  Delete "$INSTDIR\uninstall.exe"
  RMDir /r "$INSTDIR\engine"
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "${REG}"
  ; Settings, presets and the queue in %APPDATA% are kept on purpose.
SectionEnd
