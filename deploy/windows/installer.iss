; WhatsLive Inno Setup Installer Script
; Build with: iscc installer.iss  (requires Inno Setup 6+)
; Input:  dist\whatslive-windows-amd64.exe  (built by: make build-agent-windows)
; Output: dist\WhatsLiveSetup.exe

#define AppName        "WhatsLive"
#define AppVersion     "1.0.0"
#define AppPublisher   "WhatsLive"
#define AppURL         "https://whatslive.network"
#define AppExeName     "whatslive.exe"
#define ServiceName    "WhatsLive"
#define DataDir        "{commonappdata}\WhatsLive"

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
AppUpdatesURL={#AppURL}
DefaultDirName={autopf}\WhatsLive
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=..\..\dist
OutputBaseFilename=WhatsLiveSetup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog
; Refuse to run without Administrator. If the user launches without elevation,
; Windows will prompt for UAC. If UAC is unavailable, setup exits with an error.
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName}
MinVersion=10.0

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "..\..\dist\whatslive-windows-amd64.exe"; \
    DestDir: "{app}"; \
    DestName: "{#AppExeName}"; \
    Flags: ignoreversion

[Dirs]
Name: "{#DataDir}"; Permissions: everyone-full

[Tasks]
Name: "addFirewall"; \
    Description: "Add Windows Firewall rule for port 8080 (required for LAN access from other machines)"; \
    Flags: checked

[Code]
var
  SubnetPage: TInputQueryWizardPage;

procedure InitializeWizard;
begin
  SubnetPage := CreateInputQueryPage(
    wpWelcome,
    'Network Configuration',
    'Enter the subnet to monitor',
    'WhatsLive will scan this subnet to discover your network devices.'
  );
  SubnetPage.Add('Subnet (CIDR notation, e.g. 192.168.1.0/24):', False);
  SubnetPage.Values[0] := '192.168.1.0/24';
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  subnet: String;
begin
  Result := True;
  if CurPageID = SubnetPage.ID then begin
    subnet := SubnetPage.Values[0];
    if subnet = '' then begin
      MsgBox('Please enter a subnet to scan.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

function GetSubnet(Param: String): String;
begin
  Result := SubnetPage.Values[0];
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then begin
    // Stop the service if it's already running (upgrade scenario).
    Exec('sc.exe', 'stop ' + '{#ServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    // Delete existing service registration (upgrade scenario).
    Exec('sc.exe', 'delete ' + '{#ServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    // Register and start the service.
    Exec(ExpandConstant('{app}\{#AppExeName}'),
         'install-service --subnet "' + GetSubnet('') + '"',
         '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec('sc.exe', 'start ' + '{#ServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    // Add firewall rule if requested.
    if WizardIsTaskSelected('addFirewall') then begin
      Exec('netsh.exe',
           'advfirewall firewall add rule name="WhatsLive" ' +
           'dir=in action=allow protocol=TCP localport=8080',
           '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    end;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then begin
    Exec('sc.exe', 'stop ' + '{#ServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec('sc.exe', 'delete ' + '{#ServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec('netsh.exe',
         'advfirewall firewall delete rule name="WhatsLive"',
         '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;

[Run]
Filename: "{#AppURL}"; \
    Description: "Open WhatsLive in your browser"; \
    Flags: postinstall shellexec skipifsilent unchecked
