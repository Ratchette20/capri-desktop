# Lit l'état physique d'une touche (même quand une autre fenêtre a le focus) pour la dictée de Capri.
# Une ligne "down" quand elle est enfoncée, "up" quand elle est relâchée. Rien d'autre n'est lu :
# ni le texte tapé, ni les autres touches.
#
#   powershell -File keys.ps1 -Vk <code de touche virtuelle> -ParentPid <pid de Capri>

param([int]$Vk = 0x78, [int]$ParentPid = 0)
$ErrorActionPreference = 'Stop'

Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);' -Name Keys -Namespace CapriKeys

$down = $false
$tick = 0
while ($true) {
  $now = ([CapriKeys.Keys]::GetAsyncKeyState($Vk) -band 0x8000) -ne 0
  if ($now -ne $down) {
    $down = $now
    [Console]::Out.WriteLine($(if ($down) { 'down' } else { 'up' }))
    [Console]::Out.Flush()
  }
  # s'arrête avec Capri, même si elle a planté sans le dire
  $tick++
  if ($ParentPid -and ($tick % 60 -eq 0) -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 25
}
