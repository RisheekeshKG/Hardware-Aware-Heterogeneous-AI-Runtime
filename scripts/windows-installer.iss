#define AppName "HAR Runtime"
#define AppPublisher "HAR Runtime"
#define AppExeName "har-runtime.exe"

[Setup]
AppId={{B9A7B7A2-19F7-4E37-8A0B-7A3C2C6A7F11}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\HAR Runtime
DefaultGroupName={#AppName}
OutputDir=..\web\src-tauri\target\release\bundle\nsis
OutputBaseFilename=HAR Runtime_{#AppVersion}_x64-setup
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\{#AppExeName}

[Files]
Source: "..\web\src-tauri\target\release\har-runtime.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\web\src-tauri\runtime\har-runtime-server\*"; DestDir: "{app}\runtime\har-runtime-server"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent
